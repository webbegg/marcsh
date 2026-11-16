import { scanLeftovers, stopLeftovers, type Leftover, type LeftoverScanOptions, type StopResult, type StopTarget } from "./leftovers";

/** The status line reads the process table again at most this often on its own (`/ps` and a turn's end read it when they happen). */
export const LEFTOVER_SCAN_INTERVAL_MS = 30_000;

export type LeftoverWatch = {
  /** The leftovers the last scan that worked found. */
  list(): readonly Leftover[];
  /** Why the last scan failed (the list is then older than it), or undefined when it worked. */
  scanError(): string | undefined;
  /** Scans again, unless the last scan is younger than the interval (`force` scans anyway). One scan at a time. Never rejects: see `scanError`. */
  refresh(options?: { force?: boolean }): Promise<readonly Leftover[]>;
  /** How long until the next unforced scan is due: an interval after the last scan, forced or not. */
  nextScanIn(): number;
  /** Stops these leftovers (see `stopLeftovers`), then scans again. Rejects when the first read of the table failed. */
  stop(targets: readonly StopTarget[], options?: { signal?: AbortSignal }): Promise<StopResult>;
  /** Automatic scans start once marcsh may have started a tool process in this run (`useLeftoverCount` arms it when a turn starts). */
  arm(): void;
  armed(): boolean;
  subscribe(listener: () => void): () => void;
};

export type LeftoverWatchOptions = {
  scan?: (options?: LeftoverScanOptions) => Promise<Leftover[]>;
  stop?: (targets: readonly StopTarget[], options?: { signal?: AbortSignal }) => Promise<StopResult>;
  intervalMs?: number;
  now?: () => number;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)) || "unknown error";

export function createLeftoverWatch({
  scan = scanLeftovers,
  stop = stopLeftovers,
  intervalMs = LEFTOVER_SCAN_INTERVAL_MS,
  now = Date.now,
}: LeftoverWatchOptions = {}): LeftoverWatch {
  let current: readonly Leftover[] = [];
  let failure: string | undefined;
  let lastScan = Number.NEGATIVE_INFINITY;
  let inflight: Promise<readonly Leftover[]> | undefined;
  let isArmed = false;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {}
    }
  };
  const set = (next: readonly Leftover[]) => {
    const same =
      failure === undefined &&
      next.length === current.length &&
      next.every((left, at) => left.pid === current[at]!.pid && left.startKey === current[at]!.startKey && left.possiblyYours === current[at]!.possiblyYours);
    current = next;
    failure = undefined;
    if (!same) notify();
  };
  const fail = (error: unknown) => {
    const next = errorText(error);
    const changed = next !== failure;
    failure = next;
    if (changed) notify();
  };
  const refresh = ({ force = false }: { force?: boolean } = {}) => {
    if (inflight) return inflight;
    if (!force && now() - lastScan < intervalMs) return Promise.resolve(current);
    lastScan = now();
    inflight = scan()
      .then(
        (found) => (set(found), current),
        (error) => (fail(error), current),
      )
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };
  return {
    list: () => current,
    scanError: () => failure,
    refresh,
    nextScanIn: () => Math.max(0, lastScan + intervalMs - now()),
    async stop(targets, options) {
      try {
        return await stop(targets, options);
      } finally {
        await inflight;
        await refresh({ force: true });
      }
    },
    arm: () => {
      isArmed = true;
    },
    armed: () => isArmed,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** This marcsh process's watch: the status line, `/ps` and the agent's proc tools share it. */
export const leftoverWatch = createLeftoverWatch();
