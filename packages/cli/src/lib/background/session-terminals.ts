import type { BackgroundHub } from "./hub";
import { buildTerminalResult } from "./terminal-prompt";
import { createTerminals, type BackgroundTerminals } from "./terminals";

const bySession = new WeakMap<BackgroundHub, BackgroundTerminals>();

/**
 * The background terminals of the session that owns `hub`, made on first use: the bg_* tools and `/ps` share them. A finished
 * terminal's result goes to the hub; quit stops the running ones through the hub's registry; the hub's dispose (leaving the
 * session) kills them and removes their logs.
 */
export function terminalsFor(hub: BackgroundHub): BackgroundTerminals {
  const existing = bySession.get(hub);
  if (existing) return existing;
  const terminals = createTerminals({
    onSettled: (snapshot) => hub.finish({ id: snapshot.id, kind: "terminal", title: snapshot.title, text: buildTerminalResult(snapshot) }),
    onChange: () => hub.changed(),
    registerTurn: (turn) => hub.registerTurn(turn),
  });
  bySession.set(hub, terminals);
  if (hub.disposed) void terminals.dispose();
  else hub.onDispose(() => terminals.dispose());
  return terminals;
}
