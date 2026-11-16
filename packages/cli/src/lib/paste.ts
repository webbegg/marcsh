import { stripAnsiSequences } from "@opentui/core";

// Large pastes as placeholders follow opencode's prompt (`pasteInputText`, and `expandTrackedPastedText` in
// packages/tui/src/prompt/part.ts; MIT); see THIRD_PARTY_NOTICES.md.

/** Pasted text as it goes in: no escape sequences, and `\n` for every line end (Windows terminals paste `\r\n` or `\r`). */
export const normalizePastedText = (text: string): string => stripAnsiSequences(text).replace(/\r\n?/g, "\n");

const MIN_LINES = 3;
const MAX_CHARACTERS = 150;

/** The placeholder a paste of `text` shows as, `[Pasted ~N lines]`, when it is large (3 lines or more, or over 150 characters); else null. */
export function collapsedLabel(text: string): string | null {
  const lines = (text.match(/\n/g)?.length ?? 0) + 1;
  return lines >= MIN_LINES || text.length > MAX_CHARACTERS ? `[Pasted ~${lines} lines]` : null;
}

/** `text` with each range (string indices into `text`) replaced by the text it stands for. */
export function expandPastedRanges(text: string, ranges: readonly { start: number; end: number; text: string }[]): string {
  // Right to left, so the indices of the ranges still to do stay valid.
  return ranges
    .slice()
    .sort((a, b) => b.start - a.start)
    .reduce((result, range) => result.slice(0, range.start) + range.text + result.slice(range.end), text);
}
