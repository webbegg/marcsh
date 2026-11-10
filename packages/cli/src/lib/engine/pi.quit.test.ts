import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createQuit, type QuitEnv } from "../quit";
import { openStorage } from "../storage";
import { createPiEngine } from "./pi";
import type { PermissionAsk, TurnHost } from "./types";

// S20: quitting while a pi turn runs an approved bash command must not leave that command alive. pi starts bash commands
// detached, in their own process group, so only aborting the turn (pi's `session.abort()`) reaches them.

let dir: string;
let cwd: string;
let pgidFile: string;
let marker: string;
const started: number[] = [];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-pi-quit-")));
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
  pgidFile = join(dir, "pgid");
  marker = join(dir, "marker");
});

afterEach(() => {
  for (const pgid of started.splice(0)) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {}
  }
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, ms = 8000) {
  for (let waited = 0; waited < ms && !condition(); waited += 20) await sleep(20);
  if (!condition()) throw new Error("condition not met in time");
}

/**
 * True while any process of the group is still running. A killed process can linger as a zombie until it is reaped
 * (slow on a loaded machine); zombies run nothing, so they don't count.
 */
function groupAlive(pgid: number) {
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
  }
  const ps = Bun.spawnSync(["ps", "-A", "-o", "pgid=,stat="]).stdout.toString();
  return ps
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .some(([group, stat]) => Number(group) === pgid && !stat?.startsWith("Z"));
}

// A turn whose approved bash command records its own pid (the group leader: pi starts it detached), sleeps, then touches a marker.
async function startTurn(sleepSeconds: number) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("bash", { command: `echo $$ > ${pgidFile}; sleep ${sleepSeconds}; touch ${marker}` }, { id: "b1" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("done")]),
  ]);
  const engine = createPiEngine({ agentDir: join(dir, "agent"), modelRuntime, permissionRules: openStorage(":memory:") });
  const abort = new AbortController();
  const asks: PermissionAsk[] = [];
  const host: TurnHost = {
    emit() {},
    askPermission: async (ask) => (asks.push(ask), "allow"),
    askQuestions: async () => null,
  };
  const turn = engine.startTurn({ prompt: "go", cwd, mode: "BUILD", model: "faux/faux-1", signal: abort.signal }, host);
  await until(() => existsSync(pgidFile) && readFileSync(pgidFile, "utf8").trim() !== "");
  const pgid = Number(readFileSync(pgidFile, "utf8").trim());
  started.push(pgid);
  expect(asks.map((ask) => ask.toolName)).toEqual(["bash"]);
  return { turn, abort, pgid };
}

// A whole marcsh-like process: a pi turn with a long approved command, registered with the app's quit path and signal handlers.
const CHILD = `
const [, , agentDir, cwd, pgidFile, marker] = process.argv;
const { createPiEngine } = await import(${JSON.stringify(join(import.meta.dir, "pi.ts"))});
const { openStorage } = await import(${JSON.stringify(join(import.meta.dir, "../storage.ts"))});
const { registerTurn, installQuitSignals } = await import(${JSON.stringify(join(import.meta.dir, "../quit.ts"))});
const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText, InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
const faux = fauxProvider({ models: [{ id: "faux-1" }] });
const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
modelRuntime.registerNativeProvider(faux.provider);
faux.setResponses([
  // Long enough that the command cannot finish before the test's signal arrives, even on a loaded machine.
  fauxAssistantMessage([fauxToolCall("bash", { command: "echo $$ > " + pgidFile + "; sleep 8; touch " + marker }, { id: "b1" })], { stopReason: "toolUse" }),
  fauxAssistantMessage([fauxText("done")]),
]);
const engine = createPiEngine({ agentDir, modelRuntime, permissionRules: openStorage(":memory:") });
const abort = new AbortController();
installQuitSignals({ destroy() {} });
const turn = engine.startTurn(
  { prompt: "go", cwd, mode: "BUILD", model: "faux/faux-1", signal: abort.signal },
  { emit() {}, askPermission: async () => "allow", askQuestions: async () => null },
);
registerTurn({ stop: () => abort.abort(), done: turn.done });
`;

describe("quitting during a pi turn (S20)", () => {
  test("without quitting, the approved command keeps running (the problem this fixes)", async () => {
    const { turn, abort, pgid } = await startTurn(30);
    await sleep(500);
    expect(groupAlive(pgid)).toBe(true);
    abort.abort();
    await turn.done;
  });

  test("quit aborts the turn: its command group is dead before the exit and the command never finishes", async () => {
    const { turn, abort, pgid } = await startTurn(3);
    const exits: { code: number; groupAlive: boolean }[] = [];
    const env: QuitEnv = {
      exit: (code) => void exits.push({ code, groupAlive: groupAlive(pgid) }),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      graceMs: 5000,
    };
    const quit = createQuit(env);
    // What use-chat registers for the turn it runs.
    quit.registerTurn({ stop: () => abort.abort(), done: turn.done });

    let destroyed = 0;
    await quit.quitApp({ destroy: () => void destroyed++ });

    expect(destroyed).toBe(1);
    expect(exits.map((e) => e.code)).toEqual([0]);
    // pi's abort sends SIGSTOP then SIGKILL to the command's group before the turn settles (utils/shell.js
    // killProcessTree), so nothing of it can outlive the exit; on a loaded machine the kernel may still be
    // delivering the SIGKILL at that moment, so the group is checked shortly after instead of at the exit itself.
    for (let waited = 0; waited < 3000 && groupAlive(pgid); waited += 50) await sleep(50);
    expect(groupAlive(pgid)).toBe(false);
    // Past the command's own sleep: nothing of it survived to touch the marker.
    await sleep(3500);
    expect(existsSync(marker)).toBe(false);
  }, 15_000);

  test.each([
    ["SIGTERM", 143],
    ["SIGHUP", 129],
    ["SIGINT", 130],
  ] as const)("%s to the process stops the turn's command group and exits with %d", async (signal, code) => {
    const script = join(dir, "child.ts");
    writeFileSync(script, CHILD);
    const child = Bun.spawn([process.execPath, script, join(dir, "agent"), cwd, pgidFile, marker], { cwd: dir, stdout: "ignore", stderr: "ignore" });
    try {
      await until(() => existsSync(pgidFile) && readFileSync(pgidFile, "utf8").trim() !== "");
      const pgid = Number(readFileSync(pgidFile, "utf8").trim());
      started.push(pgid);

      child.kill(signal);
      const outcome = await Promise.race([child.exited, sleep(8000).then(() => "still running" as const)]);
      expect(outcome).toBe(code);
      // A killed process can be reported until it is reaped: give the group a moment under load.
      for (let waited = 0; waited < 3000 && groupAlive(pgid); waited += 50) await sleep(50);
      expect(groupAlive(pgid)).toBe(false);
      expect(existsSync(marker)).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  }, 25_000);
});
