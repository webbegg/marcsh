import { createContext } from "react";

/**
 * What the commands that work on the open session can do. The session screen provides it (see `useSessionCommands`); the home screen
 * has none, and those commands say so there. Each reports its outcome in a toast, so none returns a result.
 */
export type SessionCommands = {
  /** `/rename <title>` */
  rename: (title: string) => void;
  /** `/fork`: copies the messages so far into a new session and opens it. */
  fork: () => void;
  /** `/export [md|json] [path]` */
  exportTranscript: (args: string) => Promise<void>;
  /** `/undo` and `/redo`: put the files of a turn back as they were before it, or as it left them. */
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  /** `/diff`: the files changed since the session's first turn. */
  diff: () => Promise<void>;
  /** `/compact` */
  compact: () => Promise<void>;
  /** `/copy`: the last reply to the clipboard. */
  copy: () => Promise<void>;
  /** `/ps`: the session's background terminals (pi sessions only). */
  ps: () => void;
};

export const SessionCommandsContext = createContext<SessionCommands | null>(null);
