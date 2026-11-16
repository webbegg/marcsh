import { afterEach, describe, expect, test } from "bun:test";
import { createBackgroundHub, type BackgroundHub } from "../background/hub";
import { subagentsFor } from "../background/session-subagents";
import { type BackgroundRunChild, type ChildRun, createSubagentTools, createTaskTool, type RunChild } from "./pi-subagent";
import type { TurnSubagent } from "./types";

// M1: pi's `Task` takes an optional `agent`, one of the named subagents available to the turn.

const FINISHED: ChildRun = { text: "done", toolUses: 0, totalTokens: 0, costUsd: 0 };

const REFUTER: TurnSubagent = { name: "refuter-security", description: "Tries to break security claims", prompt: "You refute.", readOnly: true };
const DEVELOPER: TurnSubagent = { name: "developer", description: "Implements one task", prompt: "You build.", readOnly: false, deniedTools: ["web"] };

function setup(subagents?: TurnSubagent[]) {
  const requests: Parameters<RunChild>[0][] = [];
  const tool = createTaskTool({
    host: { emit: () => {} },
    signal: new AbortController().signal,
    runChild: async (request) => (requests.push(request), FINISHED),
    ...(subagents ? { subagents } : {}),
  });
  const run = (params: unknown) => tool.execute("call-1", params as never, undefined, undefined, undefined as never);
  return { tool, requests, run };
}

const properties = (tool: ReturnType<typeof createTaskTool>) => (tool.parameters as unknown as { properties: Record<string, { type: string }> }).properties;

describe("the Task tool with named subagents", () => {
  test("without subagents it is exactly as before: no `agent` parameter, the same description", () => {
    const plain = setup().tool;
    const empty = setup([]).tool;
    expect(Object.keys(properties(plain))).toEqual(["description", "prompt"]);
    expect(empty.description).toBe(plain.description);
    expect(empty.parameters).toEqual(plain.parameters);
  });

  test("with subagents it takes an optional string `agent`, and its description lists their names and descriptions", () => {
    const { tool } = setup([DEVELOPER, REFUTER]);
    expect(properties(tool).agent?.type).toBe("string");
    expect((tool.parameters as unknown as { required: string[] }).required).toEqual(["description", "prompt"]);
    expect(tool.description).toContain("- developer: Implements one task");
    expect(tool.description).toContain("- refuter-security: Tries to break security claims");
  });

  test("the list is bounded: at most 20 names, each description cut to about 150 characters", () => {
    const many = Array.from({ length: 25 }, (_, i): TurnSubagent => ({ name: `sub-${String(i).padStart(2, "0")}`, description: "d".repeat(400), readOnly: false }));
    const { tool } = setup(many);
    expect(tool.description).toContain("- sub-19:");
    expect(tool.description).not.toContain("- sub-20:");
    expect(tool.description).toContain("and 5 more");
    const line = tool.description.split("\n").find((text) => text.startsWith("- sub-00:"))!;
    expect(line.length).toBeLessThanOrEqual(170);
    expect(line.endsWith("…")).toBe(true);
  });

  test("the `agent` parameter's description is bounded the same way, and an unknown name still lists every valid one (A1)", async () => {
    const many = Array.from({ length: 25 }, (_, i): TurnSubagent => ({ name: `sub-${String(i).padStart(2, "0")}`, readOnly: false }));
    const { tool, run } = setup(many);
    const about = (properties(tool).agent as unknown as { description: string }).description;
    expect(about).toContain("sub-19");
    expect(about).not.toContain("sub-20");
    expect(about).toContain("…and 5 more");
    await expect(run({ description: "d", prompt: "go", agent: "nope" })).rejects.toThrow(`Available: ${many.map((sub) => sub.name).join(", ")}.`);
  });

  test("a call with `agent` runs the child as that subagent", async () => {
    const { run, requests } = setup([DEVELOPER, REFUTER]);
    await run({ description: "Refute it", prompt: "go", agent: "refuter-security" });
    expect(requests[0]!.subagent).toEqual(REFUTER);
  });

  test("a call without `agent` runs a plain child", async () => {
    const { run, requests } = setup([DEVELOPER]);
    await run({ description: "Look around", prompt: "go" });
    expect(requests[0]!.subagent).toBeUndefined();
  });

  test("an unknown name is a tool error that lists the valid ones, and starts no child", async () => {
    const { run, requests } = setup([DEVELOPER, REFUTER]);
    await expect(run({ description: "Refute it", prompt: "go", agent: "nope" })).rejects.toThrow('Unknown subagent "nope". Available: developer, refuter-security.');
    expect(requests).toEqual([]);
  });

  test("`agent` when no subagent is available is a tool error", async () => {
    const { run, requests } = setup();
    await expect(run({ description: "Refute it", prompt: "go", agent: "developer" })).rejects.toThrow(/No named subagents are available/);
    expect(requests).toEqual([]);
  });

  test("an `agent` that is not a string is invalid input", async () => {
    const { run } = setup([DEVELOPER]);
    await expect(run({ description: "Refute it", prompt: "go", agent: 3 })).rejects.toThrow(/Invalid Task input/);
  });
});

const hubs: BackgroundHub[] = [];
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.dispose()));
});

describe("a background Task with a named subagent", () => {
  test("the background child runs as that subagent", async () => {
    const hub = createBackgroundHub({ debounceMs: 5, registerTurn: () => () => {} });
    hubs.push(hub);
    hub.setIdleSink(() => true);
    const background: Parameters<BackgroundRunChild>[0][] = [];
    const tools = createSubagentTools({
      host: { emit: () => {} },
      signal: new AbortController().signal,
      runChild: async () => FINISHED,
      subagents: [DEVELOPER, REFUTER],
      background: { hub, canStart: true, runChild: async (request) => (background.push(request), FINISHED) },
    });
    const task = tools.find((tool) => tool.name === "Task")!;
    await task.execute("call-1", { description: "Refute it", prompt: "go", agent: "refuter-security", background: true } as never, undefined, undefined, undefined as never);
    await subagentsFor(hub).settled("sa-1");
    expect(background[0]!.subagent).toEqual(REFUTER);
    expect(background[0]!.prompt).toBe("go");
  });
});
