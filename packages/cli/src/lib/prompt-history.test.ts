import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendHistory, clearDrafts, HISTORY_LIMIT, historyPath, keepDraft, readHistory, recallDraft } from "./prompt-history";

// S9: the prompts sent before, kept in ~/.marcsh/history.jsonl (newest 500), and each session's unsent draft.

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-history-"));
  path = join(dir, "history.jsonl");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearDrafts();
});

const lines = () => readFileSync(path, "utf8").split("\n").filter(Boolean);

describe("appendHistory / readHistory", () => {
  test("a missing file reads as empty history", () => {
    expect(readHistory(path)).toEqual([]);
  });

  test("appends one {text, cwd, at} JSON object per line, oldest first", () => {
    appendHistory({ text: "first", cwd: "/a" }, path, 1000);
    appendHistory({ text: "second", cwd: "/b" }, path, 2000);

    expect(lines().map((line) => JSON.parse(line))).toEqual([
      { text: "first", cwd: "/a", at: 1000 },
      { text: "second", cwd: "/b", at: 2000 },
    ]);
    expect(readHistory(path).map((entry) => entry.text)).toEqual(["first", "second"]);
  });

  test("keeps multi-line prompts on one line of the file", () => {
    appendHistory({ text: "line one\nline two", cwd: "/a" }, path);

    expect(lines()).toHaveLength(1);
    expect(readHistory(path)[0]!.text).toBe("line one\nline two");
  });

  test("skips empty and whitespace-only text", () => {
    appendHistory({ text: "", cwd: "/a" }, path);
    appendHistory({ text: "  \n ", cwd: "/a" }, path);

    expect(readHistory(path)).toEqual([]);
  });

  test("skips an immediate duplicate of the last entry, but not a repeat after another prompt", () => {
    appendHistory({ text: "same", cwd: "/a" }, path);
    appendHistory({ text: "same", cwd: "/b" }, path);
    appendHistory({ text: "other", cwd: "/a" }, path);
    appendHistory({ text: "same", cwd: "/a" }, path);

    expect(readHistory(path).map((entry) => entry.text)).toEqual(["same", "other", "same"]);
  });

  test("survives a corrupt line: it is skipped, the rest is read, and later appends still work", () => {
    appendHistory({ text: "before", cwd: "/a" }, path);
    appendFileSync(path, "{not json\n");
    appendFileSync(path, JSON.stringify({ nope: true }) + "\n");
    appendFileSync(path, JSON.stringify({ text: 5, cwd: "/a", at: 1 }) + "\n");
    appendHistory({ text: "after", cwd: "/a" }, path);

    expect(readHistory(path).map((entry) => entry.text)).toEqual(["before", "after"]);
  });

  test("a file whose last line has no trailing newline still takes the next entry on its own line", () => {
    writeFileSync(path, JSON.stringify({ text: "one", cwd: "/a", at: 1 }));
    appendHistory({ text: "two", cwd: "/a" }, path);

    expect(readHistory(path).map((entry) => entry.text)).toEqual(["one", "two"]);
  });

  test("compacts to the newest 500 entries once over the cap", () => {
    expect(HISTORY_LIMIT).toBe(500);
    for (let i = 0; i < HISTORY_LIMIT + 3; i++) appendHistory({ text: `prompt ${i}`, cwd: "/a" }, path, i);

    const entries = readHistory(path);
    expect(entries).toHaveLength(HISTORY_LIMIT);
    expect(entries[0]!.text).toBe("prompt 3");
    expect(entries.at(-1)!.text).toBe(`prompt ${HISTORY_LIMIT + 2}`);
    expect(lines()).toHaveLength(HISTORY_LIMIT);
  });

  test("creates the directory and keeps the file private to the user", () => {
    const nested = join(dir, "a", "b", "history.jsonl");
    appendHistory({ text: "x", cwd: "/a" }, nested);

    expect(readHistory(nested)).toHaveLength(1);
    expect(statSync(nested).mode & 0o077).toBe(0);
  });

  test("a write that fails is swallowed (history is a convenience, never a reason to lose a prompt)", () => {
    expect(() => appendHistory({ text: "x", cwd: "/a" }, join(dir, "history.jsonl", "nope", "h.jsonl"))).not.toThrow();
  });
});

describe("historyPath", () => {
  const saved = { history: process.env.MARCSH_HISTORY_PATH, prefs: process.env.MARCSH_PREFERENCES_PATH };
  afterEach(() => {
    for (const [name, value] of [["MARCSH_HISTORY_PATH", saved.history], ["MARCSH_PREFERENCES_PATH", saved.prefs]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test("MARCSH_HISTORY_PATH wins", () => {
    process.env.MARCSH_HISTORY_PATH = "/tmp/x/history.jsonl";
    expect(historyPath()).toBe("/tmp/x/history.jsonl");
  });

  test("otherwise it sits next to the preferences file, so a test that redirects those never touches ~/.marcsh", () => {
    delete process.env.MARCSH_HISTORY_PATH;
    process.env.MARCSH_PREFERENCES_PATH = "/tmp/y/preferences.json";
    expect(historyPath()).toBe("/tmp/y/history.jsonl");
  });

  test("by default it is ~/.marcsh/history.jsonl", () => {
    delete process.env.MARCSH_HISTORY_PATH;
    delete process.env.MARCSH_PREFERENCES_PATH;
    expect(historyPath()).toMatch(/\.marcsh\/history\.jsonl$/);
  });
});

describe("drafts", () => {
  test("a kept draft is recalled by its key only", () => {
    keepDraft("s1", "half a thought");

    expect(recallDraft("s1")).toBe("half a thought");
    expect(recallDraft("s2")).toBe("");
  });

  test("keeping empty text forgets the draft", () => {
    keepDraft("s1", "half a thought");
    keepDraft("s1", "");

    expect(recallDraft("s1")).toBe("");
  });
});
