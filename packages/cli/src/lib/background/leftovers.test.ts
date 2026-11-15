import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearSessionMarker,
  findLeftovers,
  parseProcStat,
  parsePsLine,
  scanLeftovers,
  startSessionMarker,
  sessionMarker,
  stopLeftovers,
  type ProcessEntry,
  type SessionMarker,
} from "./leftovers";

// M6: the processes this marcsh run's tools started that outlived their call are found by the MARCSH_SESSION marker in their
// environment, and only those are ever signalled.

let dir: string;
// macOS hides the environment of its own platform binaries (/bin/sleep, /bin/sh) from `ps -E`: a copy of sleep is not one.
let sleeper: string;
let session: SessionMarker;
const started: number[] = [];
const children: ChildProcess[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-leftovers-"));
  sleeper = join(dir, "sleeper");
  copyFileSync(Bun.which("sleep")!, sleeper);
  chmodSync(sleeper, 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const newSession = (): SessionMarker => ({ id: randomUUID(), since: Date.now() - 1000 });

afterEach(async () => {
  // Every process a test started goes, whatever the test did: by pid, then anything still carrying the test's marker.
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  if (session) {
    for (const left of await scanLeftovers({ session, selfPid: -1 })) {
      try {
        process.kill(left.pid, "SIGKILL");
      } catch {}
    }
  }
});

const markedEnv = (extra: Record<string, string> = {}) => ({ ...process.env, MARCSH_SESSION: session.id, ...extra });
const unmarkedEnv = () => {
  const env = { ...process.env };
  delete env.MARCSH_SESSION;
  return env;
};

/** Runs `command` in the background of a shell that exits at once, so it is orphaned like what a finished tool call left; returns its pid. */
function orphan(command: string, env: NodeJS.ProcessEnv): number {
  const pid = Number(execFileSync("/bin/sh", ["-c", `${command} >/dev/null 2>&1 & echo $!`], { env, encoding: "utf8" }).trim());
  started.push(pid);
  return pid;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function scanUntil(check: (pids: number[]) => boolean, options: Parameters<typeof scanLeftovers>[0] = {}, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let pids: number[] = [];
  do {
    pids = (await scanLeftovers({ session, selfPid: process.pid, ...options })).map((left) => left.pid);
    if (check(pids)) return pids;
    await wait(100);
  } while (Date.now() < deadline);
  return pids;
}

describe("scanLeftovers with real processes", () => {
  test("lists a marked orphan, never an unmarked one, a live child of marcsh, or one started with an emptied environment", async () => {
    session = newSession();
    const marked = orphan(`${sleeper} 30`, markedEnv());
    const unmarked = orphan(`${sleeper} 31`, unmarkedEnv());
    // `env -i` drops the marker: such a process cannot be told apart from the user's own, so it is never listed (docs/security.md).
    const scrubbed = orphan(`env -i ${sleeper} 32`, markedEnv());
    const child = spawn(sleeper, ["33"], { env: markedEnv(), stdio: "ignore" });
    children.push(child);

    const pids = await scanUntil((found) => found.includes(marked));
    expect(pids).toContain(marked);
    expect(pids).not.toContain(unmarked);
    expect(pids).not.toContain(scrubbed);
    // Still under marcsh (a running tool call, a terminal, the engine's own processes): not a leftover.
    expect(pids).not.toContain(child.pid!);

    const left = (await scanLeftovers({ session, selfPid: process.pid })).find((entry) => entry.pid === marked)!;
    expect(left.command).toContain(`${sleeper} 30`);
    // Never its environment.
    expect(left.command).not.toContain("MARCSH_SESSION");
    expect(left.rssMb).toBeGreaterThan(0);
    expect(left.ageMs).toBeGreaterThanOrEqual(0);
    expect(left.startedAt).toBeGreaterThanOrEqual(session.since - 1000);
    expect(left.startedAt).toBeLessThanOrEqual(Date.now());
  }, 20000);

  test("a child that `sh -c '... &'`, `nohup` or a new session left behind is listed, with its group", async () => {
    session = newSession();
    const backgrounded = orphan(`/bin/sh -c '${sleeper} 30 & sleep 0.1'`, markedEnv());
    const nohup = orphan(`nohup ${sleeper} 31`, markedEnv());
    // A process that started its own session (as Playwright's browsers do): a detached spawn from a parent that then exits.
    const script = `const c = require("node:child_process").spawn(${JSON.stringify(sleeper)}, ["32"], { detached: true, stdio: "ignore" }); console.log(c.pid); c.unref();`;
    const setsid = Number(execFileSync(process.execPath, ["-e", script], { env: markedEnv(), encoding: "utf8" }).trim());
    started.push(setsid);

    const pids = await scanUntil((found) => found.includes(nohup) && found.includes(setsid) && found.length >= 3);
    expect(pids).toContain(nohup);
    expect(pids).toContain(setsid);
    // The `sh -c` shell (pid `backgrounded`) has gone; its sleeper is listed under its own pid.
    const all = await scanLeftovers({ session, selfPid: process.pid });
    const inner = all.find((entry) => entry.command.includes(`${sleeper} 30`));
    expect(inner).toBeDefined();
    expect(inner!.pid).not.toBe(backgrounded);
    if (inner) started.push(inner.pid);
    const own = all.find((entry) => entry.pid === setsid)!;
    expect(own.pgid).toBe(setsid);
    expect(own.groupOnly).toBe(true);
  }, 20000);

  test("names the background terminal or call that started it, and skips infrastructure and running terminals' groups", async () => {
    session = newSession();
    const fromTerminal = orphan(`${sleeper} 30`, markedEnv({ MARCSH_BG: "bt-7", MARCSH_CALL: "call-1" }));
    const infra = orphan(`${sleeper} 31`, markedEnv({ MARCSH_INFRA: "1" }));
    const pids = await scanUntil((found) => found.includes(fromTerminal));
    expect(pids).not.toContain(infra);
    const left = (await scanLeftovers({ session, selfPid: process.pid })).find((entry) => entry.pid === fromTerminal)!;
    expect(left.bg).toBe("bt-7");
    expect(left.call).toBe("call-1");
    // A running terminal's group is shown in /ps already.
    const excluded = await scanLeftovers({ session, selfPid: process.pid, excludeGroups: [left.pgid] });
    expect(excluded.map((entry) => entry.pid)).not.toContain(fromTerminal);
  }, 20000);

  test("only processes started since the session began are listed", async () => {
    session = newSession();
    const marked = orphan(`${sleeper} 30`, markedEnv());
    await scanUntil((found) => found.includes(marked));
    const later = await scanLeftovers({ session: { id: session.id, since: Date.now() + 120_000 }, selfPid: process.pid });
    expect(later.map((entry) => entry.pid)).not.toContain(marked);
  }, 20000);

  test("another session's marker is not this one", async () => {
    session = newSession();
    const other = orphan(`${sleeper} 30`, { ...process.env, MARCSH_SESSION: randomUUID() });
    const marked = orphan(`${sleeper} 31`, markedEnv());
    const pids = await scanUntil((found) => found.includes(marked));
    expect(pids).not.toContain(other);
  }, 20000);

  test("without a session marker nothing is scanned", async () => {
    expect(await scanLeftovers({ session: undefined, read: async () => { throw new Error("must not read"); } })).toEqual([]);
  });
});

describe("stopLeftovers with real processes", () => {
  test("SIGTERM stops a leftover; one that ignores it gets SIGKILL after the grace", async () => {
    session = newSession();
    const polite = orphan(`${sleeper} 30`, markedEnv());
    const stubborn = orphan(`${process.execPath} -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'`, markedEnv());
    await scanUntil((found) => found.includes(polite) && found.includes(stubborn));
    // Its SIGTERM handler is installed once it runs its script.
    await wait(500);
    const result = await stopLeftovers([polite, stubborn], { session, selfPid: process.pid, graceMs: 600 });
    expect(result.failed).toEqual([]);
    const how = Object.fromEntries(result.stopped.map((entry) => [entry.pid, entry.signal]));
    expect(how[polite]).toBe("SIGTERM");
    expect(how[stubborn]).toBe("SIGKILL");
    await wait(200);
    expect(alive(polite)).toBe(false);
    expect(alive(stubborn)).toBe(false);
  }, 20000);

  test("refuses a pid that is not a leftover of this session, and leaves it running", async () => {
    session = newSession();
    const unmarked = orphan(`${sleeper} 30`, unmarkedEnv());
    const child = spawn(sleeper, ["31"], { env: markedEnv(), stdio: "ignore" });
    children.push(child);
    await wait(300);
    const result = await stopLeftovers([unmarked, child.pid!, process.pid], { session, selfPid: process.pid, graceMs: 200 });
    expect(result.stopped).toEqual([]);
    expect(result.failed.map((entry) => entry.pid).sort()).toEqual([unmarked, child.pid!, process.pid].sort());
    expect(alive(unmarked)).toBe(true);
    expect(alive(child.pid!)).toBe(true);
  }, 20000);
});

/** A process table for the mocked tests. */
const entry = (over: Partial<ProcessEntry> & { pid: number }): ProcessEntry => ({
  ppid: 1,
  pgid: over.pid,
  startedAt: 1_000_000,
  rssKb: 2048,
  marked: true,
  command: `cmd-${over.pid}`,
  ...over,
});

describe("stopLeftovers checks again before each signal", () => {
  const since = 500_000;
  const mockSession = { id: "s", since };
  // marcsh itself (pid 7), in a group of its own.
  const marcsh = entry({ pid: 7, marked: false, startedAt: 1 });

  test("no group is signalled when marcsh's own group is unknown, or is the process's group", () => {
    const unknown = findLeftovers([entry({ pid: 20, pgid: 20 })], { since, selfPid: 7, now: 2_000_000 });
    expect(unknown[0]!.groupOnly).toBe(false);
    const shared = findLeftovers([entry({ pid: 7, pgid: 5, marked: false }), entry({ pid: 20, pgid: 5 })], { since, selfPid: 7, now: 2_000_000 });
    expect(shared[0]!.groupOnly).toBe(false);
    const own = findLeftovers([marcsh, entry({ pid: 20, pgid: 20 })], { since, selfPid: 7, now: 2_000_000 });
    expect(own[0]!.groupOnly).toBe(true);
  });

  test("a pid now held by a process with another start time is never signalled (PID reuse)", async () => {
    const signals: Array<[number, string]> = [];
    const result = await stopLeftovers([{ pid: 42, startedAt: 1_000_000 }], {
      session: mockSession,
      selfPid: 7,
      read: async () => [entry({ pid: 42, startedAt: 1_005_000 })],
      kill: (pid, signal) => void signals.push([pid, signal]),
      graceMs: 10,
    });
    expect(signals).toEqual([]);
    expect(result.stopped).toEqual([]);
    expect(result.failed[0]!.pid).toBe(42);
  });

  test("a pid reused during the grace gets no SIGKILL", async () => {
    const signals: Array<[number, string]> = [];
    let scans = 0;
    const result = await stopLeftovers([42], {
      session: mockSession,
      selfPid: 7,
      read: async () => [marcsh, ...(scans++ === 0 ? [entry({ pid: 42 })] : [entry({ pid: 42, startedAt: 1_009_000 })])],
      kill: (pid, signal) => void signals.push([pid, signal]),
      // The pid stays taken (by the new process).
      exists: () => true,
      graceMs: 10,
    });
    expect(signals).toEqual([[-42, "SIGTERM"]]);
    expect(result.stopped).toEqual([expect.objectContaining({ pid: 42, signal: "SIGTERM" })]);
  });

  test("an unmarked process, one started before the session, marcsh itself and infrastructure are never signalled", async () => {
    const signals: Array<[number, string]> = [];
    const result = await stopLeftovers([10, 11, 7, 12], {
      session: mockSession,
      selfPid: 7,
      read: async () => [
        entry({ pid: 10, marked: false }),
        entry({ pid: 11, startedAt: 100_000 }),
        entry({ pid: 7, ppid: 1 }),
        entry({ pid: 12, infra: true }),
      ],
      kill: (pid, signal) => void signals.push([pid, signal]),
      graceMs: 10,
    });
    expect(signals).toEqual([]);
    expect(result.failed.map((failed) => failed.pid)).toEqual([10, 11, 7, 12]);
  });

  test("the group is signalled only when every process in it is a leftover; else the process alone", async () => {
    const signals: Array<[number, string]> = [];
    let gone = false;
    await stopLeftovers([20, 30], {
      session: mockSession,
      selfPid: 7,
      read: async () =>
        gone
          ? [marcsh]
          : [
              marcsh,
              entry({ pid: 20, pgid: 20 }),
              entry({ pid: 21, pgid: 20 }),
              entry({ pid: 30, pgid: 30 }),
              // The user's own process in the same group.
              entry({ pid: 31, pgid: 30, marked: false }),
            ],
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        gone = true;
      },
      exists: () => !gone,
      graceMs: 10,
    });
    expect(signals).toEqual([
      [-20, "SIGTERM"],
      [30, "SIGTERM"],
    ]);
  });

  test("a descendant of marcsh (a running call) is not a leftover", () => {
    const found = findLeftovers([entry({ pid: 7, marked: false }), entry({ pid: 40, ppid: 7 }), entry({ pid: 41, ppid: 40 }), entry({ pid: 50, ppid: 1 })], {
      since,
      selfPid: 7,
      now: 2_000_000,
    });
    expect(found.map((left) => left.pid)).toEqual([50]);
  });

  test("a hostile command is shown on one line without control characters, and cut", () => {
    const [left] = findLeftovers([entry({ pid: 50, command: `evil\u001b[2J\u0007\nname ${"x".repeat(1000)}` })], { since, selfPid: 7, now: 2_000_000 });
    expect(left!.command).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(left!.command.startsWith("evil")).toBe(true);
    expect(left!.command.length).toBeLessThanOrEqual(300);
  });
});

describe("parsers", () => {
  test("a ps line: pid, parent, group, the start time (ps runs in UTC), memory, and the command", () => {
    const parsed = parsePsLine("  123     1   120 Sun Nov  5 09:03:07 2026       2148 /usr/bin/node server.js A=1");
    expect(parsed).toEqual({ pid: 123, ppid: 1, pgid: 120, startedAt: Date.UTC(2026, 10, 5, 9, 3, 7), rssKb: 2148, rest: "/usr/bin/node server.js A=1" });
    expect(parsePsLine("garbage")).toBeUndefined();
  });

  test("a /proc stat line whose name holds parentheses and spaces", () => {
    const fields = Array.from({ length: 50 }, (_, i) => String(i));
    // Fields after the name: state(3) ppid(4) pgrp(5) ... starttime(22) vsize(23) rss(24).
    fields[3] = "S";
    fields[4] = "1";
    fields[5] = "99";
    fields[22] = "4200";
    fields[24] = "512";
    const line = `77 (we ird) (x)) ${fields.slice(3).join(" ")}`;
    expect(parseProcStat(line)).toEqual({ pid: 77, ppid: 1, pgid: 99, startTicks: 4200, rssPages: 512 });
  });
});

describe("the session marker", () => {
  test("is fresh for each start and set in the environment the tools inherit", () => {
    const env: NodeJS.ProcessEnv = { MARCSH_SESSION: "from-a-parent-marcsh" };
    const marker = startSessionMarker(env, 1234);
    expect(marker.id).not.toBe("from-a-parent-marcsh");
    expect(env.MARCSH_SESSION).toBe(marker.id);
    expect(marker.since).toBe(1234);
    expect(sessionMarker()).toEqual(marker);
    expect(startSessionMarker({}).id).not.toBe(marker.id);
    // Other tests in this process scan with no marker.
    clearSessionMarker();
    expect(sessionMarker()).toBeUndefined();
  });
});
