import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, InMemoryCredentialStore, type FauxResponseStep, type Message } from "@earendil-works/pi-ai";
import { createBackgroundHub, type BackgroundHub } from "../background/hub";
import { subagentsFor } from "../background/session-subagents";
import { Mode } from "../modes";
import { openStorage } from "../storage";
import { createPiEngine } from "./pi";
import { trustEveryProject } from "./test-trust";
import type { EngineEvent, PermissionAsk, TurnHost, TurnRequest, TurnSubagent } from "./types";

// S2 / T8: `Task` with `editSurfaces` runs a writer child that is held to them: its edit/write (and the literal writes of its bash) outside
// them are denied without a prompt; inside them the normal approval applies; what bash changes outside them anyway is flagged after the fact.

let dir: string;
let agentDir: string;
let cwd: string;
const hubs: BackgroundHub[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-surfaces-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "a.ts"), "a\n");
  writeFileSync(join(cwd, "src", "b.ts"), "b\n");
  writeFileSync(join(cwd, "README.md"), "readme\n");
});

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.dispose()));
  rmSync(dir, { recursive: true, force: true });
});

const CHILD_PROMPT = "child: do the task";
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const text = (path: string) => readFileSync(join(cwd, path), "utf8");

const firstUserText = (messages: Message[]) => {
  const user = messages.find((m) => m.role === "user");
  if (!user) return "";
  return typeof user.content === "string" ? user.content : user.content.map((block) => ("text" in block ? block.text : "")).join("");
};
const toolResults = (messages: Message[]) =>
  messages.flatMap((m) => (m.role === "toolResult" ? [m.content.map((block) => ("text" in block ? block.text : "")).join("")] : []));
type Answer = ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>>;
const call = (name: string, args: Record<string, unknown>, id: string) => fauxAssistantMessage([fauxToolCall(name, args as never, { id })], { stopReason: "toolUse" });

type ToolCall = [name: string, args: Record<string, unknown>];

/** A git repository with the project's files committed, so the working-tree comparison has something to compare. */
function initRepo() {
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
}

/**
 * The parent calls `Task` once per entry of `tasks` (one result at a time), then answers "ok". The child (told apart by its prompt) makes
 * `calls` one at a time, then answers "child done". Everything each side saw is recorded.
 */
async function setup(tasks: Record<string, unknown>[], calls: ToolCall[] | ((results: string[]) => Answer) = []) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }], tokensPerSecond: 4000, tokenSize: { min: 1, max: 1 } });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const childResults: string[][] = [];
  const parentResults: string[][] = [];
  const router: FauxResponseStep = (context) => {
    const messages = context.messages as Message[];
    const results = toolResults(messages);
    if (firstUserText(messages) === CHILD_PROMPT) {
      childResults.push(results);
      if (typeof calls === "function") return calls(results);
      const next = calls[results.length];
      return next ? call(next[0], next[1], `c${results.length}`) : fauxAssistantMessage([fauxText("child done")]);
    }
    parentResults.push(results);
    const task = tasks[results.length];
    return task ? call("Task", { description: "Do the task", prompt: CHILD_PROMPT, ...task }, `task-${results.length}`) : fauxAssistantMessage([fauxText("ok")]);
  };
  faux.setResponses(Array.from({ length: 16 }, () => router));
  const engine = createPiEngine({ agentDir, modelRuntime, permissionRules: openStorage(":memory:"), projectTrust: trustEveryProject });

  async function turn(answer: "allow" | "deny" = "allow", overrides: Partial<TurnRequest> = {}) {
    const events: EngineEvent[] = [];
    const asks: PermissionAsk[] = [];
    const host: TurnHost = { emit: (event) => events.push(event), askPermission: async (ask) => (asks.push(ask), answer), askQuestions: async () => null };
    await engine.startTurn({ prompt: "hello", cwd, mode: Mode.BUILD, model: "faux/faux-1", signal: new AbortController().signal, ...overrides }, host).done;
    return { asks, errors: events.flatMap((e) => (e.type === "error" ? [e.message] : [])) };
  }
  return { turn, childResults, parentResults };
}

const asked = (asks: PermissionAsk[]) => asks.map((ask) => ask.toolName);

describe("a writer Task with editSurfaces: edit and write", () => {
  test("a write outside the surfaces is denied without a prompt, naming the surfaces; the file is not written", async () => {
    const { turn, childResults } = await setup([{ editSurfaces: ["src/a.ts"] }], [["write", { path: "src/b.ts", content: "NEW" }]]);
    const { asks, errors } = await turn();
    expect(errors).toEqual([]);
    expect(asks).toEqual([]);
    expect(text("src/b.ts")).toBe("b\n");
    const seen = childResults.at(-1)![0]!;
    expect(seen).toContain("src/b.ts");
    expect(seen).toContain("outside the allowed edit surfaces (src/a.ts)");
  }, 60000);

  test("an edit outside the surfaces is denied the same way", async () => {
    const { turn, childResults } = await setup([{ editSurfaces: ["src/a.ts"] }], [["edit", { path: "src/b.ts", edits: [{ oldText: "b", newText: "CHANGED" }] }]]);
    const { asks } = await turn();
    expect(asks).toEqual([]);
    expect(text("src/b.ts")).toBe("b\n");
    expect(childResults.at(-1)![0]).toContain("outside the allowed edit surfaces");
  }, 60000);

  test("absolute paths, `..` and paths outside the project are judged by where they land", async () => {
    const outside = join(dir, "elsewhere.txt");
    const { turn, childResults } = await setup(
      [{ editSurfaces: ["src/a.ts"] }],
      [
        ["write", { path: join(cwd, "src", "b.ts"), content: "X" }],
        ["write", { path: "src/../README.md", content: "X" }],
        ["write", { path: "../elsewhere.txt", content: "X" }],
        ["write", { path: outside, content: "X" }],
        ["write", { path: "@src/b.ts", content: "X" }],
      ],
    );
    const { asks } = await turn();
    expect(asks).toEqual([]);
    expect(text("src/b.ts")).toBe("b\n");
    expect(text("README.md")).toBe("readme\n");
    expect(existsSync(outside)).toBe(false);
    expect(childResults.at(-1)!.filter((result) => result.includes("outside the allowed edit surfaces"))).toHaveLength(5);
  }, 60000);

  test("inside the surfaces the normal approval applies: it asks, and the answer decides", async () => {
    const allowed = await setup([{ editSurfaces: ["src/a.ts"] }], [["write", { path: "src/a.ts", content: "NEW\n" }]]);
    const { asks } = await allowed.turn("allow");
    expect(asked(asks)).toEqual(["write"]);
    expect(text("src/a.ts")).toBe("NEW\n");

    writeFileSync(join(cwd, "src", "a.ts"), "a\n");
    const denied = await setup([{ editSurfaces: ["src/a.ts"] }], [["write", { path: "src/a.ts", content: "NEW\n" }]]);
    const refused = await denied.turn("deny");
    expect(asked(refused.asks)).toEqual(["write"]);
    expect(text("src/a.ts")).toBe("a\n");
  }, 60000);

  test("a surface that is a folder or a glob covers what is under it; surfaces only narrow, so an inside edit still asks", async () => {
    const { turn } = await setup(
      [{ editSurfaces: ["src/**"] }],
      [
        ["write", { path: "src/new/deep.ts", content: "D\n" }],
        ["write", { path: "README.md", content: "X" }],
      ],
    );
    const { asks } = await turn();
    expect(asked(asks)).toEqual(["write"]);
    expect(text("src/new/deep.ts")).toBe("D\n");
    expect(text("README.md")).toBe("readme\n");
  }, 60000);

  test("the parent's own writes are not bound", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-1" }] });
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    let step = 0;
    const router: FauxResponseStep = () => (step++ === 0 ? call("write", { path: "README.md", content: "P\n" }, "p1") : fauxAssistantMessage([fauxText("ok")]));
    faux.setResponses([router, router]);
    const engine = createPiEngine({ agentDir, modelRuntime, permissionRules: openStorage(":memory:"), projectTrust: trustEveryProject });
    const asks: PermissionAsk[] = [];
    const host: TurnHost = { emit: () => {}, askPermission: async (ask) => (asks.push(ask), "allow"), askQuestions: async () => null };
    await engine.startTurn({ prompt: "hello", cwd, mode: Mode.BUILD, model: "faux/faux-1", signal: new AbortController().signal }, host).done;
    expect(text("README.md")).toBe("P\n");
  }, 60000);
});

describe("a writer Task with editSurfaces: bash", () => {
  test("a literal write outside the surfaces is blocked without a prompt", async () => {
    const { turn, childResults } = await setup([{ editSurfaces: ["src/a.ts"] }], [["bash", { command: "echo NEW > src/b.ts" }]]);
    const { asks } = await turn();
    expect(asks).toEqual([]);
    expect(text("src/b.ts")).toBe("b\n");
    const seen = childResults.at(-1)![0]!;
    expect(seen).toContain("this command writes src/b.ts, outside the allowed edit surfaces (src/a.ts)");
  }, 60000);

  test("the literal forms the classifier reads are blocked: tee, sed -i, cp, mv, touch, mkdir, truncate", async () => {
    const commands = ["echo x | tee src/b.ts", "sed -i 's/b/X/' src/b.ts", "cp README.md src/b.ts", "mv src/b.ts src/c.ts", "touch src/new.ts", "mkdir src/dir", "truncate -s 0 src/b.ts"];
    const { turn, childResults } = await setup(
      [{ editSurfaces: ["src/a.ts"] }],
      commands.map((command): ToolCall => ["bash", { command }]),
    );
    const { asks } = await turn();
    expect(asks).toEqual([]);
    expect(childResults.at(-1)!.filter((result) => result.includes("outside the allowed edit surfaces"))).toHaveLength(commands.length);
    expect(text("src/b.ts")).toBe("b\n");
    expect(existsSync(join(cwd, "src", "new.ts"))).toBe(false);
    expect(existsSync(join(cwd, "src", "dir"))).toBe(false);
    expect(existsSync(join(cwd, "src", "c.ts"))).toBe(false);
  }, 60000);

  test("a write inside the surfaces, and a command that writes nothing, follow the normal approval", async () => {
    const { turn } = await setup([{ editSurfaces: ["src/a.ts"] }], [["bash", { command: "echo NEW > src/a.ts" }]]);
    const { asks } = await turn();
    expect(asked(asks)).toEqual(["bash"]);
    expect(text("src/a.ts")).toBe("NEW\n");
  }, 60000);

  test("a file that bash changed outside the surfaces by a way the parser cannot read is flagged after the fact, in a git repository; nothing is reverted", async () => {
    initRepo();
    const { turn, childResults, parentResults } = await setup([{ editSurfaces: ["src/a.ts"] }], [["bash", { command: 'F=src/b.ts; echo NEW > "$F"' }]]);
    const { asks } = await turn();
    expect(asked(asks)).toEqual(["bash"]);
    // The write ran (it could not be told in advance), and it was left alone.
    expect(text("src/b.ts")).toBe("NEW\n");
    expect(childResults.at(-1)![0]).toContain("changed files outside your allowed edit surfaces: src/b.ts");
    // The Task result the parent reads lists it too.
    const task = parentResults.at(-1)![0]!;
    expect(task).toContain("child done");
    expect(task).toContain("Warning: files changed outside the allowed edit surfaces (src/a.ts): src/b.ts");
  }, 60000);

  test("a change inside the surfaces, or none at all, is not flagged", async () => {
    initRepo();
    const { turn, childResults, parentResults } = await setup(
      [{ editSurfaces: ["src/a.ts"] }],
      [
        ["bash", { command: 'F=src/a.ts; echo NEW > "$F"' }],
        ["bash", { command: "ls" }],
      ],
    );
    await turn();
    expect(childResults.at(-1)!.join("\n")).not.toContain("outside your allowed edit surfaces");
    expect(parentResults.at(-1)![0]).not.toContain("Warning");
  }, 60000);

  test("a file the parent had already changed is not flagged: only what the child changed", async () => {
    initRepo();
    writeFileSync(join(cwd, "README.md"), "dirty before\n");
    const { turn, parentResults } = await setup([{ editSurfaces: ["src/a.ts"] }], [["bash", { command: 'F=src/a.ts; echo NEW > "$F"' }]]);
    await turn();
    expect(parentResults.at(-1)![0]).not.toContain("Warning");
  }, 60000);

  test("without git there is no comparison: the Task runs and nothing is flagged", async () => {
    const { turn, parentResults } = await setup([{ editSurfaces: ["src/a.ts"] }], [["bash", { command: 'F=src/b.ts; echo NEW > "$F"' }]]);
    const { errors } = await turn();
    expect(errors).toEqual([]);
    expect(parentResults.at(-1)![0]).not.toContain("Warning");
  }, 60000);
});

describe("a Task with invalid editSurfaces", () => {
  test.each([
    [["."], '"." covers the whole repository'],
    [["./"], '"./" covers the whole repository'],
    [["/etc/hosts"], '"/etc/hosts" must be repository-relative'],
    [["src/a.ts", "../other"], '"../other" must not escape the repository'],
    [["src/a.ts", ""], "empty surface entry"],
    [[], "must list at least one"],
  ])("%j is rejected before any child runs: %s", async (editSurfaces, message) => {
    const { turn, childResults, parentResults } = await setup([{ editSurfaces }], [["write", { path: "src/a.ts", content: "NEW" }]]);
    const { asks } = await turn();
    expect(childResults).toEqual([]);
    expect(asks).toEqual([]);
    expect(text("src/a.ts")).toBe("a\n");
    const seen = parentResults.at(-1)![0]!;
    expect(seen).toContain("Invalid editSurfaces");
    expect(seen).toContain(message);
  }, 60000);

  test("editSurfaces that is not a list of strings never starts a child", async () => {
    const { turn, childResults, parentResults } = await setup([{ editSurfaces: { path: "src/a.ts" } }]);
    await turn();
    expect(childResults).toEqual([]);
    expect(parentResults.at(-1)![0]).toContain("editSurfaces");
  }, 60000);

  test("a read-only subagent takes none", async () => {
    const reader: TurnSubagent = { name: "reader", description: "Reads", prompt: "You read.", readOnly: true };
    const { turn, childResults, parentResults } = await setup([{ agent: "reader", editSurfaces: ["src/a.ts"] }]);
    await turn("allow", { subagents: [reader] });
    expect(childResults).toEqual([]);
    expect(parentResults.at(-1)![0]).toContain("reader is read-only: do not pass editSurfaces");
  }, 60000);
});

describe("a Task without editSurfaces", () => {
  test("behaves as before: its writes ask, bash writes are not parsed against anything, and no warning is added", async () => {
    initRepo();
    const { turn, childResults, parentResults } = await setup(
      [{}],
      [
        ["write", { path: "src/b.ts", content: "NEW\n" }],
        ["bash", { command: "echo MORE > README.md" }],
      ],
    );
    const { asks } = await turn();
    expect(asked(asks)).toEqual(["write", "bash"]);
    expect(text("src/b.ts")).toBe("NEW\n");
    expect(text("README.md")).toBe("MORE\n");
    expect(childResults.at(-1)!.join("\n")).not.toContain("allowed edit surfaces");
    expect(parentResults.at(-1)![0]).toBe("child done");
  }, 60000);
});

describe("background writers with editSurfaces", () => {
  const newHub = () => {
    const hub = createBackgroundHub({ debounceMs: 5, registerTurn: () => () => {} });
    hubs.push(hub);
    hub.setIdleSink(() => true);
    hub.host = { askPermission: async () => "allow" };
    return hub;
  };

  test("a second background launch whose surfaces overlap a running one is rejected, naming both; a disjoint one starts", async () => {
    const hub = newHub();
    let release = false;
    const { turn, parentResults } = await setup(
      [
        { editSurfaces: ["src/**"], background: true },
        { editSurfaces: ["src/a.ts"], background: true },
        { editSurfaces: ["docs/**"], background: true },
      ],
      async () => {
        while (!release) await wait(10);
        return fauxAssistantMessage([fauxText("child done")]);
      },
    );
    await turn("allow", { background: hub });
    expect(subagentsFor(hub).list().map((snapshot) => snapshot.id)).toEqual(["sa-1", "sa-2"]);
    const results = parentResults.at(-1)!;
    expect(results[0]).toContain("Started background subagent sa-1");
    expect(results[1]).toContain("Task not started");
    expect(results[1]).toContain('"src/a.ts" overlaps "src/**"');
    expect(results[1]).toContain("Do the task");
    expect(results[2]).toContain("Started background subagent sa-2");
    release = true;
    await subagentsFor(hub).settled("sa-1");
    await subagentsFor(hub).settled("sa-2");
  }, 60000);

  test("once the first has finished its surfaces are free again", async () => {
    const hub = newHub();
    const { turn, parentResults } = await setup([{ editSurfaces: ["src/**"], background: true }], () => fauxAssistantMessage([fauxText("child done")]));
    await turn("allow", { background: hub });
    await subagentsFor(hub).settled("sa-1");
    expect(subagentsFor(hub).get("sa-1")!.status).toBe("completed");

    const next = await setup([{ editSurfaces: ["src/a.ts"], background: true }], () => fauxAssistantMessage([fauxText("child done")]));
    // A new engine has its own session; the same hub's running list is what counts: nothing is running, so it starts.
    await next.turn("allow", { background: hub });
    expect(next.parentResults.at(-1)![0]).toContain("Started background subagent sa-2");
    expect(parentResults.at(-1)![0]).toContain("Started background subagent sa-1");
    await subagentsFor(hub).settled("sa-2");
  }, 60000);

  test("a background writer is held to its surfaces too, and its outside changes are in its delivered result", async () => {
    initRepo();
    const hub = newHub();
    const { turn, childResults } = await setup([{ editSurfaces: ["src/a.ts"], background: true }], [["write", { path: "src/b.ts", content: "NEW" }]]);
    await turn("allow", { background: hub });
    await subagentsFor(hub).settled("sa-1");
    expect(text("src/b.ts")).toBe("b\n");
    expect(childResults.at(-1)![0]).toContain("outside the allowed edit surfaces (src/a.ts)");
    expect(subagentsFor(hub).get("sa-1")!.text).toBe("child done");
  }, 60000);

  test("a foreground writer's surfaces count against a running background writer", async () => {
    const hub = newHub();
    let release = false;
    const { turn, parentResults } = await setup([{ editSurfaces: ["src/**"], background: true }, { editSurfaces: ["src/a.ts"] }], async () => {
      while (!release) await wait(10);
      return fauxAssistantMessage([fauxText("child done")]);
    });
    await turn("allow", { background: hub });
    expect(parentResults.at(-1)![1]).toContain("Task not started");
    release = true;
    await subagentsFor(hub).settled("sa-1");
  }, 60000);
});
