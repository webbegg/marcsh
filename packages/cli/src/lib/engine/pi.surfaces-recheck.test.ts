import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, InMemoryCredentialStore, type FauxResponseStep, type Message } from "@earendil-works/pi-ai";
import { Mode } from "../modes";
import { openStorage } from "../storage";
import { createPiEngine } from "./pi";
import { trustEveryProject } from "./test-trust";
import type { PermissionAsk, TurnHost, TurnRequest } from "./types";

// S2 / T8 recheck: more file:// spellings, outside writes undone or committed in a later bash call, and a writer that is aborted or fails.

let dir: string;
let cwd: string;
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-surfaces-recheck-"));
  cwd = join(dir, "project");
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "a.ts"), "a\n");
  writeFileSync(join(cwd, "README.md"), "readme\n");
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  git("switch", "-qc", "feat/surfaces");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const CHILD_PROMPT = "child: do the task";
const readme = () => readFileSync(join(cwd, "README.md"), "utf8");
const PY = `python3 -c "open('README.md','w').write('PY')"`;
const COMMIT = "git -c user.name=t -c user.email=t@t commit -qam x";
const WARNING = "Warning: files changed outside the allowed edit surfaces";

const firstUserText = (messages: Message[]) => {
  const user = messages.find((m) => m.role === "user");
  if (!user) return "";
  return typeof user.content === "string" ? user.content : user.content.map((b) => ("text" in b ? b.text : "")).join("");
};
const toolResults = (messages: Message[]) =>
  messages.flatMap((m) => (m.role === "toolResult" ? [m.content.map((b) => ("text" in b ? b.text : "")).join("")] : []));

type Step = [string, Record<string, unknown>] | ["SLEEP", { ms: number }] | ["ERROR", { msg: string }];

async function run(editSurfaces: string[], steps: Step[], overrides: Partial<TurnRequest> = {}, abortOnSleep = false) {
  mkdirSync(join(dir, "agent"), { recursive: true });
  writeFileSync(join(dir, "agent", "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  const faux = fauxProvider({ models: [{ id: "faux-1" }], tokensPerSecond: 4000, tokenSize: { min: 1, max: 1 } });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const parentResults: string[][] = [];
  const turn = new AbortController();
  const router: FauxResponseStep = async (context) => {
    const messages = context.messages as Message[];
    const results = toolResults(messages);
    if (firstUserText(messages) === CHILD_PROMPT) {
      const next = steps[results.length];
      if (!next) return fauxAssistantMessage([fauxText("child done")]);
      if (next[0] === "SLEEP") {
        if (abortOnSleep) setTimeout(() => turn.abort(), 200);
        await new Promise((resolve) => setTimeout(resolve, (next[1] as { ms: number }).ms));
        return fauxAssistantMessage([fauxText("child done")]);
      }
      if (next[0] === "ERROR") return fauxAssistantMessage([], { stopReason: "error", errorMessage: (next[1] as { msg: string }).msg });
      return fauxAssistantMessage([fauxToolCall(next[0], next[1] as never, { id: `c${results.length}` })], { stopReason: "toolUse" });
    }
    parentResults.push(results);
    return results.length === 0
      ? fauxAssistantMessage([fauxToolCall("Task", { description: "Write", prompt: CHILD_PROMPT, editSurfaces } as never, { id: "task" })], { stopReason: "toolUse" })
      : fauxAssistantMessage([fauxText("ok")]);
  };
  faux.setResponses(Array.from({ length: 30 }, () => router));
  const engine = createPiEngine({ agentDir: join(dir, "agent"), modelRuntime, permissionRules: openStorage(":memory:"), projectTrust: trustEveryProject });
  const asks: PermissionAsk[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: the folded reply is only searched as text
  let reply: any = { id: "r", role: "assistant", parts: [] };
  const host: TurnHost = {
    emit: (event) => {
      if (event.type === "reply") reply = event.update(reply);
    },
    askPermission: async (ask) => (asks.push(ask), "allow"),
    askQuestions: async () => null,
  };
  await engine.startTurn({ prompt: "hello", cwd, mode: Mode.BUILD, model: "faux/faux-1", signal: turn.signal, ...overrides }, host).done;
  return { asks, task: parentResults.at(-1)?.[0] ?? "", reply: JSON.stringify(reply) };
}

describe("file:// spellings are judged by the file pi writes", () => {
  test.each([
    ["localhost host with a fragment", ["**/*.test.ts"], (c: string) => `file://localhost${c}/README.md#/x.test.ts`],
    ["an encoded .. segment", ["src/**"], (c: string) => `file://${c}/src/%2e%2e/README.md`],
    ["an encoded slash pi rejects", ["**/src/**"], (c: string) => `file://${c}/src%2F..%2FREADME.md`],
  ])("%s is denied without a prompt; README.md is untouched", async (_name, surfaces, path) => {
    const { asks } = await run(surfaces, [["write", { path: path(cwd), content: "ESCAPED\n" }]], { approvalMode: "auto" });
    expect(asks).toEqual([]);
    expect(readme()).toBe("readme\n");
  }, 60000);

  test("an encoded .. that leaves the project is denied even under a broad glob", async () => {
    const { asks } = await run(["**/*.ts"], [["write", { path: `file://${cwd}/src/%2e%2e/%2e%2e/out.ts`, content: "X\n" }]], { approvalMode: "auto" });
    expect(asks).toEqual([]);
    expect(existsSync(join(dir, "out.ts"))).toBe(false);
  }, 60000);

  test("a file:// URL to a symlink inside the surfaces that points outside is denied", async () => {
    symlinkSync(join(cwd, "README.md"), join(cwd, "src", "link.md"));
    const { asks } = await run(["src/**"], [["write", { path: `file://${cwd}/src/link.md`, content: "ESCAPED\n" }]], { approvalMode: "auto" });
    expect(asks).toEqual([]);
    expect(readme()).toBe("readme\n");
  }, 60000);

  test("a file:// URL inside the surfaces still goes through the normal approval", async () => {
    const { asks } = await run(["src/**"], [["write", { path: `file://${cwd}/src/b.ts`, content: "B\n" }]]);
    expect(asks.length).toBe(1);
    expect(readFileSync(join(cwd, "src", "b.ts"), "utf8")).toBe("B\n");
  }, 60000);
});

describe("an outside write undone or rewritten in a later call is still listed", () => {
  test.each([
    ["git stash", "git stash -q"],
    ["git reset --hard HEAD~0", "git reset -q --hard HEAD~0"],
    ["a commit", COMMIT],
  ])("write, then %s", async (_name, second) => {
    const { task } = await run(["src/**"], [["bash", { command: PY }], ["bash", { command: second }]], { approvalMode: "yolo" });
    expect(task).toContain(WARNING);
    expect(task).toContain("README.md");
  }, 60000);

  test("write && commit --amend in one call", async () => {
    const { task } = await run(["src/**"], [["bash", { command: `${PY} && git -c user.name=t -c user.email=t@t commit -qa --amend --no-edit` }]], { approvalMode: "yolo" });
    expect(task).toContain(WARNING);
    expect(task).toContain("README.md");
  }, 60000);
});

describe("a writer that does not finish still reports its outside changes, end to end", () => {
  test("an aborted turn: the Task error lists README.md", async () => {
    const { reply } = await run(["src/**"], [["bash", { command: PY }], ["SLEEP", { ms: 3000 }]], {}, true);
    expect(readme()).toBe("PY");
    expect(reply).toContain("The subagent was interrupted.");
    expect(reply).toContain("README.md");
  }, 60000);

  test("a child that fails with a provider error: the Task error lists README.md", async () => {
    const { task } = await run(["src/**"], [["bash", { command: PY }], ["ERROR", { msg: "400 invalid request: bad field" }]]);
    expect(task).toContain("400 invalid request: bad field");
    expect(task).toContain(WARNING);
    expect(task).toContain("README.md");
  }, 60000);
});
