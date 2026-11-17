// What an approval prompt shows for an edit: the exact diff of what an Edit, MultiEdit or Write (Claude) or an edit or write (pi) call
// will write to the file. The prompt is a guard (the user approves an edit by looking at it), so this module never misrepresents an
// edit: when it cannot be sure what the tool will write, it returns `{ kind: "raw", reason }` and the prompt falls back to the raw
// tool input, saying why.
//
// The preview reflects the file as it was when the prompt opened. The file can change between the prompt and the tool run (another
// process, or an earlier tool call still running); the tool then works on the new content, and may fail, or write something else.
// This module reads the file once, read-only, and never writes.
//
// How each tool reads and writes the file, which is what the preview has to match:
// - pi `edit` strips a leading BOM, notes the line ending of the first line break, turns every line ending into LF, matches and
//   replaces there, then writes BOM + the text with LF turned back into that ending. So a CRLF file stays CRLF and a BOM stays; the
//   diff is shown on the LF text. A file whose line endings would not survive that round trip unchanged (mixed endings, a lone CR) is
//   rewritten by the tool beyond the edit, so it falls back. pi matches loosely when an exact match fails (trailing whitespace,
//   smart quotes, dashes, spaces; NFKC) and counts matches loosely too, which is why an exact match is required here and a text that
//   also matches loosely elsewhere falls back.
// - pi `write` writes the content as given, byte for byte: a changed line ending or BOM is a real change and is shown as one.
// - Claude's Edit, MultiEdit and Write are closed (the SDK ships them compiled), so nothing here is verified against their source. The
//   one rule modelled beyond a plain replace is the SDK's (0.3.319): an Edit with an empty new_string, whose old_string does not end in a
//   line break while the file holds old_string + a line break, replaces old_string + the line break (with replace_all, only the
//   occurrences followed by one). A MultiEdit whose later old_string sits inside an earlier new_string is refused by the tool, and so is
//   a notebook (.ipynb); both fall back. Only what is certain is previewed: a file with CRLF or a BOM, text with a carriage return, new text with trailing whitespace outside
//   markdown (the tool may strip it) and a path starting with `~` all fall back.

import { lstat, open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeProjectText } from "./engine/pi-trust";

/** One row of the diff, already escaped for display (see `escapedLines`), ready for a row renderer. */
export type EditPreviewLine = {
  /**
   * `hunk` is a row that is not file content: a hunk header (`@@ -a,b +c,d @@`) or the marker `\ No newline at end of file`, which
   * follows the line it is about.
   */
  kind: "add" | "remove" | "context" | "hunk";
  text: string;
  /** The 1-based line in the file as it is now (on `remove` and `context` rows). */
  oldLine?: number;
  /** The 1-based line in the file as it will be (on `add` and `context` rows). */
  newLine?: number;
};

export type EditPreview =
  | {
      kind: "diff";
      /** The file the tool writes, absolute and escaped for display (one line: a newline in a path is shown as `\n`). A symlink is followed to its target. */
      path: string;
      /** Set when the path the tool was given is a symlink, or sits under one: that path (absolute, escaped); `path` is then the real file. */
      via?: string;
      /** A unified diff (context 3) built from the escaped rows. It is display text, not something to apply. */
      patch: string;
      added: number;
      removed: number;
      /** The file does not exist yet: everything is added. */
      newFile: boolean;
      /** The file uses CRLF and the tool writes CRLF back (pi `edit`): the rows are shown without the carriage returns. */
      crlf: boolean;
      lines: EditPreviewLine[];
    }
  | {
      kind: "raw";
      /** Why there is no diff, for the prompt to say next to the raw tool input. */
      reason: string;
    };

export type EditPreviewOptions = {
  /** The largest file read, and the largest text written, in bytes. Default 1 MB. */
  maxBytes?: number;
};

export const EDIT_PREVIEW_MAX_BYTES = 1024 * 1024;
/** Changed lines past this are not diffed (the line diff is quadratic in the changed region): the prompt shows the raw input. */
const MAX_CHANGED_LINES = 2000;
const CONTEXT = 3;

/** The reason when an exact match fails: pi (and perhaps Claude) may match loosely, and the preview never guesses. */
const NOT_FOUND = "old text not found exactly (the tool may match it loosely)";
const BAD_SHAPE = "the tool input is not in the expected shape";

type Raw = { kind: "raw"; reason: string };
const raw = (reason: string): Raw => ({ kind: "raw", reason });
const isRaw = (value: unknown): value is Raw => typeof value === "object" && value !== null && (value as Raw).kind === "raw";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The exact diff of what `tool` will write for `input`, or the reason there is none. `tool` is the tool's own name: `Edit`, `MultiEdit`
 * and `Write` for Claude, `edit` and `write` for pi. A relative path resolves against `cwd`. Never throws.
 */
export async function previewEdit(
  tool: string,
  input: unknown,
  cwd: string,
  options: EditPreviewOptions = {},
): Promise<EditPreview> {
  const maxBytes = options.maxBytes ?? EDIT_PREVIEW_MAX_BYTES;
  try {
    switch (tool) {
      case "Edit":
        return await previewClaudeEdits(input, cwd, maxBytes, false);
      case "MultiEdit":
        return await previewClaudeEdits(input, cwd, maxBytes, true);
      case "Write":
        return await previewWrite(input, "file_path", cwd, maxBytes, "claude");
      case "write":
        return await previewWrite(input, "path", cwd, maxBytes, "pi");
      case "edit":
        return await previewPiEdit(input, cwd, maxBytes);
      default:
        return raw(`no preview for the ${escapeProjectText(tool)} tool`);
    }
  } catch (error) {
    return raw(`the preview failed (${escapeProjectText(error instanceof Error ? error.message : String(error))})`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Reading the file

type FileState = { state: "missing" } | { state: "ok"; text: string } | { state: "fail"; reason: string };

/** The file as text, read-only and capped. A directory, a binary file, a file that is not UTF-8, a read error or a big file fail. */
async function readFileText(path: string, maxBytes: number): Promise<FileState> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // A dangling symlink is not a missing file: the tool would write through it.
      const link = await lstat(path).catch(() => undefined);
      return link ? { state: "fail", reason: "the path is a symlink to a file that does not exist" } : { state: "missing" };
    }
    return { state: "fail", reason: `could not read the file (${code ?? "error"})` };
  }
  if (info.isDirectory()) return { state: "fail", reason: "the path is a directory, not a file" };
  if (!info.isFile()) return { state: "fail", reason: "the path is not a regular file" };
  if (info.size > maxBytes) return { state: "fail", reason: tooLarge(maxBytes) };
  let bytes: Buffer;
  try {
    const handle = await open(path, "r");
    try {
      // One byte past the cap, so a file that grew since `stat` is still caught.
      const buffer = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
      bytes = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { state: "fail", reason: `could not read the file (${(error as NodeJS.ErrnoException).code ?? "error"})` };
  }
  if (bytes.length > maxBytes) return { state: "fail", reason: tooLarge(maxBytes) };
  if (bytes.includes(0)) return { state: "fail", reason: "the file is binary (it contains NUL bytes)" };
  try {
    // `ignoreBOM: true` keeps a leading BOM in the text instead of dropping it.
    return { state: "ok", text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    return { state: "fail", reason: "the file is not valid UTF-8 (the tool would write replacement characters over it)" };
  }
}

/** The real path of a path: symlinks followed, and for a part that does not exist yet (a new file, a new folder) the nearest existing folder's real path with the rest appended. */
async function realPathOf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    const parent = dirname(path);
    return parent === path ? path : join(await realPathOf(parent), basename(path));
  }
}

/**
 * The file the tool really writes for a path: the real path when the path, or a folder above it, is a symlink (`via` is then the path as
 * given). The session's folder being reached through a symlink itself (a path under /tmp on macOS) is not reported for paths inside it.
 */
async function targetOf(path: string, cwd: string): Promise<{ path: string; via?: string }> {
  const real = await realPathOf(path);
  const folder = resolve(cwd);
  const rest = relative(folder, path);
  const inside = rest !== "" && rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
  const expected = inside ? join(await realPathOf(folder), rest) : path;
  return real === expected ? { path } : { path: real, via: path };
}

const tooLarge = (maxBytes: number) =>
  `the file is too large to preview (over ${maxBytes >= 1024 * 1024 ? `${maxBytes / (1024 * 1024)} MB` : `${maxBytes} bytes`})`;

// ---------------------------------------------------------------------------------------------------------------------------------
// Paths

// pi's UNICODE_SPACES (utils/paths.js): U+00A0, U+2000-U+200A, U+202F, U+205F, U+3000 (written as the characters themselves, in this
// regex and in the ones in `normalizeForFuzzyMatch` below: quotes U+2018-201B and U+201C-201F, dashes U+2010-2015 and U+2212).
const PI_SPACES = /[  -   　]/g;

/** The file pi's `edit` and `write` open for a path (pi's `resolveToCwd`: unusual spaces, a leading `@`, `~`, a `file://` URL). Null: pi would reject it. */
function resolvePiPath(input: string, cwd: string): string | null {
  let path = input.replace(PI_SPACES, " ");
  if (path.startsWith("@")) path = path.slice(1);
  if (path === "~") path = homedir();
  else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  else if (/^file:\/\//.test(path)) {
    try {
      path = fileURLToPath(path);
    } catch {
      return null;
    }
  }
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

/** The file Claude's tools open. A path starting with `~` is not guessed. */
function resolveClaudePath(input: string, cwd: string): string | Raw {
  if (input.startsWith("~")) return raw("the path starts with ~, which the tool may expand differently");
  return isAbsolute(input) ? resolve(input) : resolve(cwd, input);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Claude: Edit, MultiEdit

type ClaudeEdit = { oldString: string; newString: string; replaceAll: boolean };

function claudeEditFrom(value: unknown): ClaudeEdit | null {
  if (!isRecord(value)) return null;
  const { old_string, new_string, replace_all } = value;
  if (typeof old_string !== "string" || typeof new_string !== "string") return null;
  if (replace_all !== undefined && typeof replace_all !== "boolean") return null;
  return { oldString: old_string, newString: new_string, replaceAll: replace_all === true };
}

/** How many times `needle` occurs in `text`, counting overlapping occurrences (so an ambiguous match is never taken for a unique one). */
function countOccurrences(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) count++;
  return count;
}

const label = (index: number, total: number) => (total > 1 ? `edit ${index + 1} of ${total}: ` : "");

async function previewClaudeEdits(input: unknown, cwd: string, maxBytes: number, multi: boolean): Promise<EditPreview> {
  if (!isRecord(input) || typeof input.file_path !== "string" || input.file_path === "") return raw(BAD_SHAPE);
  let edits: ClaudeEdit[];
  if (multi) {
    if (!Array.isArray(input.edits)) return raw(BAD_SHAPE);
    const parsed = input.edits.map(claudeEditFrom);
    if (parsed.some((edit) => edit === null)) return raw(BAD_SHAPE);
    edits = parsed as ClaudeEdit[];
    if (edits.length === 0) return raw("the edit list is empty");
  } else {
    const single = claudeEditFrom(input);
    if (!single) return raw(BAD_SHAPE);
    edits = [single];
  }

  const path = resolveClaudePath(input.file_path, cwd);
  if (isRaw(path)) return path;
  if (/\.ipynb$/i.test(path)) return raw("the tool does not edit notebooks (.ipynb files)");
  const markdown = /\.mdx?$/i.test(path);
  for (const edit of edits) {
    if (edit.oldString.includes("\r") || edit.newString.includes("\r")) {
      return raw("the text contains a carriage return, and how the tool writes it is not known");
    }
    // Claude Code strips trailing whitespace from new text outside markdown; the SDK's tool is closed, so a text it could change is not previewed.
    if (!markdown && /[ \t](\n|$)/.test(edit.newString)) {
      return raw("the new text has trailing whitespace, which the tool may strip");
    }
  }

  const file = await readFileText(path, maxBytes);
  if (file.state === "fail") return raw(file.reason);
  let text: string;
  let newFile = false;
  let rest = edits;
  if (file.state === "missing") {
    // An empty old_string on a missing file creates it with the new text.
    if (edits[0]!.oldString !== "") return raw("the file does not exist");
    text = edits[0]!.newString;
    newFile = true;
    rest = edits.slice(1);
  } else {
    const unsure = claudeFileUnsure(file.text);
    if (unsure) return raw(unsure);
    text = file.text;
  }

  const original = file.state === "ok" ? file.text : "";
  // The new texts of the edits before this one: the tool refuses an old_string found in one of them (ignoring the old_string's trailing line breaks).
  const earlier: string[] = newFile ? [edits[0]!.newString] : [];
  for (const [offset, edit] of rest.entries()) {
    const index = newFile ? offset + 1 : offset;
    const prefix = label(index, edits.length);
    if (earlier.length > 0 && edit.oldString !== "") {
      const needle = edit.oldString.replace(/\n+$/, "");
      if (needle === "") return raw(`${prefix}old text is only line breaks after an earlier edit, and how the tool checks that is not known`);
      if (earlier.some((newString) => newString.includes(needle))) {
        return raw(`${prefix}Cannot edit file: old_string is a substring of a new_string from a previous edit.`);
      }
    }
    const result = applyClaudeEdit(text, edit);
    if (isRaw(result)) return raw(prefix + result.reason);
    text = result.text;
    earlier.push(edit.newString);
  }
  if (!newFile && text === original) return raw("the edits change nothing");
  return buildPreview(path, cwd, original, text, newFile, false, maxBytes);
}

function applyClaudeEdit(text: string, edit: ClaudeEdit): { text: string } | Raw {
  const { oldString, newString, replaceAll } = edit;
  if (oldString === newString) return raw("old text and new text are identical");
  if (oldString === "") return raw("old text is empty but the file exists");
  const count = countOccurrences(text, oldString);
  if (count === 0) return raw(NOT_FOUND);
  if (count > 1 && !replaceAll) return raw(`old text matches ${count} times and replace_all is not set`);
  // The SDK's applier (0.3.319): deleting text that does not end in a line break, from a file that holds it followed by one, takes that line break too.
  if (newString === "" && !oldString.endsWith("\n") && text.includes(`${oldString}\n`)) {
    if (replaceAll) return { text: text.split(`${oldString}\n`).join("") };
    // One match in the whole file, so the one followed by a line break is that match.
    const at = text.indexOf(oldString);
    return { text: text.slice(0, at) + text.slice(at + oldString.length + 1) };
  }
  if (replaceAll) return { text: text.split(oldString).join(newString) };
  const at = text.indexOf(oldString);
  return { text: text.slice(0, at) + newString + text.slice(at + oldString.length) };
}

/** Why a Claude tool's handling of this file's bytes is not known, if it is not. */
function claudeFileUnsure(text: string): string | null {
  if (text.charCodeAt(0) === 0xfeff) return "the file starts with a BOM, and how the tool writes it is not known";
  if (text.includes("\r")) return "the file has CRLF line endings, and how the tool writes them is not known";
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Write (Claude and pi)

async function previewWrite(
  input: unknown,
  pathKey: string,
  cwd: string,
  maxBytes: number,
  engine: "claude" | "pi",
): Promise<EditPreview> {
  if (!isRecord(input) || typeof input[pathKey] !== "string" || input[pathKey] === "" || typeof input.content !== "string") {
    return raw(BAD_SHAPE);
  }
  const given = input[pathKey] as string;
  const content = input.content;
  const path = engine === "pi" ? resolvePiPath(given, cwd) : resolveClaudePath(given, cwd);
  if (path === null) return raw("the path is not one the tool accepts");
  if (isRaw(path)) return path;
  if (engine === "claude" && content.includes("\r")) {
    return raw("the content contains a carriage return, and how the tool writes it is not known");
  }

  const file = await readFileText(path, maxBytes);
  if (file.state === "fail") return raw(file.reason);
  if (file.state === "missing") return buildPreview(path, cwd, "", content, true, false, maxBytes);
  if (engine === "claude") {
    const unsure = claudeFileUnsure(file.text);
    if (unsure) return raw(unsure);
  }
  return buildPreview(path, cwd, file.text, content, false, false, maxBytes);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// pi: edit

type PiEdit = { oldText: string; newText: string };

function piEditFrom(value: unknown): PiEdit | null {
  return isRecord(value) && typeof value.oldText === "string" && typeof value.newText === "string"
    ? { oldText: value.oldText, newText: value.newText }
    : null;
}

/** The edit list as pi's `prepareArguments` understands it: an array, a JSON string of one, one edit object, plus legacy top-level oldText/newText. */
function piEditsFrom(input: Record<string, unknown>): PiEdit[] | null {
  let list: unknown = input.edits;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return null;
    }
  }
  const single = piEditFrom(list);
  const edits: unknown[] = Array.isArray(list) ? [...list] : single ? [single] : [];
  if (list !== undefined && !Array.isArray(list) && !single) return null;
  if (typeof input.oldText === "string" && typeof input.newText === "string") {
    edits.push({ oldText: input.oldText, newText: input.newText });
  }
  const parsed = edits.map(piEditFrom);
  if (parsed.length === 0 || parsed.some((edit) => edit === null)) return null;
  return parsed as PiEdit[];
}

const normalizeToLF = (text: string) => text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
const detectLineEnding = (text: string) => {
  const lf = text.indexOf("\n");
  const crlf = text.indexOf("\r\n");
  return lf === -1 || crlf === -1 ? "\n" : crlf < lf ? "\r\n" : "\n";
};
const restoreLineEndings = (text: string, ending: string) => (ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text);

// A copy of pi's `normalizeForFuzzyMatch` (core/tools/edit-diff.js, not exported): pi counts matches in this space, so a text that is
// unique exactly but not loosely is rejected by the tool. Keep in step with pi.
function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[  -   　]/g, " ");
}

async function previewPiEdit(input: unknown, cwd: string, maxBytes: number): Promise<EditPreview> {
  if (!isRecord(input) || typeof input.path !== "string" || input.path === "") return raw(BAD_SHAPE);
  const edits = piEditsFrom(input);
  if (!edits) return raw(BAD_SHAPE);
  const path = resolvePiPath(input.path, cwd);
  if (path === null) return raw("the path is not one the tool accepts");

  const file = await readFileText(path, maxBytes);
  if (file.state === "fail") return raw(file.reason);
  if (file.state === "missing") return raw("the file does not exist");

  const bom = file.text.charCodeAt(0) === 0xfeff ? "﻿" : "";
  const content = file.text.slice(bom.length);
  const ending = detectLineEnding(content);
  const base = normalizeToLF(content);
  if (bom + restoreLineEndings(base, ending) !== file.text) {
    return raw("the file mixes line endings (or has a lone CR), and the tool would rewrite them all, not just the edit");
  }

  const matches: { index: number; length: number; newText: string; edit: number }[] = [];
  let fuzzyBase: string | undefined;
  for (const [i, edit] of edits.entries()) {
    const oldText = normalizeToLF(edit.oldText);
    const prefix = label(i, edits.length);
    if (oldText === "") return raw(`${prefix}old text is empty`);
    const index = base.indexOf(oldText);
    if (index === -1) return raw(prefix + NOT_FOUND);
    fuzzyBase ??= normalizeForFuzzyMatch(base);
    // pi rejects a text that is not unique, counting loosely; an exact second match is a loose one too.
    if (base.indexOf(oldText, index + 1) !== -1 || fuzzyBase.split(normalizeForFuzzyMatch(oldText)).length - 1 !== 1) {
      return raw(`${prefix}old text must match exactly once (the tool needs it to be unique)`);
    }
    matches.push({ index, length: oldText.length, newText: normalizeToLF(edit.newText), edit: i + 1 });
  }
  matches.sort((a, b) => a.index - b.index);
  for (let i = 1; i < matches.length; i++) {
    const previous = matches[i - 1]!;
    if (previous.index + previous.length > matches[i]!.index) {
      return raw(`edit ${previous.edit} and edit ${matches[i]!.edit} overlap`);
    }
  }
  let next = base;
  for (const match of [...matches].reverse()) {
    next = next.slice(0, match.index) + match.newText + next.slice(match.index + match.length);
  }
  if (next === base) return raw("the edits change nothing");
  return buildPreview(path, cwd, base, next, false, ending === "\r\n", maxBytes);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The diff

/** Lines with their line break kept, as pi splits them. `a\nb` is `["a\n", "b"]`: a last line without a break differs from the same line with one. */
const splitKeepingBreaks = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+/g) ?? [];

type Row = { mark: " " | "-" | "+"; text: string; hasBreak: boolean };
type Hunk = { oldStart: number; oldCount: number; newStart: number; newCount: number; rows: Row[] };

type Op = { mark: " " | "-" | "+"; line: string };

/**
 * A shortest edit script from `a` to `b` (Myers, O(ND)), as the operations in order. Memory is O(D squared), which the caller bounds by
 * the number of changed lines.
 */
function editScript(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const mid = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] is the furthest-reaching table as it was before round d, for the diagonals -d-1 to d+1.
  const trace: Int32Array[] = [];
  let last = 0;
  search: for (let d = 0; d <= max; d++) {
    trace.push(v.slice(mid - d - 1, mid + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[mid + k - 1]! < v[mid + k + 1]!) ? v[mid + k + 1]! : v[mid + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[mid + k] = x;
      if (x >= n && y >= m) {
        last = d;
        break search;
      }
    }
  }

  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = last; d > 0; d--) {
    const before = trace[d]!;
    const at = (k: number) => before[k + d + 1]!;
    const k = x - y;
    const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      ops.push({ mark: " ", line: a[x - 1]! });
      x--;
      y--;
    }
    if (x === previousX) {
      ops.push({ mark: "+", line: b[y - 1]! });
      y--;
    } else {
      ops.push({ mark: "-", line: a[x - 1]! });
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ mark: " ", line: a[x - 1]! });
    x--;
    y--;
  }
  return ops.reverse();
}

/** The hunks of an edit script, each with `CONTEXT` unchanged lines around its changes; changes less than twice that apart share a hunk. Line numbers start at 1. */
function hunksOf(ops: Op[]): Hunk[] {
  const changes: number[] = [];
  ops.forEach((op, index) => {
    if (op.mark !== " ") changes.push(index);
  });
  const hunks: Hunk[] = [];
  let g = 0;
  while (g < changes.length) {
    let end = g;
    while (end + 1 < changes.length && changes[end + 1]! - changes[end]! - 1 <= 2 * CONTEXT) end++;
    const from = Math.max(0, changes[g]! - CONTEXT);
    const to = Math.min(ops.length, changes[end]! + CONTEXT + 1);
    let oldBefore = 0;
    let newBefore = 0;
    for (const op of ops.slice(0, from)) {
      if (op.mark !== "+") oldBefore++;
      if (op.mark !== "-") newBefore++;
    }
    const rows: Row[] = ops.slice(from, to).map(({ mark, line }) => ({
      mark,
      text: line.endsWith("\n") ? line.slice(0, -1) : line,
      hasBreak: line.endsWith("\n"),
    }));
    const oldCount = rows.filter((row) => row.mark !== "+").length;
    const newCount = rows.filter((row) => row.mark !== "-").length;
    // A side with no lines in the hunk is numbered by the line before it.
    hunks.push({
      oldStart: oldCount === 0 ? oldBefore : oldBefore + 1,
      oldCount,
      newStart: newCount === 0 ? newBefore : newBefore + 1,
      newCount,
      rows,
    });
    g = end + 1;
  }
  return hunks;
}

/** Applies hunks (in the original's line numbering) to the original and returns the result; null when a row does not match the original. */
function applyHunks(oldLines: string[], hunks: Hunk[]): string | null {
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const start = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    if (start < cursor || start > oldLines.length) return null;
    out.push(...oldLines.slice(cursor, start));
    cursor = start;
    for (const row of hunk.rows) {
      const line = row.text + (row.hasBreak ? "\n" : "");
      if (row.mark !== "+") {
        if (oldLines[cursor] !== line) return null;
        cursor++;
      }
      if (row.mark !== "-") out.push(line);
    }
  }
  out.push(...oldLines.slice(cursor));
  return out.join("");
}

/** One row of file text escaped (a row holds no line break; a path may, and is escaped whole into one line). */
const escapeRow = escapeProjectText;

async function buildPreview(
  givenPath: string,
  cwd: string,
  oldText: string,
  newText: string,
  newFile: boolean,
  crlf: boolean,
  maxBytes: number,
): Promise<EditPreview> {
  if (Buffer.byteLength(newText, "utf8") > maxBytes) return raw("the new content is too large to preview");
  const target = await targetOf(givenPath, cwd);
  const shown = escapeRow(target.path);
  const via = target.via === undefined ? undefined : escapeRow(target.via);
  const diff = lineDiff(oldText, newText);
  if (isRaw(diff)) return diff;

  const lines: EditPreviewLine[] = [];
  let added = 0;
  let removed = 0;
  for (const hunk of diff) {
    let oldLine = hunk.oldCount === 0 ? hunk.oldStart + 1 : hunk.oldStart;
    let newLine = hunk.newCount === 0 ? hunk.newStart + 1 : hunk.newStart;
    lines.push({ kind: "hunk", text: `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@` });
    for (const row of hunk.rows) {
      const text = escapeRow(row.text);
      if (row.mark === " ") lines.push({ kind: "context", text, oldLine: oldLine++, newLine: newLine++ });
      else if (row.mark === "-") {
        removed++;
        lines.push({ kind: "remove", text, oldLine: oldLine++ });
      } else {
        added++;
        lines.push({ kind: "add", text, newLine: newLine++ });
      }
      if (!row.hasBreak) lines.push({ kind: "hunk", text: "\\ No newline at end of file" });
    }
  }
  const patch =
    lines.length === 0
      ? ""
      : `--- ${shown}\n+++ ${shown}\n${lines
          .map((line) => `${{ add: "+", remove: "-", context: " ", hunk: "" }[line.kind]}${line.text}`)
          .join("\n")}\n`;
  return { kind: "diff", path: shown, ...(via === undefined ? {} : { via }), patch, added, removed, newFile, crlf, lines };
}

/**
 * The hunks (context 3, line numbers in the whole files) that turn `oldText` into `newText`, checked by applying them to `oldText`:
 * a diff that does not reproduce `newText` exactly is never returned. The identical head and tail are cut first (keeping the context),
 * so the cost depends on the changed region only, and a region over {@link MAX_CHANGED_LINES} lines is not diffed at all (a line diff
 * is quadratic in the changes). pi's `generateUnifiedPatch` is not used: it takes seconds on a few thousand changed lines, and loading
 * pi's package takes over a second the first time, which a Claude session would pay at its first approval prompt.
 */
function lineDiff(oldText: string, newText: string): Hunk[] | Raw {
  if (oldText === newText) return [];
  const a = splitKeepingBreaks(oldText);
  const b = splitKeepingBreaks(newText);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const changed = a.length - head - tail + (b.length - head - tail);
  if (changed > MAX_CHANGED_LINES) return raw(`the change is too large to preview (${changed} changed lines)`);

  const before = Math.min(head, CONTEXT);
  const after = Math.min(tail, CONTEXT);
  const offset = head - before;
  const hunks = hunksOf(editScript(a.slice(offset, a.length - tail + after), b.slice(offset, b.length - tail + after)));
  for (const hunk of hunks) {
    hunk.oldStart += offset;
    hunk.newStart += offset;
  }
  if (applyHunks(a, hunks) !== newText) return raw("could not build an exact diff");
  return hunks;
}
