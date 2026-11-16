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

/** What runs: terminals alone keep `/ps`'s wording. */
function runningText(terminals: number, subagents: number): string {
  if (subagents <= 0) return runningTerminalsText(terminals);
  if (terminals <= 0) return `${count(subagents, "background subagent")} running · /subagents`;
  return `${count(terminals, "terminal")}, ${count(subagents, "subagent")} running · /ps /subagents`;
}

/**
 * The status line's segment while any terminal or subagent runs, or a leftover process is found (`2 leftover · /ps`, see
 * `leftovers.ts`); empty when there is none. `/ps` lists both terminals and leftovers, so it is named once.
 */
export function runningBackgroundText(terminals: number, subagents: number, leftovers = 0): string {
  const running = runningText(terminals, subagents);
  if (leftovers <= 0) return running;
  const left = `${leftovers} leftover`;
  if (running === "") return `${left} · /ps`;
  if (running.endsWith(" · /ps")) return `${running.slice(0, -" · /ps".length)} · ${left} · /ps`;
  if (running.endsWith(" · /ps /subagents")) return `${running.slice(0, -" · /ps /subagents".length)} · ${left} · /ps /subagents`;
  return `${running} · ${left} · /ps`;
}
