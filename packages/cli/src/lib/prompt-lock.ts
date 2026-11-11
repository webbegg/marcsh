import { useReducer, useRef } from "react";
import { useRenderer } from "@opentui/react";

// A prompt that opens while the user is composing text (typing a steer during a pi turn) must not be answered by the
// words they go on typing: they cannot tell that the keys stopped going to the input. Such a prompt opens locked, and
// only ↓ unlocks it. The input bar feeds this module; a prompt reads it once, when it opens.

/** What a locked prompt says under its (dim) key hints. */
export const LOCKED_LINE = "you were typing: press ↓ to answer";

/** A key typed in the input this recently means the user is composing. */
export const COMPOSING_MS = 2000;

/** A hand-off nobody took this long after it was made is stale and is dropped: it must not land in an unrelated session. */
export const HAND_OFF_MS = 5000;

type Composing = {
  lastKeyAt: number;
  draft: boolean;
  takesKeys: boolean;
  input: object | null;
  handedOff: string;
  handedOffAt: number;
  giveBack: ((text: string) => boolean) | null;
};

// One state per screen (renderer), so nothing carries over between screens.
const states = new WeakMap<object, Composing>();

const stateOf = (owner: object): Composing => {
  let state = states.get(owner);
  if (!state) states.set(owner, (state = { lastKeyAt: -Infinity, draft: false, takesKeys: true, input: null, handedOff: "", handedOffAt: 0, giveBack: null }));
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
 * Whether the input can take keys right now. A draft in one that cannot (a Claude session's input is off for the whole turn, so a
 * draft carried into it) is not the user composing; recent keys still are. Takes keys until told otherwise.
 */
export function setInputTakesKeys(owner: object, takesKeys: boolean) {
  stateOf(owner).takesKeys = takesKeys;
}

/**
 * An input bar mounted, already holding text or not. Keys can reach a new bar before its mount effects run (the hand-off
 * from the home screen), so the draft comes from the bar's content and the recent keys stay. The returned `detach` (its
 * unmount) clears the draft only if no newer bar attached since: an old bar unmounting late must not wipe the new one's.
 * It never clears the recent keys: they say the user's hands are typing, whichever bar took them (a burst right after Enter
 * on the home screen lands in the home bar just before it unmounts).
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
    state.takesKeys = true;
  };
}

/**
 * The unsent text of a bar that is going away (any bar: home, new-session, session), for the bar that comes next. A screen
 * stays mounted a few ms after it navigates, and keys typed in that gap land in its bar: it hands its text over when it unmounts,
 * so none is lost. A bar that sent its text emptied its input first, so only what was typed after is handed over. An empty text
 * clears an earlier hand-off. It is the only way text moves between screens' bars.
 */
export function handOffDraft(owner: object, text: string, now = Date.now()) {
  const state = stateOf(owner);
  state.handedOff = text;
  state.handedOffAt = now;
}

/**
 * What the previous bar handed off, once: the next bar takes it when it mounts and puts the keys its textarea already holds after
 * it. Empty when there is no hand-off, or when it is older than `HAND_OFF_MS` (dropped for good).
 */
export function takeHandOffDraft(owner: object, now = Date.now()): string {
  const state = stateOf(owner);
  const text = state.handedOff;
  state.handedOff = "";
  return now - state.handedOffAt > HAND_OFF_MS ? "" : text;
}

/**
 * The input bar on screen listens for text that has to go back to it. Returns the stop function, which only stops this
 * listener: a bar that unmounts late must not silence the one that replaced it.
 */
export function onGivenBack(owner: object, listener: (text: string) => boolean): () => void {
  const state = stateOf(owner);
  state.giveBack = listener;
  return () => {
    if (state.giveBack === listener) state.giveBack = null;
  };
}

/**
 * Text the engine did not take (a steer it refused, a turn that ended before it was sent) goes back to the input on screen. Returns
 * whether an input took it; when none did the caller must show the text itself, since nothing keeps it.
 */
export function giveBackText(owner: object, text: string): boolean {
  return stateOf(owner).giveBack?.(text) === true;
}

/**
 * `returned` put ahead of what the input holds, on its own line, so nothing in the input is replaced. `block` is what earlier
 * give-backs put at the front (the previous result's `block`): the next one goes after it, so several keep the order they were typed
 * in and stay ahead of what was typed since. A block the user has edited no longer counts; everything held then stays after the text.
 */
export function mergeGivenBack(returned: string, held: string, block = ""): { text: string; block: string } {
  const intact = block !== "" && (held === block || held.startsWith(`${block}\n`));
  const rest = intact ? held.slice(block.length + 1) : held;
  const front = intact ? `${block}\n${returned}` : returned;
  return { text: rest ? `${front}\n${rest}` : front, block: front };
}

export function isComposing(owner: object, now = Date.now()): boolean {
  const state = stateOf(owner);
  return (state.draft && state.takesKeys) || now - state.lastKeyAt < COMPOSING_MS;
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
