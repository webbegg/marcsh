import type { BackgroundHub } from "./hub";
import { buildSubagentResult, createSubagents, type BackgroundSubagents } from "./subagents";

const bySession = new WeakMap<BackgroundHub, BackgroundSubagents>();

/**
 * The background subagents of the session that owns `hub`, made on first use: the task_* tools and `/subagents` share them. A
 * settled subagent's result goes to the hub; quit stops the running ones through the hub's registry; the hub's dispose (leaving
 * the session) stops them all.
 */
export function subagentsFor(hub: BackgroundHub): BackgroundSubagents {
  const existing = bySession.get(hub);
  if (existing) return existing;
  const subagents = createSubagents({
    onSettled: (snapshot) => hub.finish({ id: snapshot.id, kind: "subagent", title: snapshot.description, text: buildSubagentResult(snapshot) }),
    onChange: () => hub.changed(),
    registerTurn: (turn) => hub.registerTurn(turn),
  });
  bySession.set(hub, subagents);
  if (hub.disposed) void subagents.dispose();
  else hub.onDispose(() => subagents.dispose());
  return subagents;
}
