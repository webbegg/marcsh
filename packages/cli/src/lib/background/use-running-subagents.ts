import { useCallback, useSyncExternalStore } from "react";
import type { BackgroundHub } from "./hub";
import { subagentsFor } from "./session-subagents";
import { runningTerminalsText } from "./use-running-terminals";

/** How many of the session's background subagents are running, kept current (none without a hub). */
export function useRunningSubagents(hub: BackgroundHub | undefined): number {
  const subscribe = useCallback((listener: () => void) => (hub ? hub.subscribe(listener) : () => {}), [hub]);
  const read = useCallback(() => (hub && !hub.disposed ? subagentsFor(hub).running() : 0), [hub]);
  return useSyncExternalStore(subscribe, read, read);
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** The status line's segment while any terminal or subagent runs; empty when none does. Terminals alone keep `/ps`'s wording. */
export function runningBackgroundText(terminals: number, subagents: number): string {
  if (subagents <= 0) return runningTerminalsText(terminals);
  if (terminals <= 0) return `${count(subagents, "background subagent")} running · /subagents`;
  return `${count(terminals, "terminal")}, ${count(subagents, "subagent")} running · /ps /subagents`;
}
