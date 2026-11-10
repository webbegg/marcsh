import { useReducer, useRef } from "react";
import { useRenderer } from "@opentui/react";

// A prompt that opens while the user is composing text (typing a steer during a pi turn) must not be answered by the
// words they go on typing: they cannot tell that the keys stopped going to the input. Such a prompt opens locked, and
// only ↓ unlocks it. The input bar feeds this module; a prompt reads it once, when it opens.

/** What a locked prompt says under its (dim) key hints. */
export const LOCKED_LINE = "you were typing: press ↓ to answer";

/** A key typed in the input this recently means the user is composing. */
export const COMPOSING_MS = 2000;

type Composing = { lastKeyAt: number; draft: boolean; input: object | null };

// One state per screen (renderer), so nothing carries over between screens.
const states = new WeakMap<object, Composing>();

const stateOf = (owner: object): Composing => {
  let state = states.get(owner);
  if (!state) states.set(owner, (state = { lastKeyAt: -Infinity, draft: false, input: null }));
  return state;
};

/** The input took a key. */
export function noteKeyActivity(owner: object, now = Date.now()) {
  stateOf(owner).lastKeyAt = now;
}

/** Sending the text ends the composing: the Enter that sent it is not typing. */
export function clearKeyActivity(owner: object) {
  stateOf(owner).lastKeyAt = -Infinity;
}

/** Whether the input holds text. */
export function setDraft(owner: object, hasDraft: boolean) {
  stateOf(owner).draft = hasDraft;
}

/**
 * An input bar mounted, already holding text or not. Keys can reach a new bar before its mount effects run (the hand-off
 * from the home screen), so the draft comes from the bar's content and the recent keys stay. The returned `detach` (its
 * unmount) clears the state only if no newer bar attached since: an old bar unmounting late must not wipe the new one's.
 */
export function attachInput(owner: object, hasDraft: boolean): () => void {
  const state = stateOf(owner);
  const input = {};
  state.input = input;
  state.draft = hasDraft;
  return () => {
    if (state.input !== input) return;
    state.input = null;
    state.draft = false;
    state.lastKeyAt = -Infinity;
  };
}

export function isComposing(owner: object, now = Date.now()): boolean {
  const state = stateOf(owner);
  return state.draft || now - state.lastKeyAt < COMPOSING_MS;
}

/**
 * Whether the prompt for `scope` (its request) is locked. Decided when `scope` first appears, from whether the user was
 * composing then; `unlock` opens it for good. With `enabled` false (a prompt the user asked for themselves) it is never locked.
 */
export function usePromptLock(scope: unknown, enabled = true) {
  const renderer = useRenderer();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const lock = useRef<{ scope: unknown; locked: boolean } | null>(null);
  if (!lock.current || lock.current.scope !== scope) lock.current = { scope, locked: enabled && isComposing(renderer) };

  return {
    /** For rendering. */
    locked: lock.current.locked,
    /** For key handlers: current without waiting for a render. */
    isLocked: () => lock.current?.locked === true,
    unlock: () => {
      if (!lock.current?.locked) return;
      lock.current.locked = false;
      rerender();
    },
  };
}
