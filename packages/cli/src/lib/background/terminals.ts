import { spawn, type ChildProcess } from "node:child_process";
import type { QuitTurn } from "../quit";
import { createLogDir, MAX_LOG_BYTES_PER_STREAM, openLog, OutputBuffer, RETAINED_PER_STREAM, sweepStaleLogDirs, type LogFile, type OutputView } from "./output";

/**
 * Background terminals: shell commands the model starts and that keep running after the tool call returns. Each runs with
 * `/bin/sh -c` in its own process group with no stdin; its stdout and stderr are captured apart (see `output.ts`). It settles
 * once, when its output pipes close, so the result has all of it. Killing sends SIGTERM to the whole group, then SIGKILL after
 * a grace. Ported from davi7's `extensions/background-terminals/src/manager.ts` and `src/domain.ts` (MIT license; see
 * THIRD_PARTY_NOTICES.md), in plain TypeScript without its Effect runtime.
 */

export const MAX_RUNNING = 8;
export const MAX_TRACKED = 32;
/** SIGTERM is normally enough; SIGKILL follows for a process that ignores it. Under quit's 5 s grace. */
export const FORCE_KILL_AFTER_MS = 2_000;
/** After the shell exited, or after SIGKILL, how long the pipes may stay open (a descendant holds them) before it is settled anyway. */
const SETTLE_GRACE_MS = 1_000;
/** A hung filesystem must not keep a finished terminal "running". */
const LOG_FLUSH_TIMEOUT_MS = 1_500;
/** The longest dispose waits for the processes it killed. */
const DISPOSE_TIMEOUT_MS = 5_000;
/** The longest a start waits to learn whether the process spawned (it normally knows within milliseconds). */
const SPAWN_WAIT_MS = 2_000;
const ERROR_MAX = 4_096;

/** done = exit code 0; failed = another exit code, a signal it did not get from marcsh, or no start; killed = stopped by marcsh. */
export type TerminalStatus = "running" | "done" | "failed" | "killed";

export type TerminalSnapshot = {
  readonly id: string;
  /** Exactly the command the model asked to run. */
  readonly command: string;
  readonly title: string;
  readonly cwd: string;
  readonly pid?: number;
  readonly status: TerminalStatus;
  readonly createdAt: number;
  readonly settledAt?: number;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly errorText?: string;
  readonly stdout: OutputView;
  readonly stderr: OutputView;
  /** Changes whenever either stream gets output. */
  readonly outputVersion: number;
};

export type KillResult = {
  id: string;
  title: string;
  status: TerminalStatus;
  /** It was running when this kill began. */
  wasRunning: boolean;
  /** This kill stopped it (a natural exit that won the race is not). */
  killed: boolean;
  exit: string;
};

export type StartOptions = { command: string; title: string; cwd: string };

export type TerminalsOptions = {
  /** A terminal settled on its own or from the UI (not one a `kill` call is collecting), while not disposed. */
  onSettled?: (snapshot: TerminalSnapshot) => void;
  /** Started, settled, pruned or disposed: the list changed (output does not count). */
  onChange?: () => void;
  /** Quit's registry: each running terminal is stopped on quit, which waits for it. Default: none. */
  registerTurn?: (turn: QuitTurn) => () => void;
  /** Where the log directory goes. Default: the OS temp dir. */
  logBase?: string;
  forceKillAfterMs?: number;
  retainedBytes?: number;
  maxLogBytes?: number;
};

export type BackgroundTerminals = {
  /**
   * Starts a terminal once its process has spawned; rejects when at the running cap, disposed, or the process cannot start
   * (a folder that is gone or not searchable). A start that fails is not kept, and its result is never announced.
   */
  start(options: StartOptions): Promise<TerminalSnapshot>;
  get(id: string): TerminalSnapshot | undefined;
  /** Oldest first. */
  list(): TerminalSnapshot[];
  running(): number;
  /** Stops these terminals and resolves once they have settled; their results are this call's to report, not announced. */
  kill(ids: readonly string[]): Promise<KillResult[]>;
  /** Stops a terminal without waiting (the `/ps` `x` key); its result is announced like a natural exit. */
  requestKill(id: string): void;
  /** Resolves when the terminal has settled (at once for a settled or unknown id). */
  settled(id: string): Promise<void>;
  /** Called on every change, output included. */
  subscribe(listener: () => void): () => void;
  readonly logDir: string | undefined;
  /** Kills everything, waits (bounded) for it, and removes the logs. */
  dispose(): Promise<void>;
  readonly disposed: boolean;
};

export function formatElapsed(snapshot: Pick<TerminalSnapshot, "createdAt" | "settledAt">, now = Date.now()): string {
  const total = Math.max(0, Math.round(((snapshot.settledAt ?? now) - snapshot.createdAt) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

/** "exit 0", "SIGTERM", or the status when neither is known. */
export function formatExit(snapshot: Pick<TerminalSnapshot, "status" | "signal" | "exitCode">): string {
  if (snapshot.status === "running") return "running";
  if (snapshot.signal) return snapshot.signal;
  if (snapshot.exitCode !== undefined) return `exit ${snapshot.exitCode}`;
  return snapshot.status;
}

const bounded = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, ERROR_MAX);

type Mutable = { -readonly [K in keyof TerminalSnapshot]: TerminalSnapshot[K] };

type Entry = {
  snapshot: Mutable;
  child: ChildProcess;
  logs: LogFile[];
  /** marcsh signalled it while it was still running: it settles as killed. */
  killSignaled: boolean;
  processErrored: boolean;
  /** The process spawned ('spawn' came). */
  spawned: boolean;
  /** It failed before it spawned: the start reports it, so its settle is not announced. */
  startFailed: boolean;
  exited: boolean;
  /** Its output pipes closed: the settle trigger. */
  closed: boolean;
  terminating: boolean;
  settling: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
  settled: Promise<void>;
  resolveSettled: () => void;
  unregister: () => void;
};

/** Signals the whole process group, so what the command started goes too; the shell alone when the group is gone. */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  try {
    child.kill(signal);
  } catch {}
}

/** Bases already swept for the logs of a marcsh that did not exit normally: once per process is enough. */
const swept = new Set<string>();

/** Its pipes are not read any more: what a descendant that left the group still writes goes nowhere. */
function releasePipes(child: ChildProcess) {
  for (const stream of [child.stdout, child.stderr]) {
    try {
      stream?.removeAllListeners("data");
      stream?.destroy();
    } catch {}
  }
}

export function createTerminals({
  onSettled,
  onChange,
  registerTurn = () => () => {},
  logBase,
  forceKillAfterMs = FORCE_KILL_AFTER_MS,
  retainedBytes = RETAINED_PER_STREAM,
  maxLogBytes = MAX_LOG_BYTES_PER_STREAM,
}: TerminalsOptions = {}): BackgroundTerminals {
  const entries = new Map<string, Entry>();
  /** Ids a `kill` call is collecting: their settle is that call's to report. */
  const collecting = new Map<string, number>();
  const listeners = new Set<() => void>();
  if (!swept.has(logBase ?? "")) {
    swept.add(logBase ?? "");
    sweepStaleLogDirs(logBase);
  }
  const logDir = createLogDir(logBase);
  let counter = 0;
  let disposed = false;

  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {}
    }
  };
  const changed = () => {
    notify();
    try {
      onChange?.();
    } catch {}
  };

  const running = () => [...entries.values()].filter((entry) => entry.snapshot.status === "running").length;

  const later = (entry: Entry, ms: number, fn: () => void) => {
    const timer = setTimeout(() => {
      entry.timers.delete(timer);
      fn();
    }, ms);
    entry.timers.add(timer);
  };

  const prune = () => {
    if (entries.size <= MAX_TRACKED) return;
    const candidates = [...entries.values()]
      .filter((entry) => entry.snapshot.status !== "running" && !collecting.has(entry.snapshot.id))
      .sort((a, b) => (a.snapshot.settledAt ?? a.snapshot.createdAt) - (b.snapshot.settledAt ?? b.snapshot.createdAt));
    for (const entry of candidates) {
      if (entries.size <= MAX_TRACKED) break;
      entries.delete(entry.snapshot.id);
      // Forgotten terminals keep no logs on disk.
      for (const log of entry.logs) void log.remove();
    }
  };

  const settle = (entry: Entry) => {
    const snapshot = entry.snapshot;
    if (snapshot.status !== "running") return;
    snapshot.settledAt = Date.now();
    snapshot.status = entry.killSignaled ? "killed" : entry.processErrored ? "failed" : snapshot.exitCode === 0 ? "done" : "failed";
    for (const timer of entry.timers) clearTimeout(timer);
    entry.timers.clear();
    // Settled while a descendant still holds the pipes: stop reading them.
    if (!entry.closed) releasePipes(entry.child);
    entry.unregister();
    entry.resolveSettled();
    if (!disposed && !collecting.has(snapshot.id) && !entry.startFailed) {
      try {
        onSettled?.(snapshot);
      } catch {}
    }
    prune();
    changed();
  };

  /** The logs are flushed first: the result points at them. */
  const settleAfterFlush = (entry: Entry) => {
    if (entry.settling || entry.snapshot.status !== "running") return;
    entry.settling = true;
    const flushed = Promise.all(entry.logs.map((log) => log.end()));
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, LOG_FLUSH_TIMEOUT_MS).unref?.());
    void Promise.race([flushed, timeout]).then(() => settle(entry));
  };

  /** SIGTERM to the group, SIGKILL after the grace, then settled anyway if a descendant outside the group still holds the pipes. */
  const terminate = (entry: Entry) => {
    if (entry.closed || entry.terminating || entry.snapshot.status !== "running") return;
    entry.terminating = true;
    // A natural exit that already happened (its pipes still open) keeps its own status.
    entry.killSignaled ||= !entry.exited;
    signalGroup(entry.child, "SIGTERM");
    later(entry, forceKillAfterMs, () => {
      if (entry.closed) return;
      signalGroup(entry.child, "SIGKILL");
      later(entry, SETTLE_GRACE_MS, () => {
        if (entry.closed) return;
        entry.snapshot.errorText ??= "Its output did not close after it was stopped; the output may be incomplete.";
        settleAfterFlush(entry);
      });
    });
  };

  const start = async ({ command, title, cwd }: StartOptions): Promise<TerminalSnapshot> => {
    if (disposed) throw new Error("Background terminals are shutting down.");
    if (running() >= MAX_RUNNING) {
      throw new Error(`At most ${MAX_RUNNING} background terminals can run at once. Stop one with bg_kill before starting another.`);
    }
    let child: ChildProcess;
    try {
      // No stdin, ever: a process that reads it gets EOF. Its own process group, so a kill takes what it started.
      child = spawn("/bin/sh", ["-c", command], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (error) {
      throw new Error(`The command could not be started: ${bounded(error)}`);
    }

    const id = `bt-${++counter}`;
    const log = (stream: "stdout" | "stderr") => {
      const path = logDir.file(`${id}.${stream}.log`);
      return path ? openLog(path, { maxBytes: maxLogBytes, onDrain: () => child[stream]?.resume() }) : undefined;
    };
    const stdoutLog = log("stdout");
    const stderrLog = log("stderr");
    const stdout = new OutputBuffer(retainedBytes, stdoutLog);
    const stderr = new OutputBuffer(retainedBytes, stderrLog);
    let resolveSettled = () => {};
    const settled = new Promise<void>((resolve) => (resolveSettled = resolve));
    const snapshot: Mutable = {
      id,
      command,
      title,
      cwd,
      pid: child.pid,
      status: "running",
      createdAt: Date.now(),
      get stdout() {
        return stdout.view();
      },
      get stderr() {
        return stderr.view();
      },
      get outputVersion() {
        return stdout.version + stderr.version;
      },
    };
    const entry: Entry = {
      snapshot,
      child,
      logs: [stdoutLog, stderrLog].filter((file): file is LogFile => file !== undefined),
      killSignaled: false,
      processErrored: false,
      spawned: false,
      startFailed: false,
      exited: false,
      closed: false,
      terminating: false,
      settling: false,
      timers: new Set(),
      settled,
      resolveSettled,
      unregister: () => {},
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (!stdout.push(chunk)) child.stdout?.pause();
      notify();
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (!stderr.push(chunk)) child.stderr?.pause();
      notify();
    });
    child.once("spawn", () => {
      entry.spawned = true;
    });
    // A failed start arrives as 'error'; 'close' may follow, and the one settle happens once the logs are flushed.
    child.once("error", (error) => {
      if (!entry.spawned) entry.startFailed = true;
      entry.processErrored = true;
      entry.exited = true;
      snapshot.errorText ??= bounded(error);
      settleAfterFlush(entry);
    });
    child.once("exit", (code, signal) => {
      entry.exited = true;
      snapshot.exitCode = code ?? undefined;
      snapshot.signal = signal ?? undefined;
      // A descendant may keep the pipes open after the shell is gone: give them a moment, then stop the group.
      later(entry, SETTLE_GRACE_MS, () => {
        if (!entry.closed) terminate(entry);
      });
    });
    child.once("close", (code, signal) => {
      entry.exited = true;
      entry.closed = true;
      if (!entry.processErrored) {
        snapshot.exitCode ??= code ?? undefined;
        snapshot.signal ??= signal ?? undefined;
      }
      settleAfterFlush(entry);
    });

    // Kept while it spawns, so it counts towards the running cap; listed once it has spawned.
    entries.set(id, entry);
    entry.unregister = registerTurn({ stop: () => terminate(entry), done: settled });
    const failure = await new Promise<Error | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), SPAWN_WAIT_MS);
      child.once("spawn", () => (clearTimeout(timer), resolve(undefined)));
      child.once("error", (error) => (clearTimeout(timer), resolve(error)));
    });
    if (failure && entry.startFailed) {
      // The start reports it: not kept, not announced (see `settle`), and no log stays behind.
      entries.delete(id);
      for (const file of entry.logs) void file.remove();
      throw new Error(`The command could not be started: ${bounded(failure)}`);
    }
    changed();
    return snapshot;
  };

  const kill = async (ids: readonly string[]): Promise<KillResult[]> => {
    const unique = [...new Set(ids)];
    const known = unique.map((id) => entries.get(id)).filter((entry): entry is Entry => entry !== undefined);
    const live = known.filter((entry) => entry.snapshot.status === "running");
    const liveIds = new Set(live.map((entry) => entry.snapshot.id));
    for (const id of liveIds) collecting.set(id, (collecting.get(id) ?? 0) + 1);
    try {
      for (const entry of live) terminate(entry);
      await Promise.all(live.map((entry) => entry.settled));
      return known.map(({ snapshot }) => ({
        id: snapshot.id,
        title: snapshot.title,
        status: snapshot.status,
        wasRunning: liveIds.has(snapshot.id),
        killed: liveIds.has(snapshot.id) && snapshot.status === "killed",
        exit: formatExit(snapshot),
      }));
    } finally {
      for (const id of liveIds) {
        const count = (collecting.get(id) ?? 1) - 1;
        if (count <= 0) collecting.delete(id);
        else collecting.set(id, count);
      }
      prune();
    }
  };

  return {
    start,
    get: (id) => entries.get(id)?.snapshot,
    list: () => [...entries.values()].map((entry) => entry.snapshot),
    running,
    kill,
    requestKill(id) {
      const entry = entries.get(id);
      if (entry) terminate(entry);
    },
    settled: (id) => entries.get(id)?.settled ?? Promise.resolve(),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    get logDir() {
      return logDir.path;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const all = [...entries.values()];
      for (const entry of all) terminate(entry);
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, DISPOSE_TIMEOUT_MS).unref?.());
      await Promise.race([Promise.all(all.map((entry) => entry.settled)), timeout]);
      for (const entry of all) {
        entry.unregister();
        releasePipes(entry.child);
      }
      try {
        logDir.dispose();
      } catch {}
      changed();
      listeners.clear();
    },
    get disposed() {
      return disposed;
    },
  };
}
