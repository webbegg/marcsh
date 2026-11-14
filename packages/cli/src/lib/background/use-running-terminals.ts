import { useCallback, useSyncExternalStore } from "react";
import type { BackgroundHub } from "./hub";
import { terminalsFor } from "./session-terminals";

/** How many of the session's background terminals are running, kept current (none without a hub). */
export function useRunningTerminals(hub: BackgroundHub | undefined): number {
  const subscribe = useCallback((listener: () => void) => (hub ? hub.subscribe(listener) : () => {}), [hub]);
  const read = useCallback(() => (hub && !hub.disposed ? terminalsFor(hub).running() : 0), [hub]);
  return useSyncExternalStore(subscribe, read, read);
}

/** The status line's segment while any terminal runs; empty when none does. */
export const runningTerminalsText = (count: number) => (count > 0 ? `${count} background terminal${count === 1 ? "" : "s"} running · /ps` : "");
