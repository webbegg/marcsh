import { stripAnsiSequences, type TextareaRenderable } from "@opentui/core";

// Large pastes as placeholders follow opencode's prompt (`pasteInputText`, `pasteText`, and `expandTrackedPastedText` in
// packages/tui/src/prompt/part.ts; MIT); see THIRD_PARTY_NOTICES.md.

// Control characters other than tab and line feed: C0, DEL and C1. A paste of them (a BEL, a backspace, a NUL) would reach the model.
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Pasted text as it goes in: no escape sequences, `\n` for every line end (Windows terminals paste `\r\n` or `\r`), no other control characters but tabs. */
export const normalizePastedText = (text: string): string => stripAnsiSequences(text).replace(/\r\n?/g, "\n").replace(CONTROLS, "");

const MIN_LINES = 3;
const MAX_CHARACTERS = 150;
const PREVIEW_CHARACTERS = 30;
// What the preview leaves out: brackets (they would end the label or fake another one), and controls and invisible or direction
// characters (they could hide or reorder what the label shows).
const NOT_IN_PREVIEW = /[[\]\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The first line of `text` with something visible in it, cleaned up and cut to about 30 characters: what the placeholder shows. */
function preview(text: string): string {
  const start = text.search(/\S/);
  if (start === -1) return "";
  const end = text.indexOf("\n", start);
  // A long line is cut well past the preview's length first: only the start is shown.
  const line = text.slice(start, Math.min(end === -1 ? text.length : end, start + PREVIEW_CHARACTERS * 8));
  const clean = line.replace(NOT_IN_PREVIEW, " ").replace(/\s+/g, " ").trim();
  const shown: string[] = [];
  for (const { segment } of graphemes.segment(clean)) {
    if (shown.length === PREVIEW_CHARACTERS) return `${shown.join("").trimEnd()}…`;
    shown.push(segment);
  }
  return shown.join("");
}

/**
 * The placeholder a paste of `text` shows as when it is large (3 lines or more, or over 150 characters), else null:
 * `[Pasted ~N lines: <the start of its first line>…]`, so that what is hidden is not a surprise.
 */
export function collapsedLabel(text: string): string | null {
  let lines = 1;
  // Counted in place: a paste of several MB holds many line ends.
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) lines++;
  if (lines < MIN_LINES && text.length <= MAX_CHARACTERS) return null;
  const shown = preview(text);
  return shown === "" ? `[Pasted ~${lines} lines]` : `[Pasted ~${lines} lines: ${shown}]`;
}

/** `text` with each range (string indices into `text`) replaced by the text it stands for. */
export function expandPastedRanges(text: string, ranges: readonly { start: number; end: number; text: string }[]): string {
  // Right to left, so the indices of the ranges still to do stay valid.
  return ranges
    .slice()
    .sort((a, b) => b.start - a.start)
    .reduce((result, range) => result.slice(0, range.start) + range.text + result.slice(range.end), text);
}

// A placeholder is a virtual extmark over its label, carrying the text it stands for. The textarea moves the cursor over it and deletes
// it as one piece, and moves it with edits, undo and redo.
const PASTED_TYPE = "marcsh-pasted-text";

type PastedRange = { start: number; end: number; text: string };

/** The placeholders the input holds, in document cells. A mark whose label is gone (partly deleted, or brought back by undo over other text) is dropped. */
export function pastedRanges(textarea: TextareaRenderable): PastedRange[] {
  const typeId = textarea.extmarks.getTypeId(PASTED_TYPE);
  if (typeId === null) return [];
  const ranges: PastedRange[] = [];
  for (const mark of textarea.extmarks.getAllForTypeId(typeId)) {
    const data = mark.data as { pasted?: unknown; label?: unknown } | undefined;
    if (typeof data?.pasted !== "string" || typeof data.label !== "string" || textarea.getTextRange(mark.start, mark.end) !== data.label) {
      textarea.extmarks.delete(mark.id);
      continue;
    }
    ranges.push({ start: mark.start, end: mark.end, text: data.pasted });
  }
  return ranges;
}

/**
 * The input's text with each placeholder replaced by its paste: what is sent, kept in the history and kept as a draft. When the
 * placeholders cannot be read, a draft or the history keeps the text as shown; `strict` (what is sent) throws instead, so that a
 * message never goes out with a label in place of its paste.
 */
export function fullText(textarea: TextareaRenderable, { strict = false }: { strict?: boolean } = {}): string {
  const plain = textarea.plainText;
  try {
    const ranges = pastedRanges(textarea);
    if (ranges.length === 0) return plain;
    const index = (offset: number) => textarea.editBuffer.cellOffsetToStringIndex(offset);
    return expandPastedRanges(plain, ranges.map((range) => ({ start: index(range.start), end: index(range.end), text: range.text })));
  } catch (error) {
    if (strict) throw error;
    return plain;
  }
}

/** Puts `label` and a space where the cursor is (over the selection, if any), the label marked as standing for `text`. */
export function insertPlaceholder(textarea: TextareaRenderable, text: string, label: string) {
  const typeId = textarea.extmarks.getTypeId(PASTED_TYPE) ?? textarea.extmarks.registerType(PASTED_TYPE);
  // A selection is replaced from its start, whichever end the cursor is at.
  const start = textarea.getSelection()?.start ?? textarea.cursorOffset;
  textarea.insertText(`${label} `);
  // The cursor ends after the space (one cell); the label's width in cells is whatever its characters take.
  textarea.extmarks.create({ start, end: textarea.cursorOffset - 1, virtual: true, typeId, data: { pasted: text, label } });
}
