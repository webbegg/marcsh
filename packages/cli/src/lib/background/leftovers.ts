import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { sanitizeText } from "./output";
import { SESSION_ENV, sessionMarker, type SessionMarker } from "./session-marker";
import { runningTerminalGroups } from "./terminals";

export { clearSessionMarker, SESSION_ENV, sessionMarker, startSessionMarker, type SessionMarker } from "./session-marker";

/**
 * Leftover processes: what this marcsh run's tools started that is still running on its own after the tool call (or background
 * terminal) that started it ended, such as a dev server started with `cmd &`, a browser Playwright left open, or a watcher.
 *
 * How they are told apart from everything else: at startup marcsh puts a fresh `MARCSH_SESSION=<uuid>` in its own environment, and
 * every process it starts inherits it (pi's `bash`, `bg_start` terminals, subagents' tools, the Claude CLI and its Bash). The
 * environment a process started with is readable by its owner (`ps -E` on macOS, `/proc/<pid>/environ` on Linux), so a process
 * carrying this run's marker was started by this run and nothing else: the user's own processes never carry it, and nothing is
 * matched by name or folder. A leftover is such a process that:
 *  - started at or after the marker was made (a reused pid cannot match),
 *  - is no longer under marcsh's own process: anything still under it is a running tool call, a background terminal, or marcsh's
 *    infrastructure (the Claude CLI, MCP servers, pack hooks), all of which have an owner,
 *  - is not marked `MARCSH_INFRA=1` (what marcsh starts for itself, such as pack hooks, even once orphaned),
 *  - is not in the group of a running background terminal (`/ps` shows it there).
 *
 * What cannot be seen: a process started with an emptied environment (`env -i`) or one that clears its own, setuid programs,
 * processes started through launchd or a daemon (`open -a`, `docker run`, `brew services`), and on macOS Apple's own binaries
 * (`/bin/sleep`, `/usr/bin/python3`...), whose environment `ps -E` does not show.
 */

/** The tool call that started the process, when marcsh knows it. */
export const CALL_ENV = "MARCSH_CALL";
/** The background terminal (`bt-3`) that started the process. */
export const BG_ENV = "MARCSH_BG";
/** Set to `1` on what marcsh starts for itself (pack hooks): never a leftover. */
export const INFRA_ENV = "MARCSH_INFRA";

/** One process as the platform's process table shows it. */
export type ProcessEntry = {
  pid: number;
  ppid: number;
  pgid: number;
  /** When it started (epoch ms; whole seconds on macOS). */
  startedAt: number;
  rssKb: number;
  /** Its environment holds this run's marker. False when its environment could not be read. */
  marked: boolean;
  call?: string;
  bg?: string;
  infra?: boolean;
  /** Its command line, read only for marked processes; never its environment. */
  command?: string;
};

/** Reads the process table, with `marked` and the marcsh variables worked out for `session` (the marker's value). */
export type ProcessReader = (session: string) => Promise<ProcessEntry[]>;

export type Leftover = {
  pid: number;
  pgid: number;
  startedAt: number;
  ageMs: number;
  rssMb: number;
  /** One line, control characters removed, at most 300 characters. Still escape it for the screen. */
  command: string;
  call?: string;
  bg?: string;
  /** Every process in its group is a leftover of this run, so stopping the group stops nothing else. */
  groupOnly: boolean;
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
    .map((entry) => ({
      pid: entry.pid,
      pgid: entry.pgid,
      startedAt: entry.startedAt,
      ageMs: Math.max(0, now - entry.startedAt),
      rssMb: Math.round((entry.rssKb / 1024) * 10) / 10,
      command: cleanCommand(entry.command),
      ...(entry.call ? { call: entry.call } : {}),
      ...(entry.bg ? { bg: entry.bg } : {}),
      groupOnly: groupOnly(entry.pgid),
    }))
    .sort((a, b) => b.startedAt - a.startedAt || b.pid - a.pid);
}

// --- macOS: `ps` ---

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s+(\d+)\s(.*)$/;

/** One line of `ps -o pid=,ppid=,pgid=,lstart=,rss=,command=` (C locale, and UTC: `Sun Nov  5 09:03:07 2026`). */
export function parsePsLine(line: string): { pid: number; ppid: number; pgid: number; startedAt: number; rssKb: number; rest: string } | undefined {
  const match = PS_LINE.exec(line);
  if (!match) return undefined;
  const [, pid, ppid, pgid, month, day, hour, minute, second, year, rss, rest] = match;
  const monthIndex = MONTHS.indexOf(month!);
  if (monthIndex === -1) return undefined;
  const startedAt = Date.UTC(Number(year), monthIndex, Number(day), Number(hour), Number(minute), Number(second));
  return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), startedAt, rssKb: Number(rss), rest: rest! };
}

/**
 * stdout of a command run in the C locale and in UTC (so `lstart` reads the same whatever time zone marcsh and the command were given);
 * a non-zero exit still gives what it printed (`ps -p` with a pid that has gone).
 */
function capture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, maxBuffer: 128 * 1024 * 1024, timeout: 15_000 }, (error, stdout) => {
      if (error && typeof (error as NodeJS.ErrnoException).code !== "number" && !stdout) reject(error);
      else resolve(String(stdout ?? ""));
    });
  });
}

const lastValue = (text: string, name: string): string | undefined => {
  let found: string | undefined;
  for (const match of text.matchAll(new RegExp(`(?:^|\\s)${name}=(\\S*)`, "g"))) found = match[1];
  return found;
};

/**
 * One `ps -E` for the whole table (pid, parent, group, start, memory, and the command with the environment after it), then, only for
 * the lines that hold the marker, one `ps` without `-E` for their command alone: the environment is what comes after it, so a
 * command line that merely names the marker is not taken for it, and the environment is never shown.
 */
export const readPsProcesses: ProcessReader = async (session) => {
  const table = await capture("ps", ["-A", "-ww", "-E", "-o", "pid=,ppid=,pgid=,lstart=,rss=,command="]);
  const token = `${SESSION_ENV}=${session}`;
  const rows = table.split("\n").flatMap((line) => {
    const row = parsePsLine(line);
    return row ? [row] : [];
  });
  const maybe = rows.filter((row) => row.rest.includes(token));
  const commands = new Map<number, string>();
  if (maybe.length > 0) {
    const out = await capture("ps", ["-ww", "-o", "pid=,command=", "-p", maybe.map((row) => row.pid).join(",")]);
    for (const line of out.split("\n")) {
      const match = /^\s*(\d+)\s(.*)$/.exec(line);
      if (match) commands.set(Number(match[1]), match[2]!);
    }
  }
  return rows.map((row) => {
    const base = { pid: row.pid, ppid: row.ppid, pgid: row.pgid, startedAt: row.startedAt, rssKb: row.rssKb };
    const command = commands.get(row.pid);
    if (command === undefined || !row.rest.startsWith(command)) return { ...base, marked: false };
    const env = row.rest.slice(command.length);
    if (lastValue(env, SESSION_ENV) !== session) return { ...base, marked: false };
    const call = lastValue(env, CALL_ENV);
    const bg = lastValue(env, BG_ENV);
    return { ...base, marked: true, command, ...(call ? { call } : {}), ...(bg ? { bg } : {}), ...(lastValue(env, INFRA_ENV) === "1" ? { infra: true } : {}) };
  });
};

// --- Linux: `/proc` ---

/** `/proc/<pid>/stat`: the name (field 2) is in parentheses and may hold anything, so the fields are counted from its last `)`. */
export function parseProcStat(text: string): { pid: number; ppid: number; pgid: number; startTicks: number; rssPages: number } | undefined {
  const close = text.lastIndexOf(")");
  if (close === -1) return undefined;
  const pid = Number.parseInt(text, 10);
  // From field 3 (state) on.
  const fields = text.slice(close + 2).trim().split(/\s+/);
  const at = (field: number) => Number(fields[field - 3]);
  const parsed = { pid, ppid: at(4), pgid: at(5), startTicks: at(22), rssPages: at(24) };
  return Object.values(parsed).every(Number.isFinite) ? parsed : undefined;
}

/** Clock ticks per second in `/proc` (USER_HZ, 100 on Linux's user interface). */
const USER_HZ = 100;
const PAGE_KB = 4;

/** Only the numeric directories of `/proc` are read: each one's `stat`, its `environ` (readable for the user's own), and the command line of marked ones. */
export const readProcProcesses: ProcessReader = async (session) => {
  const bootSeconds = Number(/^btime\s+(\d+)$/m.exec(await readFile("/proc/stat", "utf8"))?.[1]);
  const names = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  const token = `${SESSION_ENV}=${session}`;
  const entries = await Promise.all(
    names.map(async (name): Promise<ProcessEntry | undefined> => {
      let stat: ReturnType<typeof parseProcStat>;
      try {
        stat = parseProcStat(await readFile(`/proc/${name}/stat`, "utf8"));
      } catch {
        return undefined;
      }
      if (!stat || !Number.isFinite(bootSeconds)) return undefined;
      const base = { pid: stat.pid, ppid: stat.ppid, pgid: stat.pgid, startedAt: (bootSeconds + stat.startTicks / USER_HZ) * 1000, rssKb: stat.rssPages * PAGE_KB };
      let vars: string[];
      try {
        vars = (await readFile(`/proc/${name}/environ`, "utf8")).split("\0");
      } catch {
        return { ...base, marked: false };
      }
      if (!vars.includes(token)) return { ...base, marked: false };
      const value = (key: string) => vars.findLast((entry) => entry.startsWith(`${key}=`))?.slice(key.length + 1);
      let command = "";
      try {
        command = (await readFile(`/proc/${name}/cmdline`, "utf8")).split("\0").filter(Boolean).join(" ");
      } catch {}
      const call = value(CALL_ENV);
      const bg = value(BG_ENV);
      return { ...base, marked: true, command, ...(call ? { call } : {}), ...(bg ? { bg } : {}), ...(value(INFRA_ENV) === "1" ? { infra: true } : {}) };
    }),
  );
  return entries.filter((entry): entry is ProcessEntry => entry !== undefined);
};

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
};

/** This run's leftover processes, newest first (one read of the process table). */
export async function scanLeftovers(options: LeftoverScanOptions = {}): Promise<Leftover[]> {
  const session = "session" in options ? options.session : sessionMarker();
  if (!session) return [];
  const entries = await (options.read ?? platformReader())(session.id);
  return findLeftovers(entries, {
    since: session.since,
    selfPid: options.selfPid ?? process.pid,
    excludeGroups: options.excludeGroups ?? runningTerminalGroups(),
    now: (options.now ?? Date.now)(),
  });
}

/** A pid to stop, with the start time it was listed with when known: a pid that now belongs to a process started at another time is left alone. */
export type StopTarget = number | { pid: number; startedAt?: number };

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

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Stops leftover processes of this run. The process table is read again first, and each pid is signalled only if it is still one of
 * this run's leftovers (marker, start time, not under marcsh) and, when the caller gave one, started when it was listed. SIGTERM goes
 * to the process, or to its whole group when every process in the group is a leftover of this run; what is still there after the grace
 * gets SIGKILL, after the same check once more. Nothing else is ever signalled.
 */
export async function stopLeftovers(targets: readonly StopTarget[], options: StopOptions = {}): Promise<StopResult> {
  const { graceMs = 2000, kill = (pid, signal) => process.kill(pid, signal), exists = pidExists } = options;
  const result: StopResult = { stopped: [], failed: [] };
  const wanted = new Map<number, number | undefined>();
  for (const target of targets) {
    const pid = typeof target === "number" ? target : target.pid;
    if (!Number.isInteger(pid) || wanted.has(pid)) continue;
    wanted.set(pid, typeof target === "number" ? undefined : target.startedAt);
  }
  if (wanted.size === 0) return result;

  const before = new Map((await scanLeftovers(options)).map((left) => [left.pid, left]));
  const sent: Array<{ left: Leftover; group: boolean }> = [];
  for (const [pid, startedAt] of wanted) {
    const left = before.get(pid);
    if (!left) {
      result.failed.push({ pid, reason: NOT_LEFTOVER });
      continue;
    }
    if (startedAt !== undefined && startedAt !== left.startedAt) {
      result.failed.push({ pid, reason: REUSED });
      continue;
    }
    const group = left.groupOnly;
    try {
      kill(group ? -left.pgid : left.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        result.failed.push({ pid, reason: `could not be signalled: ${(error as Error).message}` });
        continue;
      }
    }
    sent.push({ left, group });
  }
  if (sent.length === 0) return result;

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && sent.some(({ left }) => exists(left.pid))) await sleep(Math.min(100, Math.max(1, deadline - Date.now())));

  const remaining = sent.filter(({ left }) => exists(left.pid));
  const termed = sent.filter((item) => !remaining.includes(item));
  for (const { left, group } of termed) result.stopped.push({ pid: left.pid, command: left.command, signal: "SIGTERM", group });
  if (remaining.length === 0) return result;

  // Checked again: in the grace the process may have gone and its pid been given to another.
  const again = new Map((await scanLeftovers(options)).map((left) => [left.pid, left]));
  const killed: Array<{ left: Leftover; group: boolean }> = [];
  for (const item of remaining) {
    const now = again.get(item.left.pid);
    if (!now || now.startedAt !== item.left.startedAt) {
      // What was signalled has gone; the pid is someone else's now.
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
  const last = killed.some(({ left }) => exists(left.pid)) ? new Map((await scanLeftovers(options)).map((left) => [left.pid, left])) : undefined;
  for (const { left, group } of killed) {
    const still = last?.get(left.pid);
    if (still && still.startedAt === left.startedAt) result.failed.push({ pid: left.pid, reason: "still running after SIGKILL" });
    else result.stopped.push({ pid: left.pid, command: left.command, signal: "SIGKILL", group });
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

/** One leftover on one line, for the agent: `pid 4242 · 12m · 85.3 MB · node server.js (bt-2)`. */
export function describeLeftover(left: Leftover, maxCommand = 160): string {
  const command = left.command.length > maxCommand ? `${left.command.slice(0, maxCommand - 1)}…` : left.command;
  const from = [left.bg ? `terminal ${left.bg}` : undefined, left.call ? `call ${left.call}` : undefined].filter(Boolean).join(", ");
  return `pid ${left.pid} · ${formatAge(left.ageMs)} · ${left.rssMb} MB · ${command || "(command unknown)"}${from ? ` (started by ${from})` : ""}`;
}
