import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, MessagePart } from "../lib/chat-types";
import { engines } from "../lib/engine";
import type { Engine, EngineEvent, PermissionDecision, TurnHost, TurnRequest } from "../lib/engine/types";
import { setDefaultEngine } from "../lib/preferences";
import type { QuitTurn } from "../lib/quit";
import { openStorage, type Storage } from "../lib/storage";
import { runHeadless, type RunOptions } from "./run";

type Script = (request: TurnRequest, host: TurnHost) => Promise<void> | void;

/** An engine that runs `script` as its turn and keeps the requests it was given. */
function fakeEngine(script: Script) {
  const requests: TurnRequest[] = [];
  const engine: Engine = {
    id: "fake",
    startTurn(request, host) {
      requests.push(request);
      return { done: Promise.resolve().then(() => script(request, host)), interrupt() {} };
    },
    warmUpCommands: async () => {},
  };
  return { engine, requests };
}

const say = (host: TurnHost, text: string) =>
  host.emit({ type: "reply", update: (reply) => ({ ...reply, parts: [...reply.parts, { type: "text", text }] }) });
const addPart = (host: TurnHost, part: MessagePart) =>
  host.emit({ type: "reply", update: (reply) => ({ ...reply, parts: [...reply.parts, part] }) });

let dir: string;
let cwd: string;
let storage: Storage;
let out: string;
let err: string;

const io = { stdout: (text: string) => void (out += text), stderr: (text: string) => void (err += text) };
const baseOptions = (rest: Partial<RunOptions> = {}): RunOptions => ({ message: "hi", continue: false, format: "text", engine: "claude", cwd, ...rest });
const run = (rest: Partial<RunOptions> = {}, deps: Parameters<typeof runHeadless>[1] = {}) => runHeadless(baseOptions(rest), { storage, io, ...deps });
const lines = () => out.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-run-")));
  cwd = join(dir, "project");
  mkdirSync(cwd);
  storage = openStorage(":memory:");
  out = "";
  err = "";
});
afterEach(() => {
  engines.set("claude", undefined);
  engines.set("pi", undefined);
  rmSync(dir, { recursive: true, force: true });
});

describe("runHeadless: text format", () => {
  test("prints the final reply alone on stdout, exit 0, and saves the session like the TUI", async () => {
    const { engine, requests } = fakeEngine((_request, host) => {
      host.emit({ type: "session", ref: "ref-1" });
      say(host, "Hello there");
    });
    engines.set("claude", engine);

    const code = await run({ message: "say hello" });

    expect(code).toBe(0);
    expect(out).toBe("Hello there\n");
    expect(err).toBe("");
    const [summary] = storage.listSessions();
    const saved = storage.getSession(summary!.id)!;
    expect(saved).toMatchObject({ title: "say hello", cwd, engine: "claude", engineSessionRef: "ref-1" });
    expect(saved.messages.map((m) => [m.role, m.parts])).toEqual([
      ["user", [{ type: "text", text: "say hello" }]],
      ["assistant", [{ type: "text", text: "Hello there" }]],
    ]);
    expect(saved.messages[0]!.metadata).toMatchObject({ mode: "BUILD", model: "opus", agent: "Build" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ prompt: "say hello", cwd, mode: "BUILD", model: "opus" });
    expect(requests[0]!.resumeRef).toBeUndefined();
    expect(requests[0]!.systemPromptAppend).toBeUndefined();
  });

  test("only the text after the last tool is the final reply", async () => {
    engines.set(
      "claude",
      fakeEngine((_request, host) => {
        say(host, "Let me look.");
        addPart(host, { type: "tool", toolCallId: "t1", toolName: "Read", input: {}, state: "done" });
        say(host, "The answer");
        addPart(host, { type: "reasoning", text: "hmm" });
        say(host, " is 4.");
      }).engine,
    );

    await run();

    expect(out).toBe("The answer\n is 4.\n");
  });

  test("with the default engine from the preferences, a new session uses it", async () => {
    const claude = fakeEngine((_r, host) => say(host, "from claude"));
    const pi = fakeEngine((_r, host) => say(host, "from pi"));
    engines.set("claude", claude.engine);
    engines.set("pi", pi.engine);

    setDefaultEngine("claude");
    await run({ engine: undefined });
    setDefaultEngine("pi");
    await run({ engine: undefined });

    expect(out).toBe("from claude\nfrom pi\n");
    expect(pi.requests[0]!.model).toMatch(/^[^/\s]+\/\S+$/);
  });

  test("an error event is reported on stderr, exit 1, and the session is still saved", async () => {
    engines.set(
      "claude",
      fakeEngine((_request, host) => {
        say(host, "partial");
        host.emit({ type: "error", message: "rate limited" });
      }).engine,
    );

    const code = await run();

    expect(code).toBe(1);
    expect(err).toBe("marcsh: rate limited\n");
    expect(out).toBe("partial\n");
    expect(storage.getSession(storage.listSessions()[0]!.id)!.messages).toHaveLength(2);
  });

  test("a turn that throws is exit 1", async () => {
    engines.set("claude", fakeEngine(() => Promise.reject(new Error("boom"))).engine);

    expect(await run()).toBe(1);
    expect(err).toBe("marcsh: boom\n");
  });

  test("a tool still running when the turn ends is saved as interrupted", async () => {
    engines.set(
      "claude",
      fakeEngine((_request, host) => addPart(host, { type: "tool", toolCallId: "t1", toolName: "Bash", input: {}, state: "running" })).engine,
    );

    await run();

    const saved = storage.getSession(storage.listSessions()[0]!.id)!;
    expect(saved.messages[1]!.parts).toEqual([{ type: "tool", toolCallId: "t1", toolName: "Bash", input: {}, state: "error", errorText: "Interrupted" }]);
  });

  test("a session whose engine this build does not know fails with exit 1", async () => {
    const made = storage.createSession({ title: "old", cwd, engine: "gone" });

    expect(await run({ session: made.id })).toBe(1);
    expect(err).toContain("unknown engine: gone");
  });
});

describe("runHeadless: the message", () => {
  test("standard input is appended to the message, and may be the whole message", async () => {
    const { engine, requests } = fakeEngine((_r, host) => say(host, "ok"));
    engines.set("claude", engine);

    await run({ message: "summarize", stdin: "line one\nline two\n" });
    await run({ message: "", stdin: "only stdin" });

    expect(requests.map((r) => r.prompt)).toEqual(["summarize\n\nline one\nline two", "only stdin"]);
  });

  test("no message and no stdin is a usage error (exit 2) that starts nothing", async () => {
    const { engine, requests } = fakeEngine(() => {});
    engines.set("claude", engine);

    const code = await run({ message: "  ", stdin: "\n" });

    expect(code).toBe(2);
    expect(err).toContain("marcsh: no message");
    expect(requests).toHaveLength(0);
    expect(storage.listSessions()).toHaveLength(0);
  });
});

describe("runHeadless: sessions", () => {
  test("--session resumes that session: its engine ref goes in, its messages are kept and the new ones appended", async () => {
    const { engine, requests } = fakeEngine((_r, host) => say(host, "second"));
    engines.set("claude", engine);
    const made = storage.createSession({ title: "first", cwd, engine: "claude" });
    const earlier: ChatMessage[] = [{ id: "m1", role: "user", parts: [{ type: "text", text: "one" }] }];
    storage.saveMessages(made.id, earlier, "ref-old");

    const code = await run({ session: made.id, message: "two" });

    expect(code).toBe(0);
    expect(requests[0]!.resumeRef).toBe("ref-old");
    const saved = storage.getSession(made.id)!;
    expect(saved.messages.map((m) => m.parts[0])).toEqual([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
      { type: "text", text: "second" },
    ]);
    expect(storage.listSessions()).toHaveLength(1);
  });

  test("--session with an unknown id is a usage error (exit 2)", async () => {
    engines.set("claude", fakeEngine(() => {}).engine);

    expect(await run({ session: "nope" })).toBe(2);
    expect(err).toContain('marcsh: no session with id "nope"');
  });

  test("--continue picks the latest session of the folder, and starts a new one when there is none", async () => {
    const { engine, requests } = fakeEngine((_r, host) => say(host, "ok"));
    engines.set("claude", engine);

    await run({ continue: true });
    expect(storage.listSessions()).toHaveLength(1);

    const first = storage.listSessions()[0]!;
    Bun.sleepSync(2);
    storage.createSession({ title: "elsewhere", cwd: join(dir, "other"), engine: "claude" });
    storage.saveMessages(first.id, storage.getSession(first.id)!.messages, "ref-first");
    await run({ continue: true, message: "again" });

    expect(storage.listSessions()).toHaveLength(2);
    expect(requests[1]!.resumeRef).toBe("ref-first");
    expect(storage.getSession(first.id)!.messages).toHaveLength(4);
  });

  test("--engine does not change the engine of an existing session; stderr says so", async () => {
    const claude = fakeEngine((_r, host) => say(host, "claude"));
    const pi = fakeEngine((_r, host) => say(host, "pi"));
    engines.set("claude", claude.engine);
    engines.set("pi", pi.engine);
    const made = storage.createSession({ title: "x", cwd, engine: "pi" });

    await run({ session: made.id, engine: "claude" });

    expect(pi.requests).toHaveLength(1);
    expect(claude.requests).toHaveLength(0);
    expect(err).toContain("--engine claude is ignored");
  });
});

describe("runHeadless: model and agent", () => {
  test("-m is sent as the model", async () => {
    const { engine, requests } = fakeEngine(() => {});
    engines.set("claude", engine);

    await run({ model: "haiku" });

    expect(requests[0]!.model).toBe("haiku");
  });

  test("--agent selects an agent by id or name: its prompt, mode and model go to the engine", async () => {
    const agents = process.env.MARCSH_AGENTS_DIR!;
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "reviewer.md"), "---\nname: Reviewer\npermission: read-only\nmodel: sonnet\n---\nYou review code.\n");
    const { engine, requests } = fakeEngine(() => {});
    engines.set("claude", engine);

    expect(await run({ agent: "Reviewer" })).toBe(0);
    expect(await run({ agent: "user/reviewer" })).toBe(0);

    for (const request of requests) expect(request).toMatchObject({ mode: "PLAN", model: "sonnet", systemPromptAppend: "You review code." });
    rmSync(agents, { recursive: true, force: true });
  });

  test("an unknown agent is a usage error (exit 2) that starts nothing", async () => {
    const { engine, requests } = fakeEngine(() => {});
    engines.set("claude", engine);

    expect(await run({ agent: "ghost" })).toBe(2);
    expect(err).toContain('marcsh: no agent "ghost"');
    expect(requests).toHaveLength(0);
  });
});

describe("runHeadless: nobody to ask (A1)", () => {
  test("every permission ask is denied with one stderr line naming the tool; questions and dialogs are declined; trust is skipped", async () => {
    const answers: unknown[] = [];
    engines.set(
      "claude",
      fakeEngine(async (request, host) => {
        const { signal } = request;
        answers.push(await host.askPermission({ toolName: "Bash", input: { command: "rm -rf x" } }, signal));
        answers.push(await host.askPermission({ toolName: "Write", input: {} }, signal));
        answers.push(await host.askQuestions([], signal));
        answers.push(await host.select?.("t", ["a"], signal));
        answers.push(await host.confirm?.("t", "m", signal));
        answers.push(await host.input?.("t", undefined, signal));
        answers.push(await host.editor?.("t", undefined, signal));
        answers.push(await host.askProjectTrust?.({ cwd, resources: [] }, signal));
      }).engine,
    );

    const code = await run();

    expect(code).toBe(0);
    expect(answers).toEqual(["deny" satisfies PermissionDecision, "deny", null, undefined, false, undefined, undefined, "skip"]);
    expect(err.trim().split("\n")).toEqual([
      "marcsh: denied Bash (headless runs cannot ask for approval)",
      "marcsh: denied Write (headless runs cannot ask for approval)",
    ]);
  });

  test("notices from the engine go to stderr, never stdout", async () => {
    engines.set(
      "claude",
      fakeEngine((_r, host) => {
        host.notify?.("heads up", "warning");
        say(host, "done");
      }).engine,
    );

    await run();

    expect(err).toBe("marcsh: heads up\n");
    expect(out).toBe("done\n");
  });
});

describe("runHeadless: json format", () => {
  test("one JSON object per engine event, with the reply as its parts, then a result", async () => {
    engines.set(
      "claude",
      fakeEngine((_request, host) => {
        host.emit({ type: "session", ref: "r1" });
        say(host, "Hel");
        say(host, "lo");
      }).engine,
    );

    const code = await run({ format: "json" });

    expect(code).toBe(0);
    const events = lines();
    const sessionId = storage.listSessions()[0]!.id;
    expect(events).toEqual([
      { type: "session", ref: "r1" },
      { type: "reply", parts: [{ type: "text", text: "Hel" }] },
      { type: "reply", parts: [{ type: "text", text: "Hel" }, { type: "text", text: "lo" }] },
      { type: "result", ok: true, exitCode: 0, sessionId, text: "Hel\nlo" },
    ]);
    expect(out).not.toContain("update");
  });

  test("an error ends with a result that carries it, exit 1", async () => {
    engines.set("claude", fakeEngine((_r, host) => host.emit({ type: "error", message: "bad" } satisfies EngineEvent)).engine);

    const code = await run({ format: "json" });

    expect(code).toBe(1);
    expect(lines()).toEqual([
      { type: "error", message: "bad" },
      { type: "result", ok: false, exitCode: 1, sessionId: storage.listSessions()[0]!.id, text: "", error: "bad" },
    ]);
  });
});

describe("runHeadless: Ctrl+C", () => {
  test("aborts the turn, saves what was said, and returns 130 without printing the reply", async () => {
    let quitTurn: QuitTurn | undefined;
    let unregistered = false;
    let started!: () => void;
    const turnStarted = new Promise<void>((resolve) => (started = resolve));
    engines.set(
      "claude",
      fakeEngine(async (request, host) => {
        host.emit({ type: "session", ref: "r1" });
        say(host, "half an ans");
        addPart(host, { type: "tool", toolCallId: "t1", toolName: "Bash", input: {}, state: "running" });
        started();
        await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve()));
      }).engine,
    );

    const running = run(
      {},
      {
        registerTurn: (turn) => {
          quitTurn = turn;
          return () => void (unregistered = true);
        },
      },
    );
    await turnStarted;
    quitTurn!.stop();
    const code = await running;
    await quitTurn!.done;

    expect(code).toBe(130);
    expect(out).toBe("");
    expect(unregistered).toBe(true);
    const saved = storage.getSession(storage.listSessions()[0]!.id)!;
    expect(saved.engineSessionRef).toBe("r1");
    expect(saved.messages[1]!.parts).toEqual([
      { type: "text", text: "half an ans" },
      { type: "tool", toolCallId: "t1", toolName: "Bash", input: {}, state: "error", errorText: "Interrupted" },
    ]);
  });
});
