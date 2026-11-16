import { createContext, useContext, type ReactNode } from "react";
import { legacyClipboard, type ClipboardService } from "../../lib/clipboard";

// Follows opencode's packages/tui/src/context/clipboard.tsx (MIT); see THIRD_PARTY_NOTICES.md.

// Without a provider (tests that do not give one) copies go the old way and reads are not available.
const ClipboardContext = createContext<ClipboardService>(legacyClipboard);

/** Gives the screens the process's clipboard (see `createAppClipboard`); tests give a stub. */
export function ClipboardProvider({ value, children }: { value: ClipboardService; children: ReactNode }) {
  return <ClipboardContext.Provider value={value}>{children}</ClipboardContext.Provider>;
}

export const useClipboard = (): ClipboardService => useContext(ClipboardContext);
