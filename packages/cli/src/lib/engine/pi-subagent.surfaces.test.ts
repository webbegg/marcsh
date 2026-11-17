import { afterEach, describe, expect, test } from "bun:test";
import { createBackgroundHub, type BackgroundHub } from "../background/hub";
import { subagentsFor } from "../background/session-subagents";
import { type BackgroundRunChild, type ChildRun, createSubagentTools, createTaskTool, type RunChild } from "./pi-subagent";
import type { TurnSubagent } from "./types";

// T8: `Task` takes `editSurfaces`: validated, handed to the child as it will be enforced, never shared by writers that run together,
// and the files a writer changed outside them are in its result.

const FINISHED: ChildRun = { text: "done", toolUses: 0, totalTokens: 0, costUsd: 0 };
const DEVELOPER: TurnSubagent = { name: "developer", description: "Builds one task", readOnly: false };
const READER: TurnSubagent = { name: "reader", description: "Reads", readOnly: true };

const hubs: BackgroundHub[] = [];
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.dispose()));
});

const gate = () => {
  let open = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
};

function setup(options: { subagents?: TurnSubagent[]; runChild?: RunChild; background?: BackgroundRunChild } = {}) {
  const requests: Parameters<RunChild>[0][] = [];
  const hub = options.background ? createBackgroundHub({ debounceMs: 5, registerTurn: () => () => {} }) : undefined;
  if (hub) {
    hubs.push(hub);
    hub.setIdleSink(() => true);
  }
  const tools = createSubagentTools({
    host: { emit: () => {} },
    signal: new AbortController().signal,
    runChild: options.runChild ?? (async (request) => (requests.push(request), FINISHED)),
    ...(options.subagents ? { subagents: options.subagents } : {}),
    ...(hub && options.background ? { background: { hub, canStart: true, runChild: options.background } } : {}),
  });
  const task = tools.find((tool) => tool.name === "Task")!;
  let calls = 0;
  const run = (params: unknown) => task.execute(`call-${++calls}`, params as never, undefined, undefined, undefined as never);
  const textOf = (result: Awaited<ReturnType<typeof run>>) => result.content.map((block) => ("text" in block ? block.text : "")).join("");
  return { task, requests, run, textOf, hub };
}

const properties = (tool: ReturnType<typeof createTaskTool>) => (tool.parameters as unknown as { properties: Record<string, { type: string; items?: { type: string }; description?: string }> }).properties;

describe("the Task tool's editSurfaces parameter", () => {
  test("is an optional array of strings, with and without background and named subagents", () => {
    for (const options of [{}, { subagents: [DEVELOPER] }, { background: async () => FINISHED }]) {
      const { task } = setup(options);
      expect(properties(task).editSurfaces?.type).toBe("array");
      expect(properties(task).editSurfaces?.items).toEqual({ type: "string" });
      expect(properties(task).editSurfaces?.description).toContain("disjoint");
      expect((task.parameters as unknown as { required: string[] }).required).toEqual(["description", "prompt"]);
    }
  });
});

describe("a Task call with editSurfaces", () => {
  test("hands the child the surfaces normalized, and a way to read the other writers' surfaces", async () => {
    const { run, requests } = setup();
    await run({ description: "Edit auth", prompt: "go", editSurfaces: ["./src/auth/**", " tests/auth.test.ts ", "docs/"] });
    expect(requests[0]!.editSurfaces).toEqual(["src/auth/**", "tests/auth.test.ts", "docs"]);
    expect(requests[0]!.otherSurfaces?.()).toEqual([]);
  });

  test("without editSurfaces the request is exactly as before: no surface fields", async () => {
    const { run, requests } = setup();
    await run({ description: "Look around", prompt: "go" });
    expect(Object.keys(requests[0]!).sort()).toEqual(["holdClock", "onProgress", "prompt", "signal"]);
    await run({ description: "Look around", prompt: "go", editSurfaces: null });
    expect(requests[1]!.editSurfaces).toBeUndefined();
  });

  test.each([
    [["."], '"." covers the whole repository'],
    [["src", "."], '"." covers the whole repository'],
    [["/abs/path"], '"/abs/path" must be repository-relative'],
    [["../up"], '"../up" must not escape the repository'],
    [["src/../../up"], '"src/../../up" must not escape the repository'],
    [[""], "empty surface entry"],
    [[], "must list at least one"],
    [["**"], '"**" covers the whole repository'],
  ])("%j is a tool error naming the entry, and starts no child", async (editSurfaces, message) => {
    const { run, requests } = setup();
    await expect(run({ description: "Edit", prompt: "go", editSurfaces })).rejects.toThrow(message);
    expect(requests).toEqual([]);
  });

  test("a value that is not a list is invalid input", async () => {
    const { run, requests } = setup();
    await expect(run({ description: "Edit", prompt: "go", editSurfaces: { path: "src" } })).rejects.toThrow(/`editSurfaces`, when given, is a list/);
    await expect(run({ description: "Edit", prompt: "go", editSurfaces: ["src", 3] })).rejects.toThrow("3 is not a string");
    expect(requests).toEqual([]);
  });

  test("a read-only subagent takes none", async () => {
    const { run, requests } = setup({ subagents: [DEVELOPER, READER] });
    await expect(run({ description: "Read", prompt: "go", agent: "reader", editSurfaces: ["src"] })).rejects.toThrow("reader is read-only: do not pass editSurfaces");
    await run({ description: "Build", prompt: "go", agent: "developer", editSurfaces: ["src"] });
    expect(requests.map((request) => request.subagent?.name)).toEqual(["developer"]);
  });

  test("the files the writer changed outside its surfaces are listed in the result, and nothing else is added when there are none", async () => {
    const outside = setup({ runChild: async () => ({ ...FINISHED, outsideSurfaces: ["README.md", "src/b.ts"] }) });
    const result = await outside.run({ description: "Edit", prompt: "go", editSurfaces: ["src/a.ts"] });
    expect(outside.textOf(result)).toBe(
      "done\n\nWarning: files changed outside the allowed edit surfaces (src/a.ts): README.md, src/b.ts. Nothing was reverted: review them (git diff) and keep or undo them.",
    );

    for (const outsideSurfaces of [[], undefined]) {
      const quiet = setup({ runChild: async () => ({ ...FINISHED, ...(outsideSurfaces ? { outsideSurfaces } : {}) }) });
      expect(quiet.textOf(await quiet.run({ description: "Edit", prompt: "go", editSurfaces: ["src/a.ts"] }))).toBe("done");
    }
  });

  test("a long list is cut", async () => {
    const many = Array.from({ length: 60 }, (_, i) => `f${i}.ts`);
    const { run, textOf } = setup({ runChild: async () => ({ ...FINISHED, outsideSurfaces: many }) });
    const text = textOf(await run({ description: "Edit", prompt: "go", editSurfaces: ["src/a.ts"] }));
    expect(text).toContain("f49.ts, and 10 more");
    expect(text).not.toContain("f50.ts");
  });

  test("a child that fails is a failed Task, and its surfaces are free again", async () => {
    let first = true;
    const { run } = setup({
      runChild: async () => {
        if (first) {
          first = false;
          throw new Error("child failed");
        }
        return FINISHED;
      },
    });
    await expect(run({ description: "Edit", prompt: "go", editSurfaces: ["src/a.ts"] })).rejects.toThrow("child failed");
    await run({ description: "Edit again", prompt: "go", editSurfaces: ["src/a.ts"] });
  });
});

describe("writers that run at the same time", () => {
  test("foreground writers in parallel need disjoint surfaces: the overlapping one is rejected, naming both entries; a disjoint one runs", async () => {
    const hold = gate();
    const started: string[] = [];
    const { run, requests } = setup({
      runChild: async (request) => {
        started.push(request.prompt);
        await hold.opened;
        return FINISHED;
      },
    });
    const first = run({ description: "First", prompt: "one", editSurfaces: ["src/**"] });
    await expect(run({ description: "Second", prompt: "two", editSurfaces: ["src/a.ts"] })).rejects.toThrow(/"src\/a\.ts" overlaps "src\/\*\*" \(the surfaces of the writer "First", which is still running\)/);
    const third = run({ description: "Third", prompt: "three", editSurfaces: ["docs/**"] });
    hold.open();
    await Promise.all([first, third]);
    expect(started).toEqual(["one", "three"]);
    expect(requests).toEqual([]);
    // Finished: the surfaces are free.
    await run({ description: "Again", prompt: "four", editSurfaces: ["src/a.ts"] });
    expect(started).toEqual(["one", "three", "four"]);
  });

  test("each writer is told the other's surfaces while it runs, and not its own", async () => {
    const hold = gate();
    const seen: Array<() => string[]> = [];
    const { run } = setup({
      runChild: async (request) => {
        seen.push(request.otherSurfaces!);
        await hold.opened;
        return FINISHED;
      },
    });
    const first = run({ description: "First", prompt: "one", editSurfaces: ["src/a.ts"] });
    const second = run({ description: "Second", prompt: "two", editSurfaces: ["docs/**", "tests"] });
    await Promise.resolve();
    expect(seen[0]!()).toEqual(["docs/**", "tests"]);
    expect(seen[1]!()).toEqual(["src/a.ts"]);
    hold.open();
    await Promise.all([first, second]);
    expect(seen[0]!()).toEqual([]);
  });

  test("a Task without surfaces is not held back by a running writer, and does not hold one back", async () => {
    const hold = gate();
    const { run } = setup({ runChild: async () => (await hold.opened, FINISHED) });
    const writer = run({ description: "Writer", prompt: "one", editSurfaces: ["src/**"] });
    const plain = run({ description: "Plain", prompt: "two" });
    hold.open();
    await Promise.all([writer, plain]);
  });

  test("background writers: the second launch with overlapping surfaces is rejected, and it starts nothing", async () => {
    const hold = gate();
    const started: string[] = [];
    const { run, hub, textOf } = setup({
      background: async (request) => {
        started.push(request.description);
        await hold.opened;
        return FINISHED;
      },
    });
    const first = await run({ description: "First", prompt: "go", editSurfaces: ["src/auth/**"], background: true });
    expect(textOf(first)).toContain("Started background subagent sa-1");
    await expect(run({ description: "Second", prompt: "go", editSurfaces: ["src/auth/login.ts"], background: true })).rejects.toThrow(
      /Task not started: its editSurfaces overlap another writer's: "src\/auth\/login\.ts" overlaps "src\/auth\/\*\*"/,
    );
    expect(subagentsFor(hub!).list().map((snapshot) => snapshot.id)).toEqual(["sa-1"]);
    // A disjoint writer, and one without surfaces, start.
    expect(textOf(await run({ description: "Third", prompt: "go", editSurfaces: ["src/billing/**"], background: true }))).toContain("sa-2");
    expect(textOf(await run({ description: "Plain", prompt: "go", background: true }))).toContain("sa-3");
    hold.open();
    await Promise.all(["sa-1", "sa-2", "sa-3"].map((id) => subagentsFor(hub!).settled(id)));
    expect(started).toEqual(["First", "Third", "Plain"]);
  });

  test("a background writer's surfaces are free once it has settled, whether it finished, failed or was cancelled", async () => {
    const outcomes = ["finish", "fail", "wait"] as const;
    let next = 0;
    const hold = gate();
    const { run, hub } = setup({
      background: async (request) => {
        const outcome = outcomes[next++];
        if (outcome === "fail") throw new Error("boom");
        if (outcome === "wait") {
          await Promise.race([hold.opened, new Promise((resolve) => request.signal.addEventListener("abort", resolve))]);
          throw new Error("aborted");
        }
        return FINISHED;
      },
    });
    const subagents = subagentsFor(hub!);
    await run({ description: "One", prompt: "go", editSurfaces: ["src/a.ts"], background: true });
    await subagents.settled("sa-1");
    await run({ description: "Two", prompt: "go", editSurfaces: ["src/a.ts"], background: true });
    await subagents.settled("sa-2");
    expect(subagents.get("sa-2")!.status).toBe("failed");
    await run({ description: "Three", prompt: "go", editSurfaces: ["src/a.ts"], background: true });
    await expect(run({ description: "Four", prompt: "go", editSurfaces: ["src/a.ts"], background: true })).rejects.toThrow("Task not started");
    await subagents.cancel(["sa-3"]);
    // The fifth takes the fourth's id: the rejected one started nothing.
    await run({ description: "Five", prompt: "go", editSurfaces: ["src/a.ts"], background: true });
    expect(subagents.list().map((snapshot) => snapshot.description)).toEqual(["One", "Two", "Three", "Five"]);
    hold.open();
    await subagents.settled("sa-4");
  });

  test("a foreground writer cannot share surfaces with a running background one, and the reverse", async () => {
    const hold = gate();
    const { run, hub } = setup({
      runChild: async () => (await hold.opened, FINISHED),
      background: async () => (await hold.opened, FINISHED),
    });
    await run({ description: "Background", prompt: "go", editSurfaces: ["src/**"], background: true });
    await expect(run({ description: "Foreground", prompt: "go", editSurfaces: ["src/a.ts"] })).rejects.toThrow(/overlaps "src\/\*\*" \(the surfaces of the writer "Background"/);

    const foreground = run({ description: "Foreground", prompt: "go", editSurfaces: ["docs/**"] });
    await expect(run({ description: "Another", prompt: "go", editSurfaces: ["docs/x.md"], background: true })).rejects.toThrow(/the writer "Foreground"/);
    hold.open();
    await foreground;
    await subagentsFor(hub!).settled("sa-1");
  });

  test("the background writer's result has the files it changed outside its surfaces", async () => {
    const { run, hub } = setup({ background: async () => ({ ...FINISHED, outsideSurfaces: ["README.md"] }) });
    await run({ description: "Edit", prompt: "go", editSurfaces: ["src/a.ts"], background: true });
    await subagentsFor(hub!).settled("sa-1");
    const text = subagentsFor(hub!).get("sa-1")!.text;
    expect(text).toContain("done");
    expect(text).toContain("Warning: files changed outside the allowed edit surfaces (src/a.ts) (may include edits made meanwhile by you or another subagent): README.md.");
  });

  test("the background child is handed its surfaces and the others'", async () => {
    const hold = gate();
    const seen: Array<Parameters<BackgroundRunChild>[0]> = [];
    const { run, hub } = setup({
      background: async (request) => {
        seen.push(request);
        await hold.opened;
        return FINISHED;
      },
    });
    await run({ description: "One", prompt: "go", editSurfaces: ["src/a.ts"], background: true });
    await run({ description: "Two", prompt: "go", editSurfaces: ["docs"], background: true });
    expect(seen[0]!.editSurfaces).toEqual(["src/a.ts"]);
    expect(seen[0]!.otherSurfaces?.()).toEqual(["docs"]);
    expect(seen[1]!.otherSurfaces?.()).toEqual(["src/a.ts"]);
    hold.open();
    await Promise.all(["sa-1", "sa-2"].map((id) => subagentsFor(hub!).settled(id)));
  });
});
