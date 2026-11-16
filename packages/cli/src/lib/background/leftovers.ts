import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { sanitizeText } from "./output";
import { BG_ENV, INFRA_ENV, SESSION_ENV, sessionMarker, type SessionMarker } from "./session-marker";
import { runningTerminalGroups } from "./terminals";

export { BG_ENV, clearSessionMarker, INFRA_ENV, SESSION_ENV, sessionMarker, startSessionMarker, type SessionMarker } from "./session-marker";

/**
 * Leftover processes: what this marcsh run's tools started that is still running on its own after the tool call (or background
 * terminal) that started it ended, such as a dev server started with `cmd &`, a browser Playwright left open, or a watcher.
 *
 * How they are told apart from everything else: at startup marcsh puts a fresh `MARCSH_SESSION=<uuid>` in its own environment, and
 * every process it starts inherits it (pi's `bash`, `bg_start` terminals, subagents' tools, the Claude CLI and its Bash). The
 * environment a process started with is readable by its owner (`ps -E` on macOS, `/proc/<pid>/environ` on Linux), so a process
 * carrying this run's marker was started by this run or by something it started. A leftover is such a process that:
 *  - started at or after the marker was made (a reused pid cannot match),
 *  - is no longer under marcsh's own process: anything still under it is a running tool call, a background terminal, or marcsh's
 *    infrastructure (the Claude CLI, MCP servers, pack hooks), all of which have an owner,
 *  - is not marked `MARCSH_INFRA=1` (what marcsh starts for itself on pi, such as pack hooks, even once orphaned),
 *  - is not in the group of a running background terminal (`/ps` shows it there).
 *
 * A long-lived program a tool call started (an editor, a tmux server, gpg-agent) keeps the marker, and so does everything the user
 * later starts through it. Such a leftover is marked `possiblyYours`: it has a terminal, leads its own session, runs under a marked
 * process that does, or (Linux) is in a session whose leader is marked and is not a tool call's shell. Stopping one is never refused
 * (the agent always asks first), but the agent is told not to suggest it.
 *
 * A read of the process table that was cut short (a timeout, too much output, a signal, a file that could not be read) fails: it is
 * never taken for a smaller table, which would make a running call's child look orphaned or a group look like leftovers only.
 *
 * What cannot be seen: a process started with an emptied environment (`env -i`) or one that clears its own, setuid programs,
 * processes started through launchd or a daemon (`open -a`, `docker run`, `brew services`), and on macOS Apple's own binaries
 * (`/bin/sleep`, `/usr/bin/python3`...), whose environment `ps -E` does not show.
 */

/** One process as the platform's process table shows it. */
export type ProcessEntry = {
  pid: number;
  ppid: number;
  pgid: number;
  /** When it started (epoch ms; whole seconds on macOS). */
  startedAt: number;
  /** The platform's own start time, compared when a pid is checked again: Linux's start ticks (its epoch comes from `btime`, which can move). Absent: `startedAt`. */
  startKey?: number;
  /** Its session's id (Linux; macOS's `ps` does not give it). */
  sid?: number;
  /** It leads its session (macOS: `s` in `ps`'s state). On Linux, `sid === pid` says it. */
  leader?: boolean;
  /** It has a controlling terminal. */
  tty?: boolean;
  rssKb: number;
  /** Its environment holds this run's marker. False when its environment could not be read. */
  marked: boolean;
  bg?: string;
  infra?: boolean;
  /** Its command line, read only for marked processes; never its environment. */
  command?: string;
};

/** Reads the process table, with `marked` and the marcsh variables worked out for `session` (the marker's value). Rejects when the read was incomplete. */
export type ProcessReader = (session: string, options?: { signal?: AbortSignal }) => Promise<ProcessEntry[]>;

export type Leftover = {
  pid: number;
  pgid: number;
  startedAt: number;
  /** What a later check compares to tell the same process from a reused pid (see `ProcessEntry.startKey`). */
  startKey: number;
  ageMs: number;
  rssMb: number;
  /** One line, control characters removed, at most 300 characters. Still escape it for the screen, and redact it for the agent (`redactCommand`). */
  command: string;
  bg?: string;
  /** Every process in its group is a leftover of this run, so stopping the group stops nothing else. */
  groupOnly: boolean;
  /** Why it may be the user's own process rather than something a tool call left behind (see above). */
  possiblyYours?: string;
};

const MAX_COMMAND = 300;
/** The start time of a process is whole seconds on macOS, so one started just after the marker can read up to a second earlier. */
const START_SLACK_MS = 1000;
/** How far up the parent chain a process is followed to see whether marcsh is above it. */
const MAX_DEPTH = 256;

function cleanCommand(command: string | undefined): string {
  const line = sanitizeText(command ?? "").replace(/\s+/g, " ").trim();
  return line.length > MAX_COMMAND ? `${line.slice(0, MAX_COMMAND - 1)}…` : line;
}

export type FindOptions = {
  since: number;
  /** marcsh's own pid: it and everything under it is not a leftover. */
  selfPid: number;
  /** Groups not to list (running background terminals). */
  excludeGroups?: readonly number[];
  now?: number;
};

const leadsSession = (entry: ProcessEntry) => entry.leader === true || (entry.sid !== undefined && entry.sid === entry.pid);

/** The leftovers in a process table, newest first. */
export function findLeftovers(entries: readonly ProcessEntry[], { since, selfPid, excludeGroups = [], now = Date.now() }: FindOptions): Leftover[] {
  const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
  const excluded = new Set(excludeGroups);
  const underMarcsh = (entry: ProcessEntry) => {
    let at: ProcessEntry | undefined = entry;
    for (let depth = 0; at && depth < MAX_DEPTH; depth++) {
      if (at.pid === selfPid || at.ppid === selfPid) return true;
      if (at.ppid <= 1) return false;
      at = byPid.get(at.ppid);
    }
    return false;
  };
  // A leftover is not under marcsh, so neither is any of its ancestors: a marked one that leads a session is not a tool call's shell.
  const possiblyYours = (entry: ProcessEntry): string | undefined => {
    if (entry.tty) return "it has a terminal";
    if (leadsSession(entry)) return "it leads its own session (like an editor, tmux or a daemon)";
    let at = entry.ppid > 1 ? byPid.get(entry.ppid) : undefined;
    for (let depth = 0; at && at.marked && depth < MAX_DEPTH; depth++) {
      if (at.tty || leadsSession(at)) return `it runs under pid ${at.pid}, which leads a session (like an editor or tmux)`;
      at = at.ppid > 1 ? byPid.get(at.ppid) : undefined;
    }
    const leader = entry.sid !== undefined && entry.sid > 1 ? byPid.get(entry.sid) : undefined;
    if (leader && leader.marked && leader.pid !== selfPid && !underMarcsh(leader)) return `it is in the session pid ${leader.pid} leads, which is not a tool call's shell`;
    return undefined;
  };
  const candidates = entries.filter(
    (entry) =>
      entry.marked &&
      !entry.infra &&
      entry.pid > 1 &&
      entry.pid !== selfPid &&
      entry.startedAt >= since - START_SLACK_MS &&
      !excluded.has(entry.pgid) &&
      !excluded.has(entry.pid) &&
      !underMarcsh(entry),
  );
  const leftoverPids = new Set(candidates.map((entry) => entry.pid));
  // A group is only ever signalled when marcsh's own group is known and is another one: the group must hold nothing but leftovers.
  const ownGroup = byPid.get(selfPid)?.pgid;
  const groupOnly = (pgid: number) =>
    ownGroup !== undefined && pgid !== ownGroup && pgid > 1 && entries.every((entry) => entry.pgid !== pgid || leftoverPids.has(entry.pid));
  return candidates
    .map((entry) => {
      const yours = possiblyYours(entry);
      return {
        pid: entry.pid,
        pgid: entry.pgid,
        startedAt: entry.startedAt,
        startKey: entry.startKey ?? entry.startedAt,
        ageMs: Math.max(0, now - entry.startedAt),
        rssMb: Math.round((entry.rssKb / 1024) * 10) / 10,
        command: cleanCommand(entry.command),
        ...(entry.bg ? { bg: entry.bg } : {}),
        groupOnly: groupOnly(entry.pgid),
        ...(yours ? { possiblyYours: yours } : {}),
      };
    })
    .sort((a, b) => b.startedAt - a.startedAt || b.pid - a.pid);
}

// --- Running a command ---

export type CaptureOptions = { timeoutMs?: number; maxBuffer?: number; signal?: AbortSignal };

/**
 * stdout of a command run in the C locale and in UTC (so `lstart` reads the same whatever time zone marcsh and the command were given).
 * Only a plain non-zero exit still gives what it printed (`ps -p` with a pid that has gone); a timeout, output over `maxBuffer`, a
 * signal, an abort or a command that could not start rejects, whatever was printed: a cut table is never taken for the whole one.
 */
export function capture(command: string, args: string[], { timeoutMs = 15_000, maxBuffer = 128 * 1024 * 1024, signal }: CaptureOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Aborted"));
    execFile(
      command,
      args,
      { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, maxBuffer, timeout: timeoutMs, ...(signal ? { signal } : {}) },
      (error, stdout) => {
        if (!error) return resolve(String(stdout ?? ""));
        const failed = error as NodeJS.ErrnoException & { code?: unknown; killed?: boolean; signal?: NodeJS.Signals | null };
        if (typeof failed.code === "number" && !failed.killed && !failed.signal) resolve(String(stdout ?? ""));
        else reject(error);
      },
    );
  });
}

// --- macOS: `ps` ---

/** By absolute path: a `ps` earlier in PATH (a project's `bin/`) never runs. */
const PS = "/bin/ps";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s+(\d+)\s(.*)$/;

/** One line of `ps -o pid=,ppid=,pgid=,stat=,tt=,lstart=,rss=,command=` (C locale, and UTC: `Sun Nov  5 09:03:07 2026`; `tt` is `??` without a terminal). */
export function parsePsLine(
  line: string,
): { pid: number; ppid: number; pgid: number; leader: boolean; tty: boolean; startedAt: number; rssKb: number; rest: string } | undefined {
  const match = PS_LINE.exec(line);
  if (!match) return undefined;
  const [, pid, ppid, pgid, state, tt, month, day, hour, minute, second, year, rss, rest] = match;
  const monthIndex = MONTHS.indexOf(month!);
  if (monthIndex === -1) return undefined;
  const startedAt = Date.UTC(Number(year), monthIndex, Number(day), Number(hour), Number(minute), Number(second));
  return {
    pid: Number(pid),
    ppid: Number(ppid),
    pgid: Number(pgid),
    leader: state!.includes("s"),
    tty: tt !== "??" && tt !== "-",
    startedAt,
    rssKb: Number(rss),
    rest: rest!,
  };
}

const lastValue = (text: string, name: string): string | undefined => {
  let found: string | undefined;
  for (const match of text.matchAll(new RegExp(`(?:^|\\s)${name}=(\\S*)`, "g"))) found = match[1];
  return found;
};

/**
 * One `ps -E` for the whole table (pid, parent, group, state, terminal, start, memory, and the command with the environment after it),
 * then, only for the lines that hold the marker, one `ps` without `-E` for their command alone: the environment is what comes after it,
 * so a command line that merely names the marker is not taken for it, and the environment is never shown.
 */
export const readPsProcesses: ProcessReader = async (session, { signal } = {}) => {
  const table = await capture(PS, ["-A", "-ww", "-E", "-o", "pid=,ppid=,pgid=,stat=,tt=,lstart=,rss=,command="], { signal });
  const token = `${SESSION_ENV}=${session}`;
  // A line that does not parse is the rest of an environment value holding a newline (bash's exported functions), not a process.
  const rows = table.split("\n").flatMap((line) => {
    const row = parsePsLine(line);
    return row ? [row] : [];
  });
  const maybe = rows.filter((row) => row.rest.includes(token));
  const commands = new Map<number, string>();
  if (maybe.length > 0) {
    const out = await capture(PS, ["-ww", "-o", "pid=,command=", "-p", maybe.map((row) => row.pid).join(",")], { signal });
    for (const line of out.split("\n")) {
      const match = /^\s*(\d+)\s(.*)$/.exec(line);
      if (match) commands.set(Number(match[1]), match[2]!);
    }
  }
  return rows.map((row) => {
    const base = { pid: row.pid, ppid: row.ppid, pgid: row.pgid, leader: row.leader, tty: row.tty, startedAt: row.startedAt, rssKb: row.rssKb };
    const command = commands.get(row.pid);
    if (command === undefined || !row.rest.startsWith(command)) return { ...base, marked: false };
    const env = row.rest.slice(command.length);
    if (lastValue(env, SESSION_ENV) !== session) return { ...base, marked: false };
    const bg = lastValue(env, BG_ENV);
    return { ...base, marked: true, command, ...(bg ? { bg } : {}), ...(lastValue(env, INFRA_ENV) === "1" ? { infra: true } : {}) };
  });
};

// --- Linux: `/proc` ---

/** `/proc/<pid>/stat`: the name (field 2) is in parentheses and may hold anything, so the fields are counted from its last `)`. */
export function parseProcStat(
  text: string,
): { pid: number; ppid: number; pgid: number; session: number; ttyNr: number; startTicks: number; rssPages: number } | undefined {
  const close = text.lastIndexOf(")");
  if (close === -1) return undefined;
  const pid = Number.parseInt(text, 10);
  // From field 3 (state) on.
  const fields = text.slice(close + 2).trim().split(/\s+/);
  const at = (field: number) => Number(fields[field - 3]);
  const parsed = { pid, ppid: at(4), pgid: at(5), session: at(6), ttyNr: at(7), startTicks: at(22), rssPages: at(24) };
  return Object.values(parsed).every(Number.isFinite) ? parsed : undefined;
}

/** Clock ticks per second in `/proc` (USER_HZ, 100 on Linux's user interface). */
const USER_HZ = 100;
const PAGE_KB = 4;
/** How many processes are read at once (each reads one file at a time): a big table never runs marcsh out of file descriptors. */
const PROC_CONCURRENCY = 32;

/** The part of the file system the `/proc` reader uses (tests give a fake one). */
export type ProcFs = { readFile(path: string): Promise<string>; readdir(path: string): Promise<string[]> };
const nodeProcFs: ProcFs = { readFile: (path) => readFile(path, "utf8"), readdir: (path) => readdir(path) };

/** A process that has gone (or is not the user's to see) between `readdir` and the read: skipped. Any other failure fails the scan. */
const vanished = (error: unknown) => ["ENOENT", "ESRCH", "EACCES"].includes(String((error as NodeJS.ErrnoException)?.code));

/** `fn` over `items`, at most `limit` at a time, in order; the first failure rejects and starts no more. */
async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const at = next++;
      try {
        results[at] = await fn(items[at]!);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Only the numeric directories of `/proc` are read: each one's `stat`, its `environ` (readable for the user's own), and the command line of marked ones. */
export function createProcReader(fs: ProcFs = nodeProcFs, concurrency = PROC_CONCURRENCY): ProcessReader {
  return async (session, { signal } = {}) => {
    const bootSeconds = Number(/^btime\s+(\d+)$/m.exec(await fs.readFile("/proc/stat"))?.[1]);
    if (!Number.isFinite(bootSeconds)) throw new Error("/proc/stat gives no boot time");
    const names = (await fs.readdir("/proc")).filter((name) => /^\d+$/.test(name));
    const token = `${SESSION_ENV}=${session}`;
    const entries = await mapLimited(names, concurrency, async (name): Promise<ProcessEntry | undefined> => {
      signal?.throwIfAborted();
      let text: string;
      try {
        text = await fs.readFile(`/proc/${name}/stat`);
      } catch (error) {
        if (vanished(error)) return undefined;
        throw error;
      }
      const stat = parseProcStat(text);
      if (!stat) throw new Error(`/proc/${name}/stat could not be parsed`);
      const base = {
        pid: stat.pid,
        ppid: stat.ppid,
        pgid: stat.pgid,
        sid: stat.session,
        tty: stat.ttyNr !== 0,
        startKey: stat.startTicks,
        startedAt: (bootSeconds + stat.startTicks / USER_HZ) * 1000,
        rssKb: stat.rssPages * PAGE_KB,
      };
      let vars: string[];
      try {
        vars = (await fs.readFile(`/proc/${name}/environ`)).split("\0");
      } catch {
        // Unread, it is not marked: never listed, and its group never signalled as a whole.
        return { ...base, marked: false };
      }
      if (!vars.includes(token)) return { ...base, marked: false };
      const value = (key: string) => vars.findLast((entry) => entry.startsWith(`${key}=`))?.slice(key.length + 1);
      let command = "";
      try {
        command = (await fs.readFile(`/proc/${name}/cmdline`)).split("\0").filter(Boolean).join(" ");
      } catch {}
      const bg = value(BG_ENV);
      return { ...base, marked: true, command, ...(bg ? { bg } : {}), ...(value(INFRA_ENV) === "1" ? { infra: true } : {}) };
    });
    return entries.filter((entry): entry is ProcessEntry => entry !== undefined);
  };
}

export const readProcProcesses: ProcessReader = createProcReader();

/** The platform's reader; none (nothing found) where marcsh knows no way to read other processes' environment. */
export function platformReader(): ProcessReader {
  if (process.platform === "darwin") return readPsProcesses;
  if (process.platform === "linux") return readProcProcesses;
  return async () => [];
}

export type LeftoverScanOptions = {
  /** Default: this process's marker; without one nothing is read. */
  session?: SessionMarker | undefined;
  read?: ProcessReader;
  /** Default: this process. */
  selfPid?: number;
  /** Default: the groups of the running background terminals. */
  excludeGroups?: readonly number[];
  now?: () => number;
  /** Stops the read (an interrupted tool call). */
  signal?: AbortSignal;
};

/** This run's leftover processes, newest first (one read of the process table). Rejects when the table could not be read whole. */
export async function scanLeftovers(options: LeftoverScanOptions = {}): Promise<Leftover[]> {
  const session = "session" in options ? options.session : sessionMarker();
  if (!session) return [];
  const entries = await (options.read ?? platformReader())(session.id, options.signal ? { signal: options.signal } : undefined);
  return findLeftovers(entries, {
    since: session.since,
    selfPid: options.selfPid ?? process.pid,
    excludeGroups: options.excludeGroups ?? runningTerminalGroups(),
    now: (options.now ?? Date.now)(),
  });
}

/** A pid to stop, with the start key it was listed with when known (`Leftover.startKey`): a pid now held by a process started at another time is left alone. */
export type StopTarget = number | { pid: number; startKey?: number };

export type StopOptions = LeftoverScanOptions & {
  /** How long a process has after SIGTERM before SIGKILL. Default 2 s. */
  graceMs?: number;
  /** Default `process.kill`. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Whether a pid is still taken. Default `process.kill(pid, 0)`. */
  exists?: (pid: number) => boolean;
};

export type StopResult = {
  stopped: Array<{ pid: number; command: string; signal: "SIGTERM" | "SIGKILL"; group: boolean }>;
  failed: Array<{ pid: number; reason: string }>;
};

const NOT_LEFTOVER = "not a leftover process of this marcsh run (only processes its tools started, no longer running under it, can be stopped)";
const REUSED = "that pid now belongs to another process";
const UNLISTED = "still running, but no longer listed as a leftover of this run: not checked, so left alone";
const INTERRUPTED = "still running: the stop was interrupted before SIGKILL";

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Stops leftover processes of this run. The process table is read again first, and each pid is signalled only if it is still one of
 * this run's leftovers (marker, start time, not under marcsh) and, when the caller gave one, has the start key it was listed with.
 * SIGTERM goes to the process, or to its whole group when every process in the group is a leftover of this run; what is still there
 * after the grace gets SIGKILL, after the same check once more. Nothing else is ever signalled. A pid still taken that cannot be
 * checked again (not listed any more, or the table could not be read) is reported as not stopped, never as stopped. A first read that
 * fails, or an abort before any signal, rejects; an abort later stops waiting, and sends no SIGKILL.
 */
export async function stopLeftovers(targets: readonly StopTarget[], options: StopOptions = {}): Promise<StopResult> {
  const { graceMs = 2000, kill = (pid, signal) => process.kill(pid, signal), exists = pidExists, signal } = options;
  const result: StopResult = { stopped: [], failed: [] };
  const wanted = new Map<number, number | undefined>();
  for (const target of targets) {
    const pid = typeof target === "number" ? target : target.pid;
    if (!Number.isInteger(pid) || wanted.has(pid)) continue;
    wanted.set(pid, typeof target === "number" ? undefined : target.startKey);
  }
  if (wanted.size === 0) return result;

  signal?.throwIfAborted();
  const byPid = (found: Leftover[]) => new Map(found.map((left) => [left.pid, left]));
  const before = byPid(await scanLeftovers(options));
  signal?.throwIfAborted();
  const sent: Array<{ left: Leftover; group: boolean }> = [];
  for (const [pid, startKey] of wanted) {
    const left = before.get(pid);
    if (!left) {
      result.failed.push({ pid, reason: NOT_LEFTOVER });
      continue;
    }
    if (startKey !== undefined && startKey !== left.startKey) {
      result.failed.push({ pid, reason: REUSED });
      continue;
    }
    const group = left.groupOnly;
    try {
      kill(group ? -left.pgid : left.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        result.failed.push({ pid, reason: `could not be signalled: ${message(error)}` });
        continue;
      }
    }
    sent.push({ left, group });
  }
  if (sent.length === 0) return result;

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && !signal?.aborted && sent.some(({ left }) => exists(left.pid))) await sleep(Math.min(100, Math.max(1, deadline - Date.now())));

  const remaining = sent.filter(({ left }) => exists(left.pid));
  for (const { left, group } of sent) if (!remaining.some((item) => item.left === left)) result.stopped.push({ pid: left.pid, command: left.command, signal: "SIGTERM", group });
  if (remaining.length === 0) return result;
  if (signal?.aborted) {
    for (const { left } of remaining) result.failed.push({ pid: left.pid, reason: INTERRUPTED });
    return result;
  }

  // Checked again: in the grace the process may have gone and its pid been given to another.
  let again: Map<number, Leftover>;
  try {
    again = byPid(await scanLeftovers(options));
  } catch (error) {
    for (const { left } of remaining) result.failed.push({ pid: left.pid, reason: `still running; the process table could not be read again before SIGKILL (${message(error)})` });
    return result;
  }
  const killed: Array<{ left: Leftover; group: boolean }> = [];
  for (const item of remaining) {
    const now = again.get(item.left.pid);
    if (!now) {
      // Gone since, or still there but no longer one this run can vouch for: only a pid that is free now counts as stopped.
      if (exists(item.left.pid)) result.failed.push({ pid: item.left.pid, reason: UNLISTED });
      else result.stopped.push({ pid: item.left.pid, command: item.left.command, signal: "SIGTERM", group: item.group });
      continue;
    }
    if (now.startKey !== item.left.startKey) {
      // What was signalled has gone; the pid is another leftover's now.
      result.stopped.push({ pid: item.left.pid, command: item.left.command, signal: "SIGTERM", group: item.group });
      continue;
    }
    const group = now.groupOnly && now.pgid === item.left.pgid;
    try {
      kill(group ? -now.pgid : now.pid, "SIGKILL");
    } catch {}
    killed.push({ left: now, group });
  }
  const killDeadline = Date.now() + 1000;
  while (Date.now() < killDeadline && killed.some(({ left }) => exists(left.pid))) await sleep(50);
  let last: Map<number, Leftover> | undefined;
  if (killed.some(({ left }) => exists(left.pid))) {
    try {
      last = byPid(await scanLeftovers(options));
    } catch {}
  }
  for (const { left, group } of killed) {
    const still = exists(left.pid) ? last?.get(left.pid) : undefined;
    if (!exists(left.pid) || (still && still.startKey !== left.startKey)) result.stopped.push({ pid: left.pid, command: left.command, signal: "SIGKILL", group });
    else result.failed.push({ pid: left.pid, reason: still ? "still running after SIGKILL" : `${UNLISTED} (after SIGKILL)` });
  }
  return result;
}

/** How long ago, short: `45s`, `12m`, `3h`, `2d`. */
export function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

// --- What the agent and the stop prompt see of a command line ---

const REDACTED = "***";
/** `--token=…`, `--api-key=…`, `--client-secret=…`, `--password=…`: an option whose name looks secret, with its value after `=`. */
const SECRET_OPTION = /(--?[\w.-]*(?:token|key|secret|passw(?:or)?d|pwd)[\w.-]*=)\S+/gi;
/** The options that take a secret as the next word: `--password hunter2`. */
const SECRET_OPTION_WORD = /(^|\s)(--(?:password|passwd|token|secret|api-key|apikey|access-token|auth-token))(\s+)(?!-)\S+/gi;
/** `API_TOKEN=…` and the like, as `env` takes them. */
const SECRET_ASSIGNMENT = /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*=)\S+/g;
/** `Authorization: Bearer …`, `Basic …`, or a bare `Authorization: …`. */
const AUTH_SCHEME = /\b(Bearer|Basic)(\s+)[^\s'"]+/gi;
const AUTH_BARE = /(Authorization:\s*)(?!Bearer\b|Basic\b)[^\s'"]+/gi;
/** `scheme://user:password@host`. */
const URL_PASSWORD = /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;
/** mysql and its tools take the password glued to `-p`; elsewhere `-p…` is a port or a path. */
const MYSQL_LIKE = /(^|[\s/])(mysql[\w-]*|mariadb[\w-]*)(\s|$)/i;
const GLUED_PASSWORD = /(\s-p)\S+/g;

/** A command line with secret-looking values replaced by `***`, its shape kept (`--token=***`, `-p***`, `Bearer ***`). */
export function redactCommand(command: string): string {
  let out = command
    .replace(SECRET_OPTION, `$1${REDACTED}`)
    .replace(SECRET_OPTION_WORD, `$1$2$3${REDACTED}`)
    .replace(SECRET_ASSIGNMENT, `$1${REDACTED}`)
    .replace(AUTH_SCHEME, `$1$2${REDACTED}`)
    .replace(AUTH_BARE, `$1${REDACTED}`)
    .replace(URL_PASSWORD, `$1${REDACTED}@`);
  if (MYSQL_LIKE.test(out)) out = out.replace(GLUED_PASSWORD, `$1${REDACTED}`);
  return out;
}

/** One leftover on one line, for the agent and the stop prompt, its command redacted: `pid 4242 · 12m · 85.3 MB · node server.js (started by terminal bt-2)`. */
export function describeLeftover(left: Leftover, maxCommand = 160): string {
  const shown = redactCommand(left.command);
  const command = shown.length > maxCommand ? `${shown.slice(0, maxCommand - 1)}…` : shown;
  const from = left.bg ? ` (started by terminal ${left.bg})` : "";
  const yours = left.possiblyYours ? ` · possibly yours: ${left.possiblyYours}` : "";
  return `pid ${left.pid} · ${formatAge(left.ageMs)} · ${left.rssMb} MB · ${command || "(command unknown)"}${from}${yours}`;
}
