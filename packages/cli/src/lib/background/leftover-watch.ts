import { scanLeftovers, stopLeftovers, type Leftover, type LeftoverScanOptions, type StopResult, type StopTarget } from "./leftovers";

/** The status line reads the process table again at most this often on its own (`/ps` and a turn's end read it when they happen). */
export const LEFTOVER_SCAN_INTERVAL_MS = 30_000;

export type LeftoverWatch = {
  /** The leftovers the last scan found. */
  list(): readonly Leftover[];
  /** Scans again, unless the last scan is younger than the interval (`force` scans anyway). One scan at a time. */
  refresh(options?: { force?: boolean }): Promise<readonly Leftover[]>;
  /** Stops these leftovers (see `stopLeftovers`), then scans again. */
  stop(targets: readonly StopTarget[]): Promise<StopResult>;
  subscribe(listener: () => void): () => void;
};

export type LeftoverWatchOptions = {
  scan?: (options?: LeftoverScanOptions) => Promise<Leftover[]>;
  stop?: typeof stopLeftovers;
  intervalMs?: number;
  now?: () => number;
};

export function createLeftoverWatch({ scan = scanLeftovers, stop = stopLeftovers, intervalMs = LEFTOVER_SCAN_INTERVAL_MS, now = Date.now }: LeftoverWatchOptions = {}): LeftoverWatch {
  let current: readonly Leftover[] = [];
  let lastScan = Number.NEGATIVE_INFINITY;
  let inflight: Promise<readonly Leftover[]> | undefined;
  const listeners = new Set<() => void>();
  const set = (next: readonly Leftover[]) => {
    const same = next.length === current.length && next.every((left, at) => left.pid === current[at]!.pid && left.startedAt === current[at]!.startedAt);
    current = next;
    if (same) return;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {}
    }
  };
  const refresh = ({ force = false }: { force?: boolean } = {}) => {
    if (inflight) return inflight;
    if (!force && now() - lastScan < intervalMs) return Promise.resolve(current);
    lastScan = now();
    inflight = scan()
      .then((found) => (set(found), found), () => current)
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };
  return {
    list: () => current,
    refresh,
    async stop(targets) {
      try {
        return await stop(targets);
      } finally {
        await inflight;
        await refresh({ force: true });
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** This marcsh process's watch: the status line, `/ps` and the agent's proc tools share it. */
export const leftoverWatch = createLeftoverWatch();
