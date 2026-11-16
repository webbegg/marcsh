import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, InMemoryCredentialStore, type FauxResponseStep, type Message } from "@earendil-works/pi-ai";
import { createBackgroundHub } from "../background/hub";
import { subagentsFor } from "../background/session-subagents";
import { validateSurfaces } from "../edit-surfaces";
import { Mode } from "../modes";
import { openStorage } from "../storage";
import { createPiEngine } from "./pi";
import { type BackgroundRunChild, type ChildRun, createSubagentTools, type RunChild } from "./pi-subagent";
import { trustEveryProject } from "./test-trust";
import type { PermissionAsk, TurnHost, TurnRequest } from "./types";

// S2 / T8 regressions found by verification: ways a writer Task's child changed files outside its editSurfaces without being denied,
// or without the parent's Task result listing them.

let dir: string;
let cwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-surfaces-escapes-"));
  cwd = join(dir, "project");
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "a.ts"), "a\n");
  writeFileSync(join(cwd, "README.md"), "readme\n");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  // auto and yolo only relax on a feature branch.
  git("switch", "-qc", "feat/surfaces");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const CHILD_PROMPT = "child: do the task";
const readme = () => readFileSync(join(cwd, "README.md"), "utf8");
const COMMIT = "git -c user.name=t -c user.email=t@t commit -qam x";
const PY_WRITE_README = `python3 -c "open('README.md','w').write('PY')"`;

const firstUserText = (messages: Message[]) => {
  const user = messages.find((m) => m.role === "user");
  if (!user) return "";
  return typeof user.content === "string" ? user.content : user.content.map((block) => ("text" in block ? block.text : "")).join("");
};
const toolResults = (messages: Message[]) =>
  messages.flatMap((m) => (m.role === "toolResult" ? [m.content.map((block) => ("text" in block ? block.text : "")).join("")] : []));

type Step = [name: string, args: Record<string, unknown>] | ["SLEEP", { ms: number }];

/** The parent runs one Task with `editSurfaces`; the child makes `steps` one at a time, then answers "child done". */
async function run(editSurfaces: string[], steps: Step[], overrides: Partial<TurnRequest> = {}, engineOptions: { toolTimeoutMs?: number } = {}) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }], tokensPerSecond: 4000, tokenSize: { min: 1, max: 1 } });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const parentResults: string[][] = [];
  const router: FauxResponseStep = async (context) => {
    const messages = context.messages as Message[];
    const results = toolResults(messages);
    if (firstUserText(messages) === CHILD_PROMPT) {
      const next = steps[results.length];
      if (!next) return fauxAssistantMessage([fauxText("child done")]);
      if (next[0] === "SLEEP") {
        await new Promise((resolve) => setTimeout(resolve, (next[1] as { ms: number }).ms));
        return fauxAssistantMessage([fauxText("child done")]);
      }
      return fauxAssistantMessage([fauxToolCall(next[0], next[1] as never, { id: `c${results.length}` })], { stopReason: "toolUse" });
    }
    parentResults.push(results);
    return results.length === 0
      ? fauxAssistantMessage([fauxToolCall("Task", { description: "Write", prompt: CHILD_PROMPT, editSurfaces } as never, { id: "task" })], { stopReason: "toolUse" })
      : fauxAssistantMessage([fauxText("ok")]);
  };
  faux.setResponses(Array.from({ length: 20 }, () => router));
  const engine = createPiEngine({ agentDir: join(dir, "agent"), modelRuntime, permissionRules: openStorage(":memory:"), projectTrust: trustEveryProject, ...engineOptions });
  const asks: PermissionAsk[] = [];
  const host: TurnHost = { emit: () => {}, askPermission: async (ask) => (asks.push(ask), "allow"), askQuestions: async () => null };
  await engine.startTurn({ prompt: "hello", cwd, mode: Mode.BUILD, model: "faux/faux-1", signal: new AbortController().signal, ...overrides }, host).done;
  return { asks, task: parentResults.at(-1)![0] ?? "" };
}

describe("a file:// path is judged by the file pi writes", () => {
  test("a file:// URL whose fragment looks inside the surfaces is denied without a prompt; README.md is untouched", async () => {
    const { asks } = await run(["**/*.test.ts"], [["write", { path: `file://${cwd}/README.md#/x.test.ts`, content: "ESCAPED\n" }]], { approvalMode: "auto" });
    expect(asks).toEqual([]);
    expect(readme()).toBe("readme\n");
  }, 60000);

  test("a file:// URL with a query that looks inside the surfaces is denied without a prompt", async () => {
    const { asks } = await run(["**/src/**"], [["write", { path: `file://${cwd}/README.md?/src/x`, content: "ESCAPED\n" }]]);
    expect(asks).toEqual([]);
    expect(readme()).toBe("readme\n");
  }, 60000);

  test("a file:// URL outside the project is denied without a prompt even when a broad glob would match its text", async () => {
    const outside = join(dir, "elsewhere.ts");
    const { asks } = await run(["**/*.ts"], [["write", { path: `file://${outside}`, content: "ESCAPED\n" }]], { approvalMode: "auto" });
    expect(asks).toEqual([]);
    expect(existsSync(outside)).toBe(false);
  }, 60000);
});

describe("the Task result lists outside changes that a commit made clean again", () => {
  test("an outside write committed in the same bash call (yolo: nothing asks) is listed in the Task result", async () => {
    const { task } = await run(["src/**"], [["bash", { command: `${PY_WRITE_README} && ${COMMIT}` }]], { approvalMode: "yolo" });
    expect(task).toContain("Warning: files changed outside the allowed edit surfaces");
    expect(task).toContain("README.md");
  }, 60000);

  test("an outside write flagged in one bash call and committed in the next is still listed in the Task result", async () => {
    const { task } = await run(["src/**"], [["bash", { command: PY_WRITE_README }], ["bash", { command: COMMIT }]]);
    expect(task).toContain("Warning: files changed outside the allowed edit surfaces");
    expect(task).toContain("README.md");
  }, 60000);
});

describe("a writer that does not finish still reports its outside changes", () => {
  test("a Task that times out after an outside write tells the parent which files changed outside the surfaces", async () => {
    const { task } = await run(["src/**"], [["bash", { command: PY_WRITE_README }], ["SLEEP", { ms: 4000 }]], {}, { toolTimeoutMs: 1500 });
    expect(readme()).toBe("PY");
    expect(task).toContain("timed out");
    expect(task).toContain("README.md");
  }, 60000);
});

describe("a writer that restarts on the next model of its chain (fallback)", () => {
  test("the Task result lists what both attempts changed outside the surfaces", async () => {
    mkdirSync(join(dir, "agent"), { recursive: true });
    // pi retries a quota failure by itself; the test turns that off.
    writeFileSync(join(dir, "agent", "settings.json"), JSON.stringify({ retry: { enabled: false } }));
    const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }] });
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const parentResults: string[][] = [];
    const router: FauxResponseStep = (context, _options, _state, model) => {
      const messages = context.messages as Message[];
      const results = toolResults(messages);
      if (firstUserText(messages) === CHILD_PROMPT) {
        const bash = (command: string) => fauxAssistantMessage([fauxToolCall("bash", { command } as never, { id: `c${results.length}` })], { stopReason: "toolUse" });
        if (model.id === "faux-2") {
          return results.length === 0
            ? bash(PY_WRITE_README)
            : fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 You exceeded your current quota, please check your plan and billing details" });
        }
        return results.length === 0 ? bash(`python3 -c "open('NOTES.md','w').write('N')"`) : fauxAssistantMessage([fauxText("child done on faux-3")]);
      }
      parentResults.push(results);
      return results.length === 0
        ? fauxAssistantMessage([fauxToolCall("Task", { description: "Write", prompt: CHILD_PROMPT, agent: "developer", editSurfaces: ["src/**"] } as never, { id: "task" })], { stopReason: "toolUse" })
        : fauxAssistantMessage([fauxText("ok")]);
    };
    faux.setResponses(Array.from({ length: 20 }, () => router));
    const engine = createPiEngine({ agentDir: join(dir, "agent"), modelRuntime, permissionRules: openStorage(":memory:"), projectTrust: trustEveryProject });
    const host: TurnHost = { emit: () => {}, askPermission: async () => "allow", askQuestions: async () => null, notify: () => {} };
    await engine.startTurn(
      {
        prompt: "hello",
        cwd,
        mode: Mode.BUILD,
        model: "faux/faux-1",
        signal: new AbortController().signal,
        subagents: [{ name: "developer", readOnly: false, model: "faux/faux-2", fallback: [{ model: "faux/faux-3" }] }],
      },
      host,
    ).done;
    const task = parentResults.at(-1)![0] ?? "";
    expect(task).toContain("child done on faux-3");
    expect(task).toContain("Warning: files changed outside the allowed edit surfaces");
    expect(task).toContain("NOTES.md");
    expect(task).toContain("README.md");
  }, 60000);
});

// The Task tool on its own, with a child that reports through `report.check` the way pi.ts's runChild does.
describe("Task lists the changes outside the surfaces whichever way the child ends", () => {
  const FINISHED: ChildRun = { text: "done", toolUses: 0, totalTokens: 0, costUsd: 0 };
  const WARNING = "Warning: files changed outside the allowed edit surfaces (src/a.ts): README.md.";
  const edit = { description: "Edit", prompt: "go", editSurfaces: ["src/a.ts"] };

  function setup(options: { runChild?: RunChild; background?: BackgroundRunChild; timeoutMs?: number; signal?: AbortSignal }) {
    const hub = options.background ? createBackgroundHub({ debounceMs: 5, registerTurn: () => () => {} }) : undefined;
    hub?.setIdleSink(() => true);
    cleanups.push(async () => hub?.dispose());
    const tools = createSubagentTools({
      host: { emit: () => {} },
      signal: options.signal ?? new AbortController().signal,
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      runChild: options.runChild ?? (async () => FINISHED),
      ...(hub && options.background ? { background: { hub, canStart: true, runChild: options.background } } : {}),
    });
    const task = tools.find((tool) => tool.name === "Task")!;
    const run = (params: unknown) => task.execute("call-1", params as never, undefined, undefined, undefined as never);
    return { run, hub };
  }
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });
  const reportsReadme = (request: { report?: { check?: () => Promise<string[]> } }) => {
    request.report!.check = async () => ["README.md"];
  };

  test("a timeout", async () => {
    const { run } = setup({
      timeoutMs: 30,
      runChild: async (request) => {
        reportsReadme(request);
        return new Promise<ChildRun>(() => {});
      },
    });
    await expect(run(edit)).rejects.toThrow(/timed out after 30ms[^]*Warning: files changed outside the allowed edit surfaces \(src\/a\.ts\): README\.md\./);
  });

  test("a throw", async () => {
    const { run } = setup({
      runChild: async (request) => {
        reportsReadme(request);
        throw new Error("child failed");
      },
    });
    await expect(run(edit)).rejects.toThrow(`child failed\n\n${WARNING}`);
  });

  test("an abort", async () => {
    const turn = new AbortController();
    const { run } = setup({
      signal: turn.signal,
      runChild: async (request) => {
        reportsReadme(request);
        return new Promise<ChildRun>(() => {});
      },
    });
    const call = run(edit);
    await new Promise((resolve) => setTimeout(resolve, 10));
    turn.abort();
    await expect(call).rejects.toThrow(`The subagent was interrupted.\n\n${WARNING}`);
  });

  test("a guard that fails adds nothing; a Task with no surfaces keeps its plain error", async () => {
    const broken = setup({
      runChild: async (request) => {
        request.report!.check = async () => {
          throw new Error("git is gone");
        };
        throw new Error("child failed");
      },
    });
    await expect(broken.run(edit)).rejects.toThrow(/^child failed$/);
    const plain = setup({ runChild: async () => Promise.reject(new Error("child failed")) });
    await expect(plain.run({ description: "Edit", prompt: "go" })).rejects.toThrow(/^child failed$/);
  });

  test("a finished child that left no list is asked once more", async () => {
    const { run } = setup({
      runChild: async (request) => {
        reportsReadme(request);
        return FINISHED;
      },
    });
    const result = await run(edit);
    expect(result.content.map((block) => ("text" in block ? block.text : "")).join("")).toContain(WARNING);
  });

  test("a background child that fails", async () => {
    const { run, hub } = setup({
      background: async (request) => {
        reportsReadme(request);
        throw new Error("child failed");
      },
    });
    await run({ ...edit, background: true });
    await subagentsFor(hub!).settled("sa-1");
    const snapshot = subagentsFor(hub!).get("sa-1")!;
    expect(snapshot.status).toBe("failed");
    expect(snapshot.error).toContain("child failed");
    expect(snapshot.error).toContain("Warning: files changed outside the allowed edit surfaces (src/a.ts)");
    expect(snapshot.error).toContain("README.md");
  });
});

describe("whole-repository globs", () => {
  test.each([["**/**"], ["**/**/*"], ["./**/**"]])("%s is rejected as covering the whole repository", (surface) => {
    expect(validateSurfaces([surface]).join("\n")).toContain("covers the whole repository");
  });
});
