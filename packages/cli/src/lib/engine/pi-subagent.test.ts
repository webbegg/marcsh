import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../chat-types";
import {
  type ChildRun,
  createSubagentExtension,
  createTaskTool,
  isMarcshTask,
  type RunChild,
  TASK_TOOL,
  upsertTask,
} from "./pi-subagent";
import type { EngineEvent } from "./types";

const emptyReply = (): ChatMessage => ({ id: "reply", role: "assistant", parts: [] });
const tasks = (reply: ChatMessage) => reply.parts.flatMap((part) => (part.type === "task" ? [part] : []));

const FINISHED: ChildRun = { text: "The answer is 42.", toolUses: 2, totalTokens: 900, costUsd: 0 };

function setup(runChild: RunChild = async () => FINISHED) {
  const events: EngineEvent[] = [];
  const turnEnded = new AbortController();
  const requests: Parameters<RunChild>[0][] = [];
  const tool = createTaskTool({
    host: { emit: (event) => events.push(event) },
    signal: turnEnded.signal,
    runChild: (request) => {
      requests.push(request);
      return runChild(request);
    },
  });
  const run = (params: unknown, id = "call-1", signal?: AbortSignal) => tool.execute(id, params as never, signal, undefined, undefined as never);
  const reply = () => {
    let current = emptyReply();
    for (const event of events) if (event.type === "reply") current = event.update(current);
    return current;
  };
  return { tool, events, turnEnded, requests, run, reply };
}

const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map((block) => block.text ?? "").join("");

describe("isMarcshTask", () => {
  test("is the tool named Task that marcsh's own inline extension registered", () => {
    expect(TASK_TOOL).toBe("Task");
    expect(isMarcshTask({ name: "Task", sourceInfo: { path: "<inline:marcsh-subagent>" } })).toBe(true);
  });

  test("an extension's tool of the same name, or another marcsh tool, is not it", () => {
    expect(isMarcshTask({ name: "Task", sourceInfo: { path: "/home/u/.marcsh/agent/extensions/task.ts" } })).toBe(false);
    expect(isMarcshTask({ name: "Task", sourceInfo: { path: "<inline:other>" } })).toBe(false);
    expect(isMarcshTask({ name: "Task", sourceInfo: { path: "builtin:Task" } })).toBe(false);
    expect(isMarcshTask({ name: "bash", sourceInfo: { path: "<inline:marcsh-subagent>" } })).toBe(false);
  });
});

describe("upsertTask", () => {
  test("creates a running task part and merges later changes into it", () => {
    const created = upsertTask(emptyReply(), "k1", { description: "Explore the repo" });
    expect(tasks(created)).toEqual([{ type: "task", taskId: "k1", description: "Explore the repo", status: "running" }]);

    const progressed = upsertTask(created, "k1", { lastToolName: "grep", toolUses: 2, totalTokens: 300 });
    expect(tasks(progressed)).toEqual([
      { type: "task", taskId: "k1", description: "Explore the repo", status: "running", lastToolName: "grep", toolUses: 2, totalTokens: 300 },
    ]);
  });

  test("returns the same reply when nothing changes, and ignores undefined changes", () => {
    const created = upsertTask(emptyReply(), "k1", { description: "Explore" });

    expect(upsertTask(created, "k1", { description: "Explore", lastToolName: undefined })).toBe(created);
  });

  test("keeps tasks apart by id", () => {
    let reply = upsertTask(emptyReply(), "a", { description: "A" });
    reply = upsertTask(reply, "b", { description: "B" });
    reply = upsertTask(reply, "a", { status: "completed" });

    expect(tasks(reply).map((task) => [task.taskId, task.status])).toEqual([["a", "completed"], ["b", "running"]]);
  });
});

describe("the Task tool definition", () => {
  test("takes a description (3-5 words) and a prompt, both strings", () => {
    const { tool } = setup();
    const schema = tool.parameters as any;

    expect(tool.name).toBe("Task");
    expect(schema.required).toEqual(["description", "prompt"]);
    expect(schema.properties.description.type).toBe("string");
    expect(schema.properties.description.description).toContain("3-5 words");
    expect(schema.properties.prompt.type).toBe("string");
  });

  test("is registered by a hidden inline extension named marcsh-subagent", () => {
    const registered: string[] = [];
    const extension = createSubagentExtension({ host: { emit: () => {} }, signal: new AbortController().signal, runChild: async () => FINISHED });

    expect(typeof extension).toBe("object");
    if (typeof extension === "function") throw new Error("expected a named inline extension");
    expect(extension.name).toBe("marcsh-subagent");
    expect(extension.hidden).toBe(true);
    extension.factory({ registerTool: (tool: { name: string }) => registered.push(tool.name) } as never);
    expect(registered).toEqual(["Task"]);
  });
});

describe("running a task", () => {
  test("starts a running task line with the description, then completes it with the summary and usage", async () => {
    const { run, reply, requests } = setup();

    const result = await run({ description: "Find the answer", prompt: "What is the answer?" });

    expect(requests.map((request) => request.prompt)).toEqual(["What is the answer?"]);
    expect(textOf(result)).toBe("The answer is 42.");
    expect(tasks(reply())).toEqual([
      { type: "task", taskId: "call-1", description: "Find the answer", status: "completed", summary: "The answer is 42.", toolUses: 2, totalTokens: 900 },
    ]);
  });

  test("the first update (before the child answers) is a running line", async () => {
    let seenWhileRunning: ChatMessage | undefined;
    const ctx = setup(async () => {
      seenWhileRunning = ctx.reply();
      return FINISHED;
    });

    await ctx.run({ description: "Find the answer", prompt: "go" });

    expect(tasks(seenWhileRunning!)).toEqual([{ type: "task", taskId: "call-1", description: "Find the answer", status: "running" }]);
  });

  test("progress from the child updates the last tool, tool count and tokens", async () => {
    let afterProgress: ChatMessage | undefined;
    const ctx = setup(async ({ onProgress }) => {
      onProgress({ lastToolName: "grep", toolUses: 1, totalTokens: 120 });
      onProgress({ lastToolName: "read", toolUses: 2, totalTokens: 400 });
      afterProgress = ctx.reply();
      return FINISHED;
    });

    await ctx.run({ description: "Search", prompt: "go" });

    expect(tasks(afterProgress!)).toEqual([
      { type: "task", taskId: "call-1", description: "Search", status: "running", lastToolName: "read", toolUses: 2, totalTokens: 400 },
    ]);
  });

  test("the summary is the child's text on one line, cut when long; the model still gets all of it", async () => {
    const long = `first line\n\n${"word ".repeat(200)}`;
    const { run, reply } = setup(async () => ({ ...FINISHED, text: long }));

    const result = await run({ description: "Long", prompt: "go" });

    expect(textOf(result)).toBe(long);
    const summary = tasks(reply())[0]!.summary!;
    expect(summary.startsWith("first line word word")).toBe(true);
    expect(summary).not.toContain("\n");
    expect(summary.length).toBeLessThanOrEqual(300);
    expect(summary.endsWith("…")).toBe(true);
  });

  test("a child that answers nothing still returns a tool result that says so", async () => {
    const { run } = setup(async () => ({ ...FINISHED, text: "" }));

    const result = await run({ description: "Silent", prompt: "go" });

    expect(textOf(result)).toContain("without returning any text");
  });

  test("the child's cost is added to the reply's cost", async () => {
    const { run, reply } = setup(async () => ({ ...FINISHED, costUsd: 0.25 }));

    await run({ description: "Costly", prompt: "go" });

    expect(reply().metadata?.costUsd).toBe(0.25);
  });

  test("a child that costs nothing leaves the cost alone", async () => {
    const { run, reply } = setup();

    await run({ description: "Free", prompt: "go" });

    expect(reply().metadata?.costUsd).toBeUndefined();
  });

  test("a child error is a tool error and marks the task failed with that error", async () => {
    const { run, reply } = setup(async () => {
      throw new Error("The model is overloaded");
    });

    await expect(run({ description: "Doomed", prompt: "go" })).rejects.toThrow("The model is overloaded");

    expect(tasks(reply())).toEqual([{ type: "task", taskId: "call-1", description: "Doomed", status: "failed", error: "The model is overloaded" }]);
  });

  test("invalid input is a tool error that starts no child and no task line", async () => {
    const { run, requests, events } = setup();

    for (const bad of [{}, { description: "x" }, { prompt: "x" }, { description: 1, prompt: "x" }, { description: "x", prompt: "  " }, { description: " ", prompt: "x" }]) {
      await expect(run(bad)).rejects.toThrow("Invalid Task input");
    }
    expect(requests).toEqual([]);
    expect(events).toEqual([]);
  });

  test("parallel calls each get their own task line and their own child", async () => {
    const { run, reply, requests } = setup(async ({ prompt }) => ({ ...FINISHED, text: `done: ${prompt}` }));

    const results = await Promise.all([
      run({ description: "First", prompt: "one" }, "call-a"),
      run({ description: "Second", prompt: "two" }, "call-b"),
    ]);

    expect(results.map(textOf)).toEqual(["done: one", "done: two"]);
    expect(requests).toHaveLength(2);
    expect(tasks(reply()).map((task) => [task.taskId, task.description, task.status])).toEqual([
      ["call-a", "First", "completed"],
      ["call-b", "Second", "completed"],
    ]);
  });
});

describe("interrupting a task", () => {
  const hanging: RunChild = ({ signal }) =>
    new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));

  test("the child's signal aborts when the turn ends, and the task is marked stopped", async () => {
    const { run, reply, turnEnded, requests } = setup(hanging);

    const running = run({ description: "Slow", prompt: "go" });
    await Promise.resolve();
    expect(requests[0]!.signal.aborted).toBe(false);
    turnEnded.abort();

    await expect(running).rejects.toThrow("interrupted");
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(tasks(reply())[0]).toMatchObject({ taskId: "call-1", status: "stopped" });
  });

  test("the child's signal aborts when pi aborts the tool call", async () => {
    const { run, reply, requests } = setup(hanging);
    const toolCall = new AbortController();

    const running = run({ description: "Slow", prompt: "go" }, "call-1", toolCall.signal);
    await Promise.resolve();
    toolCall.abort();

    await expect(running).rejects.toThrow("interrupted");
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(tasks(reply())[0]?.status).toBe("stopped");
  });

  test("a child that finishes after the abort still ends the task as stopped, never completed", async () => {
    const ctx = setup(async () => {
      ctx.turnEnded.abort();
      return FINISHED;
    });

    await expect(ctx.run({ description: "Late", prompt: "go" })).rejects.toThrow("interrupted");

    expect(tasks(ctx.reply())[0]?.status).toBe("stopped");
  });

  test("a turn that is already over starts no child", async () => {
    const { run, requests, turnEnded } = setup();
    turnEnded.abort();

    await expect(run({ description: "Never", prompt: "go" })).rejects.toThrow("interrupted");

    expect(requests).toEqual([]);
  });
});
