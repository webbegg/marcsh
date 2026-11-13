import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The prompts sent before are kept in ~/.marcsh/history.jsonl, one `{text, cwd, at}` per line, the newest this many. */
export const HISTORY_LIMIT = 500;

export type HistoryEntry = { text: string; cwd: string; at: number };

/**
 * `MARCSH_HISTORY_PATH`, else next to the preferences file (so a test that redirects the preferences never reaches the real
 * ~/.marcsh), else ~/.marcsh/history.jsonl.
 */
export function historyPath() {
  const own = process.env.MARCSH_HISTORY_PATH?.trim();
  if (own) return own;
  const preferences = process.env.MARCSH_PREFERENCES_PATH?.trim();
  return join(preferences ? dirname(preferences) : join(homedir(), ".marcsh"), "history.jsonl");
}

function parseEntry(line: string): HistoryEntry | null {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null) return null;
    const { text, cwd, at } = value as Record<string, unknown>;
    if (typeof text !== "string" || typeof cwd !== "string" || typeof at !== "number") return null;
    return { text, cwd, at };
  } catch {
    return null;
  }
}

function readRaw(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** The stored prompts, oldest first. A line that is not a valid entry is skipped; a missing or unreadable file is empty history. */
export function readHistory(path = historyPath()): HistoryEntry[] {
  return parseEntries(readRaw(path));
}

function parseEntries(raw: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    const entry = line.trim() ? parseEntry(line) : null;
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Appends a sent prompt. Empty text and an immediate repeat of the last entry are skipped; once over the cap the file is
 * rewritten with the newest entries. A write failure is ignored: history is a convenience.
 */
export function appendHistory(entry: { text: string; cwd: string }, path = historyPath(), now = Date.now()) {
  if (entry.text.trim().length === 0) return;
  try {
    const raw = readRaw(path);
    const entries = parseEntries(raw);
    if (entries.at(-1)?.text === entry.text) return;
    entries.push({ text: entry.text, cwd: entry.cwd, at: now });

    mkdirSync(dirname(path), { recursive: true });
    if (entries.length > HISTORY_LIMIT) {
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, entries.slice(-HISTORY_LIMIT).map((kept) => JSON.stringify(kept) + "\n").join(""), { mode: 0o600 });
      renameSync(tmp, path);
    } else {
      // A corrupt last line may lack its newline: the entry still starts on a line of its own.
      const needsNewline = raw.length > 0 && !raw.endsWith("\n");
      appendFileSync(path, (needsNewline ? "\n" : "") + JSON.stringify(entries.at(-1)) + "\n", { mode: 0o600 });
    }
    chmodSync(path, 0o600);
  } catch {
    // Ignore history write failures: the prompt was still sent.
  }
}

// The unsent text of each input, by key (a session's ID), for as long as the process runs.
const drafts = new Map<string, string>();

/** Keeps the unsent text for `key`; empty text forgets it. */
export function keepDraft(key: string, text: string) {
  if (text.length > 0) drafts.set(key, text);
  else drafts.delete(key);
}

/** The text kept for `key`, or "" when there is none. */
export function recallDraft(key: string): string {
  return drafts.get(key) ?? "";
}

export function clearDrafts() {
  drafts.clear();
}
