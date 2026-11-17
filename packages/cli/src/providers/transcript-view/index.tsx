import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { formatBinding, loadedKeybinds } from "../../lib/keybinds";

/**
 * How much of the transcript is drawn in full. Both switches are for this app session only (never saved) and start off:
 * `details` shows a tool's whole stored output and a whole diff, `thinking` shows the model's whole reasoning.
 */
export type TranscriptViewState = { details: boolean; thinking: boolean };
export type TranscriptViewKey = keyof TranscriptViewState;

export type TranscriptViewStore = {
  get: () => TranscriptViewState;
  subscribe: (listener: () => void) => () => void;
  /** Flips one switch and returns its new value. */
  toggle: (key: TranscriptViewKey) => boolean;
  /** Both switches back to off. */
  reset: () => void;
};

export function createTranscriptViewStore(): TranscriptViewStore {
  let state: TranscriptViewState = { details: false, thinking: false };
  const listeners = new Set<() => void>();
  const set = (next: TranscriptViewState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    toggle: (key) => {
      set({ ...state, [key]: !state[key] });
      return state[key];
    },
    reset: () => set({ details: false, thinking: false }),
  };
}

/**
 * The app's switches. The commands (`/details`, `/thinking`) run outside React, so they flip this store; the provider hands
 * the same store to the transcript. A test can give the provider a store of its own.
 */
export const transcriptView = createTranscriptViewStore();

const TranscriptViewContext = createContext<TranscriptViewStore>(transcriptView);

export function TranscriptViewProvider({ children, store = transcriptView }: { children: ReactNode; store?: TranscriptViewStore }) {
  return <TranscriptViewContext.Provider value={store}>{children}</TranscriptViewContext.Provider>;
}

/** The switches, and a function to flip each; the component draws again when one changes. Works without a provider, on the app's store. */
export function useTranscriptView(): TranscriptViewState & { toggle: (key: TranscriptViewKey) => boolean } {
  const store = useContext(TranscriptViewContext);
  const state = useSyncExternalStore(store.subscribe, store.get);
  const toggle = useCallback((key: TranscriptViewKey) => store.toggle(key), [store]);
  return { ...state, toggle };
}

const DEFAULT_KEYS: Record<TranscriptViewKey, string> = { details: "ctrl+x o", thinking: "ctrl+x h" };

/**
 * The keys that flip a switch, as the active keybinds say (a user's own binding shows instead of the default). Before the
 * keybinds are read it is the default; when the user unbound the command, there are no keys and it is `""`.
 */
export function transcriptViewKey(key: TranscriptViewKey): string {
  const keybinds = loadedKeybinds();
  if (!keybinds) return DEFAULT_KEYS[key];
  const binding = keybinds.commands[key]?.[0];
  return binding ? formatBinding(binding, keybinds.leader) : "";
}
