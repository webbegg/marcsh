import { afterEach, describe, expect, test } from "bun:test";
import type { ChatMessage } from "../chat-types";
import { createBackgroundHub, type BackgroundBatch, type BackgroundHub } from "../background/hub";
import { subagentsFor } from "../background/session-subagents";
import { buildSubagentResult } from "../background/subagents";
import {
  type BackgroundRunChild,
  type ChildRun,
  createSubagentExtension,
  createSubagentTools,
  createTaskTool,
  isMarcshTask,
  isMarcshTaskTool,
  type RunChild,
  TASK_PLAN_TOOLS,
  TASK_TOOL,
  TASK_TOOLS,
  upsertTask,
} from "./pi-subagent";
import { ToolCallTimeoutError, toolTimeoutMessage } from "./pi-tool-timeout";
import type { EngineEvent } from "./types";

const emptyReply = (): ChatMessage => ({ id: "reply", role: "assistant", parts: [] });
const tasks = (reply: ChatMessage) => reply.parts.flatMap((part) => (part.type === "task" ? [part] : []));

const FINISHED: ChildRun = { text: "The answer is 42.", toolUses: 2, totalTokens: 900, costUsd: 0 };

function setup(runChild: RunChild = async () => FINISHED, timeoutMs?: number) {
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
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
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

describe("a task that runs too long", () => {
  const hanging: RunChild = ({ signal }) =>
    new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));

  test("is aborted after the timeout, fails with the timeout message and marks the task failed, not stopped", async () => {
    const { run, reply, requests } = setup(hanging, 50);

    const error = await run({ description: "Slow", prompt: "go" }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ToolCallTimeoutError);
    expect((error as Error).message).toBe(toolTimeoutMessage("Task", 50));
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(tasks(reply())).toEqual([{ type: "task", taskId: "call-1", description: "Slow", status: "failed", error: toolTimeoutMessage("Task", 50) }]);
  });

  test("an interrupt before the timeout is still an interrupt", async () => {
    const { run, reply, turnEnded } = setup(hanging, 5_000);

    const running = run({ description: "Slow", prompt: "go" });
    await Promise.resolve();
    turnEnded.abort();

    await expect(running).rejects.toThrow("interrupted");
    expect(tasks(reply())[0]?.status).toBe("stopped");
  });

  test("a child that finishes in time completes as usual", async () => {
    const { run, reply } = setup(async () => FINISHED, 5_000);

    const result = await run({ description: "Quick", prompt: "go" });

    expect(textOf(result)).toBe("The answer is 42.");
    expect(tasks(reply())[0]?.status).toBe("completed");
  });

  test("a background call is not timed: it returns at once and its child keeps running past the timeout", async () => {
    const { call, background, subagents } = setupBackground({
      timeoutMs: 20,
      runChild: async ({ signal }) => {
        await Bun.sleep(120);
        expect(signal.aborted).toBe(false);
        return FINISHED;
      },
    });

    const started = Date.now();
    const result = await call("Task", { description: "Long", prompt: "go", background: true });
    expect(Date.now() - started).toBeLessThan(20);
    expect(textOf(result)).toContain("sa-1");
    await subagents.settled("sa-1");
    expect(background[0]!.signal.aborted).toBe(false);
    expect(subagents.get("sa-1")!.status).toBe("completed");
  });

  test("without background subagents (headless, a child, plan mode), background: true is a tool error, never an untimed foreground run", async () => {
    const { run, requests } = setup(async () => FINISHED, 20);
    await expect(run({ description: "Long", prompt: "go", background: true })).rejects.toThrow("Background subagents are not available");
    expect(requests).toEqual([]);

    const plan = setupBackground({ canStart: false });
    await expect(plan.call("Task", { description: "Long", prompt: "go", background: true })).rejects.toThrow("Background subagents are not available");
    expect(plan.background).toEqual([]);
  });
});

// S4: background subagents through the Task tool and the task_* tools, with a stubbed child.

const hubs: BackgroundHub[] = [];
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.dispose()));
});

const hangingChild: BackgroundRunChild = ({ signal }) =>
  new Promise((_resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });

function setupBackground({
  runChild = async () => FINISHED,
  canStart = true,
  maxWaitMs,
  timeoutMs,
}: { runChild?: BackgroundRunChild; canStart?: boolean; maxWaitMs?: number; timeoutMs?: number } = {}) {
  const hub = createBackgroundHub({ debounceMs: 5, registerTurn: () => () => {} });
  hubs.push(hub);
  const idle: BackgroundBatch[] = [];
  hub.setIdleSink((batch) => (idle.push(batch), true));
  const turnEnded = new AbortController();
  const background: Parameters<BackgroundRunChild>[0][] = [];
  const foreground: Parameters<RunChild>[0][] = [];
  const tools = createSubagentTools({
    host: { emit: () => {} },
    signal: turnEnded.signal,
    runChild: async (request) => (foreground.push(request), FINISHED),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    background: {
      hub,
      canStart,
      ...(maxWaitMs === undefined ? {} : { maxWaitMs }),
      runChild: (request) => {
        background.push(request);
        return runChild(request);
      },
    },
  });
  const call = (name: string, params: unknown, signal?: AbortSignal) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.execute("call-1", params as never, signal, undefined, undefined as never);
  };
  return { hub, idle, turnEnded, tools, call, background, foreground, subagents: subagentsFor(hub) };
}

describe("marcsh's task_* tools", () => {
  test("are task_wait, task_check, task_cancel and task_list from marcsh's own extension; plan mode keeps only the reading ones", () => {
    expect([...TASK_TOOLS]).toEqual(["task_wait", "task_check", "task_cancel", "task_list"]);
    expect([...TASK_PLAN_TOOLS]).toEqual(["task_wait", "task_check", "task_list"]);
    for (const name of TASK_TOOLS) {
      expect(isMarcshTaskTool({ name, sourceInfo: { path: "<inline:marcsh-subagent>" } }), name).toBe(true);
      expect(isMarcshTaskTool({ name, sourceInfo: { path: "/agent/extensions/task.ts" } }), name).toBe(false);
    }
    expect(isMarcshTaskTool({ name: "Task", sourceInfo: { path: "<inline:marcsh-subagent>" } })).toBe(false);
  });

  test("are registered, and Task takes background, only with background subagents; background is not offered when they cannot start", () => {
    const registered = (options: Parameters<typeof createSubagentExtension>[0]) => {
      const names: string[] = [];
      const extension = createSubagentExtension(options);
      if (typeof extension === "function") throw new Error("expected a named inline extension");
      extension.factory({ registerTool: (tool: { name: string }) => names.push(tool.name) } as never);
      return names;
    };
    const base = { host: { emit: () => {} }, signal: new AbortController().signal, runChild: async () => FINISHED };
    const hub = createBackgroundHub({ registerTurn: () => () => {} });
    hubs.push(hub);
    expect(registered(base)).toEqual(["Task"]);
    expect(registered({ ...base, background: { hub, canStart: true, runChild: hangingChild } })).toEqual(["Task", ...TASK_TOOLS]);

    const schemaOf = (canStart?: boolean) =>
      (createTaskTool({ ...base, ...(canStart === undefined ? {} : { background: { hub, canStart, runChild: hangingChild } }) }).parameters as any).properties;
    expect(schemaOf(true).background.type).toBe("boolean");
    expect(schemaOf(false).background).toBeUndefined();
    expect(schemaOf().background).toBeUndefined();
  });
});

describe("a background Task (S4)", () => {
  test("returns its id at once while the child runs on, and the turn ending does not stop it", async () => {
    let finish!: (run: ChildRun) => void;
    const { call, background, subagents, turnEnded, foreground } = setupBackground({ runChild: () => new Promise((resolve) => (finish = resolve)) });

    const result = await call("Task", { description: "Explore the repo", prompt: "Map the modules", background: true });

    expect(textOf(result)).toContain('Started background subagent sa-1 "Explore the repo"');
    expect(textOf(result)).toContain("task_wait");
    expect((result.details as { id: string }).id).toBe("sa-1");
    expect(background.map((request) => [request.description, request.prompt])).toEqual([["Explore the repo", "Map the modules"]]);
    expect(foreground).toEqual([]);
    expect(subagents.get("sa-1")!.status).toBe("running");

    turnEnded.abort();
    expect(background[0]!.signal.aborted).toBe(false);
    finish(FINISHED);
    await subagents.settled("sa-1");
    expect(subagents.get("sa-1")!.status).toBe("completed");
  });

  test("over the cap of 4 is a tool error that names the cap", async () => {
    const { call, background } = setupBackground({ runChild: hangingChild });
    for (let at = 0; at < 4; at++) await call("Task", { description: `job ${at}`, prompt: "go", background: true });
    await expect(call("Task", { description: "one more", prompt: "go", background: true })).rejects.toThrow("At most 4 background subagents");
    expect(background).toHaveLength(4);
  });

  test("its result is announced through the hub when no tool collects it", async () => {
    const { call, idle, subagents } = setupBackground();
    await call("Task", { description: "Find it", prompt: "go", background: true });
    await subagents.settled("sa-1");
    await Bun.sleep(30);
    expect(idle.map((batch) => batch.ids)).toEqual([["sa-1"]]);
    expect(idle[0]!.text).toContain("The answer is 42.");
  });
});

describe("task_check, task_wait, task_cancel and task_list (S4)", () => {
  test("task_check peeks without collecting: the result is still announced", async () => {
    const { call, idle, subagents, hub } = setupBackground();
    await call("Task", { description: "Find it", prompt: "go", background: true });
    await subagents.settled("sa-1");

    const checked = textOf(await call("task_check", { id: "sa-1" }));
    expect(checked).toContain("sa-1 [completed]");
    expect(checked).toContain("Find it");
    expect(checked).toContain("The answer is 42.");
    expect(checked).toContain("900 tokens");
    expect(hub.pending().map((result) => result.id)).toEqual(["sa-1"]);
    await Bun.sleep(30);
    expect(idle.map((batch) => batch.ids)).toEqual([["sa-1"]]);
  });

  test("task_check of a running subagent shows its latest text so far", async () => {
    const { call, background } = setupBackground({
      runChild: (request) => {
        request.onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Halfway there." }] } } as never);
        return hangingChild(request);
      },
    });
    await call("Task", { description: "Slow", prompt: "go", background: true });
    expect(background).toHaveLength(1);
    const checked = textOf(await call("task_check", { id: "sa-1" }));
    expect(checked).toContain("sa-1 [running]");
    expect(checked).toContain("Halfway there.");
  });

  test("task_wait waits for the ids, collects their results and includes them, so they are never announced", async () => {
    // The first ends well before the second: it must not be announced while the call waits for the other.
    let started = 0;
    const { call, idle, subagents, hub } = setupBackground({
      runChild: async () => {
        await Bun.sleep(++started === 1 ? 20 : 120);
        return FINISHED;
      },
    });
    await call("Task", { description: "First", prompt: "go", background: true });
    await call("Task", { description: "Second", prompt: "go", background: true });

    const waited = textOf(await call("task_wait", { ids: ["sa-1", "sa-2"] }));
    expect(waited).toContain(buildSubagentResult(subagents.get("sa-1")!));
    expect(waited).toContain(buildSubagentResult(subagents.get("sa-2")!));
    await Bun.sleep(30);
    expect(idle).toEqual([]);
    expect(hub.pending()).toEqual([]);
  });

  test("task_wait's timeout is clamped below the tool-call limit; what still runs is said to run and stays uncollected", async () => {
    const { call, idle, subagents } = setupBackground({ runChild: hangingChild, maxWaitMs: 50 });
    await call("Task", { description: "Slow", prompt: "go", background: true });

    for (const params of [{ ids: ["sa-1"], timeout: 3600 }, { ids: ["sa-1"] }]) {
      const started = Date.now();
      const waited = textOf(await call("task_wait", params));
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(waited).toContain("sa-1 [running]");
      expect(waited).toContain("still running");
    }
    expect(subagents.get("sa-1")!.status).toBe("running");
    await subagents.cancel(["sa-1"]);
    await Bun.sleep(30);
    // The waits collected nothing: stopped from here, not through a tool, it is announced.
    expect(idle.map((batch) => batch.ids)).toEqual([["sa-1"]]);
  });

  test("task_wait ends when its call is aborted, with what has settled so far", async () => {
    const { call } = setupBackground({ runChild: hangingChild });
    await call("Task", { description: "Slow", prompt: "go", background: true });
    const aborted = new AbortController();
    const waiting = call("task_wait", { ids: ["sa-1"], timeout: 100 }, aborted.signal);
    setTimeout(() => aborted.abort(), 20);
    const started = Date.now();
    const waited = textOf(await waiting);
    expect(Date.now() - started).toBeLessThan(90);
    expect(waited).toContain("sa-1 [running]");
  });

  test("task_cancel stops them, collects their results and includes them", async () => {
    const { call, idle, subagents, background } = setupBackground({ runChild: hangingChild });
    await call("Task", { description: "Slow", prompt: "go", background: true });

    const cancelled = textOf(await call("task_cancel", { ids: ["sa-1"] }));
    expect(background[0]!.signal.aborted).toBe(true);
    expect(subagents.get("sa-1")!.status).toBe("stopped");
    expect(cancelled).toContain('Background subagent sa-1 "Slow" was stopped');
    await Bun.sleep(30);
    expect(idle).toEqual([]);
  });

  test("task_cancel over several ids collects each as it settles: one that stops early is never announced as well (R3-1)", async () => {
    // Each child ends some time after its abort: the first after 20 ms, the second after 300 ms.
    let started = 0;
    const { call, idle, subagents, hub } = setupBackground({
      runChild: ({ signal }) => {
        const after = ++started === 1 ? 20 : 300;
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => setTimeout(() => reject(new Error("aborted")), after), { once: true }),
        );
      },
    });
    await call("Task", { description: "First", prompt: "go", background: true });
    await call("Task", { description: "Second", prompt: "go", background: true });

    const cancelled = textOf(await call("task_cancel", { ids: ["sa-1", "sa-2"] }));
    expect(cancelled).toContain('Background subagent sa-1 "First" was stopped');
    expect(cancelled).toContain('Background subagent sa-2 "Second" was stopped');
    expect(subagents.get("sa-1")!.status).toBe("stopped");
    await Bun.sleep(30);
    expect(idle).toEqual([]);
    expect(hub.pending()).toEqual([]);
  });

  test("task_list lists them all with their status", async () => {
    const { call, subagents } = setupBackground({ runChild: hangingChild });
    expect(textOf(await call("task_list", {}))).toBe("No background subagents.");
    await call("Task", { description: "Slow one", prompt: "go", background: true });
    await call("Task", { description: "Slow two", prompt: "go", background: true });
    await subagents.cancel(["sa-2"]);
    const listed = textOf(await call("task_list", {}));
    expect(listed).toContain('sa-1 [running] "Slow one"');
    expect(listed).toContain('sa-2 [stopped] "Slow two"');
  });

  test("an id this session did not start is a tool error naming the known ones", async () => {
    const other = setupBackground({ runChild: hangingChild });
    await other.call("Task", { description: "Elsewhere", prompt: "go", background: true });
    const { call } = setupBackground({ runChild: hangingChild });
    await expect(call("task_check", { id: "sa-9" })).rejects.toThrow('Unknown subagent id "sa-9". Known: none.');
    await expect(call("task_wait", { ids: ["sa-1"] })).rejects.toThrow('Unknown subagent id "sa-1"');
    await expect(call("task_cancel", { ids: ["sa-1"] })).rejects.toThrow('Unknown subagent id "sa-1"');
    expect(other.subagents.get("sa-1")!.status).toBe("running");
  });
});
