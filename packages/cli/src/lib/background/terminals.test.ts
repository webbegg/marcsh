import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQuit, type QuitTurn } from "../quit";
import { createBackgroundHub } from "./hub";
import { terminalsFor } from "./session-terminals";
import { createTerminals, MAX_RUNNING, MAX_TRACKED, type BackgroundTerminals, type TerminalSnapshot } from "./terminals";

let base: string;
let cwd: string;
const made: BackgroundTerminals[] = [];

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "marcsh-bg-terminals-"));
  cwd = base;
});

afterEach(async () => {
  await Promise.all(made.splice(0).map((terminals) => terminals.dispose()));
  rmSync(base, { recursive: true, force: true });
});

function setup(options: Parameters<typeof createTerminals>[0] = {}) {
  const settled: TerminalSnapshot[] = [];
  const terminals = createTerminals({ logBase: base, onSettled: (snap) => settled.push(snap), ...options });
  made.push(terminals);
  return { terminals, settled };
}

const groupAlive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, timeoutMs = 8000) {
  const start = Date.now();
  while (!check() && Date.now() - start < timeoutMs) await wait(10);
  expect(check()).toBe(true);
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a rejection");
}

describe("background terminals (S1)", () => {
  test("runs the command with sh, captures stdout and stderr apart, and settles once with the exit code", async () => {
    const { terminals, settled } = setup();
    const snap = await terminals.start({ command: "echo out; echo err >&2; exit 3", title: "mixed", cwd });
    expect(snap).toMatchObject({ id: "bt-1", title: "mixed", command: "echo out; echo err >&2; exit 3", cwd });
    await terminals.settled(snap.id);
    expect(snap.status).toBe("failed");
    expect(snap.exitCode).toBe(3);
    expect(snap.stdout.text).toBe("out\n");
    expect(snap.stderr.text).toBe("err\n");
    expect(settled).toEqual([snap]);
    // The full log is on disk by the time it settles.
    expect(readFileSync(snap.stdout.logPath!, "utf8")).toBe("out\n");
    expect(readFileSync(snap.stderr.logPath!, "utf8")).toBe("err\n");
  });

  test("an exit code of 0 is done; the process gets no stdin", async () => {
    const { terminals } = setup();
    const snap = await terminals.start({ command: "cat; echo read-nothing", title: "stdin", cwd });
    await terminals.settled(snap.id);
    expect(snap.status).toBe("done");
    expect(snap.exitCode).toBe(0);
    expect(snap.stdout.text).toBe("read-nothing\n");
  });

  test("output written right before the exit is in the settled snapshot (settles on close)", async () => {
    const { terminals } = setup();
    const snap = await terminals.start({ command: "i=0; while [ $i -lt 2000 ]; do echo line-$i; i=$((i+1)); done", title: "chatty", cwd });
    await terminals.settled(snap.id);
    expect(snap.stdout.text.trim().split("\n")).toHaveLength(2000);
    expect(snap.stdout.text.endsWith("line-1999\n")).toBe(true);
  });

  // R3-5: a start that fails (the folder is gone, or not searchable) is the start's error, never a "Started" nor a result.
  test("a command that cannot start rejects the start and is neither kept nor announced", async () => {
    const { terminals, settled } = setup();
    const changes: number[] = [];
    terminals.subscribe(() => changes.push(terminals.list().length));
    const missing = join(base, "gone");
    expect(await rejection(terminals.start({ command: "echo never", title: "nowhere", cwd: missing }))).toMatch(/could not be started.*ENOENT/);

    const locked = join(base, "locked");
    mkdirSync(locked, { mode: 0o000 });
    try {
      expect(await rejection(terminals.start({ command: "echo never", title: "locked", cwd: locked }))).toMatch(/could not be started.*EACCES/);
    } finally {
      chmodSync(locked, 0o700);
    }

    await wait(1700);
    expect(settled).toEqual([]);
    expect(terminals.list()).toEqual([]);
    expect(terminals.running()).toBe(0);
    expect(changes.at(-1)).toBe(0);
    // No log of a start that failed stays behind.
    expect(existsSync(join(terminals.logDir ?? base, "bt-1.stdout.log"))).toBe(false);
  });

  test("kill stops the whole process group, and the result is collected by the kill, not announced", async () => {
    const { terminals, settled } = setup();
    const snap = await terminals.start({ command: "sleep 30 & wait", title: "group", cwd });
    const pid = snap.pid!;
    await until(() => groupAlive(pid));
    const [result] = await terminals.kill([snap.id]);
    expect(result).toMatchObject({ id: snap.id, status: "killed", wasRunning: true, killed: true });
    expect(snap.status).toBe("killed");
    expect(groupAlive(pid)).toBe(false);
    expect(settled).toEqual([]);
  });

  test("a kill from the UI is not collected: the result is announced", async () => {
    const { terminals, settled } = setup();
    const snap = await terminals.start({ command: "sleep 30", title: "ui kill", cwd });
    terminals.requestKill(snap.id);
    await terminals.settled(snap.id);
    expect(snap.status).toBe("killed");
    expect(settled).toEqual([snap]);
  });

  test("a process that ignores SIGTERM is killed with SIGKILL after the grace", async () => {
    const { terminals } = setup({ forceKillAfterMs: 200 });
    const snap = await terminals.start({ command: "trap '' TERM; echo ready; while :; do sleep 0.05; done", title: "stubborn", cwd });
    await until(() => snap.stdout.text.includes("ready"));
    const started = Date.now();
    await terminals.kill([snap.id]);
    expect(snap.status).toBe("killed");
    expect(Date.now() - started).toBeLessThan(3000);
    expect(groupAlive(snap.pid!)).toBe(false);
  });

  // R4-9: a descendant that left the process group keeps the pipes open; once settled anyway, its output is not read any more.
  test("a terminal settled while a descendant still holds its pipes stops reading them", async () => {
    const { terminals } = setup({ forceKillAfterMs: 100 });
    const escaped = "perl -e 'setpgrp(0, 0); $| = 1; print \"PID $$\\n\"; while (1) { print \"tick\\n\"; select(undef, undef, undef, 0.02) }' &";
    const snap = await terminals.start({ command: `${escaped} sleep 0.1`, title: "leaky", cwd });
    await until(() => /PID \d+/.test(snap.stdout.text));
    const pid = Number(/PID (\d+)/.exec(snap.stdout.text)![1]);
    try {
      await terminals.settled(snap.id);
      expect(snap.errorText).toMatch(/did not close/);
      const version = snap.outputVersion;
      await wait(300);
      expect(snap.outputVersion).toBe(version);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }, 15000);

  test(`at most ${MAX_RUNNING} run at once`, async () => {
    const { terminals } = setup();
    const ids: string[] = [];
    for (let i = 0; i < MAX_RUNNING; i++) ids.push((await terminals.start({ command: "sleep 30", title: `s${i}`, cwd })).id);
    expect(terminals.running()).toBe(MAX_RUNNING);
    expect(await rejection(terminals.start({ command: "sleep 30", title: "one too many", cwd }))).toMatch(/At most 8/);
    await terminals.kill(ids);
    expect(terminals.running()).toBe(0);
    const next = await terminals.start({ command: "true", title: "room again", cwd });
    await terminals.settled(next.id);
  }, 20000);

  test(`at most ${MAX_TRACKED} are kept: the oldest settled one goes first, with its logs`, async () => {
    const { terminals } = setup();
    const first = await terminals.start({ command: "echo first", title: "t0", cwd });
    await terminals.settled(first.id);
    const logs = [first.stdout.logPath!, first.stderr.logPath!];
    expect(logs.every((path) => existsSync(path))).toBe(true);
    for (let i = 1; i < MAX_TRACKED + 2; i++) {
      const snap = await terminals.start({ command: "true", title: `t${i}`, cwd });
      await terminals.settled(snap.id);
    }
    const ids = terminals.list().map((snap) => snap.id);
    expect(ids).toHaveLength(MAX_TRACKED);
    expect(ids[0]).toBe("bt-3");
    expect(terminals.get("bt-1")).toBeUndefined();
    // R4-2: a pruned terminal's logs go with it.
    await until(() => logs.every((path) => !existsSync(path)));
    expect(existsSync(terminals.get("bt-3")!.stdout.logPath!)).toBe(true);
  }, 30000);

  test("dispose kills every running process and removes the log directory", async () => {
    const { terminals, settled } = setup();
    const a = await terminals.start({ command: "sleep 30 & wait", title: "a", cwd });
    const b = await terminals.start({ command: "sleep 30", title: "b", cwd });
    await until(() => groupAlive(a.pid!) && groupAlive(b.pid!));
    const logDir = terminals.logDir!;
    expect(existsSync(logDir)).toBe(true);
    await terminals.dispose();
    expect(groupAlive(a.pid!)).toBe(false);
    expect(groupAlive(b.pid!)).toBe(false);
    expect(existsSync(logDir)).toBe(false);
    // A session that is gone is told nothing.
    expect(settled).toEqual([]);
    expect(await rejection(terminals.start({ command: "true", title: "late", cwd }))).toMatch(/shutting down/);
  });

  // R4-1 advisory: a bare process.exit (no quit, no dispose) leaves no background process behind.
  test("the process's exit kills the process groups of terminals still running", async () => {
    const script = `const { createTerminals } = await import(${JSON.stringify(join(import.meta.dir, "terminals.ts"))});
      const terminals = createTerminals({ logBase: ${JSON.stringify(base)} });
      const snap = await terminals.start({ command: "sleep 30 & sleep 30 & wait", title: "server", cwd: ${JSON.stringify(base)} });
      console.log(snap.pid);
      process.exit(0);`;
    const result = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    expect(result.stderr.toString()).toBe("");
    const pid = Number(result.stdout.toString().trim());
    expect(pid).toBeGreaterThan(0);
    try {
      await until(() => !groupAlive(pid));
      expect(groupAlive(pid)).toBe(false);
    } finally {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
  });

  test("registers one exit handler once a terminal starts, which dispose takes back", async () => {
    const before = process.listenerCount("exit");
    const { terminals } = setup();
    await terminals.start({ command: "true", title: "a", cwd });
    await terminals.start({ command: "true", title: "b", cwd });
    // One for the terminals, one for the log directory.
    expect(process.listenerCount("exit")).toBe(before + 2);
    await terminals.dispose();
    expect(process.listenerCount("exit")).toBe(before);
  });

  // R4-1: logs a marcsh that was killed left behind are removed when a later one starts, never those of a live one.
  test("creating them sweeps the log directories of processes that are gone", async () => {
    const stale = join(base, "marcsh-bg-stale");
    mkdirSync(stale, { mode: 0o700 });
    writeFileSync(join(stale, "owner.pid"), String(Bun.spawnSync(["true"]).pid));
    const live = join(base, "marcsh-bg-live");
    mkdirSync(live, { mode: 0o700 });
    writeFileSync(join(live, "owner.pid"), String(process.pid));
    setup();
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  test("quit stops the running processes and waits for them (S1b)", async () => {
    let exitCode: number | undefined;
    const quit = createQuit({ exit: (code) => void (exitCode = code), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as never), graceMs: 5000 });
    const registered: QuitTurn[] = [];
    const { terminals } = setup({ registerTurn: (turn) => (registered.push(turn), quit.registerTurn(turn)) });
    const snap = await terminals.start({ command: "sleep 30 & wait", title: "server", cwd });
    await until(() => groupAlive(snap.pid!));
    expect(registered).toHaveLength(1);
    const started = Date.now();
    await quit.quitApp({ destroy: () => {} });
    expect(exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(snap.status).toBe("killed");
    expect(groupAlive(snap.pid!)).toBe(false);
  });
});

describe("a session's terminals (S1, S1b)", () => {
  test("hand their results to the hub, and the hub's dispose kills them", async () => {
    const hub = createBackgroundHub({ debounceMs: 1, registerTurn: () => () => {} });
    const terminals = terminalsFor(hub);
    expect(terminalsFor(hub)).toBe(terminals);
    const done = await terminals.start({ command: "echo built", title: "build", cwd });
    await terminals.settled(done.id);
    expect(hub.pending()).toEqual([expect.objectContaining({ id: done.id, kind: "terminal", title: "build", text: expect.stringContaining("built") })]);

    const server = await terminals.start({ command: "sleep 30 & wait", title: "server", cwd });
    await until(() => groupAlive(server.pid!));
    await hub.dispose();
    expect(groupAlive(server.pid!)).toBe(false);
    expect(terminals.disposed).toBe(true);
  });
});
