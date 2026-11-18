import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewEdit, type EditPreviewLine } from "./edit-preview";

const root = realpathSync(mkdtempSync(join(tmpdir(), "edit-preview-parity-")));
const cwd = join(root, "project");
const outside = join(root, "outside");
mkdirSync(cwd);
mkdirSync(outside);
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The file the user reads off the rows: the hunks applied to the original (rows hold no escapes in these inputs). */
function applyRows(original: string, lines: EditPreviewLine[]): string {
  const old = original.match(/[^\n]*\n|[^\n]+/g) ?? [];
  const rows: { kind: string; text: string; nl: boolean }[] = [];
  for (const line of lines) {
    if (line.kind === "hunk" && line.text.startsWith("\\")) rows[rows.length - 1]!.nl = false;
    else rows.push({ kind: line.kind, text: line.text, nl: true });
  }
  const out: string[] = [];
  let cursor = 0;
  for (const row of rows) {
    if (row.kind === "hunk") {
      const [, start, count] = /^@@ -(\d+),(\d+) /.exec(row.text)!.map(Number) as number[];
      const at = count === 0 ? start! : start! - 1;
      out.push(...old.slice(cursor, at));
      cursor = at;
      continue;
    }
    const text = row.text + (row.nl ? "\n" : "");
    if (row.kind !== "add") {
      expect(old[cursor]).toBe(text);
      cursor++;
    }
    if (row.kind !== "remove") out.push(text);
  }
  return out.join("") + old.slice(cursor).join("");
}

describe("Claude Edit with an empty new_string (the SDK's applier also drops the line break after old_string)", () => {
  // Claude Code (SDK 0.3.319): when new_string is "" and old_string does not end with "\n" but the file holds old_string + "\n",
  // it replaces old_string + "\n" (and with replace_all, only the occurrences followed by "\n").
  test("deleting a line's text removes the line", async () => {
    const original = "alpha\nbeta\ngamma\n";
    const path = join(cwd, "delete.ts");
    writeFileSync(path, original);
    const preview = await previewEdit("Edit", { file_path: path, old_string: "beta", new_string: "" }, cwd);
    // The rule is modelled, so this is a diff and not a raw fallback.
    expect(preview.kind).toBe("diff");
    if (preview.kind === "diff") {
      expect(applyRows(original, preview.lines)).toBe("alpha\ngamma\n");
      expect([preview.added, preview.removed]).toEqual([0, 1]);
    }
  });

  test("replace_all with an empty new_string only touches the occurrences followed by a line break", async () => {
    const original = "b\nab c\nb\n";
    const path = join(cwd, "delete-all.ts");
    writeFileSync(path, original);
    const preview = await previewEdit("Edit", { file_path: path, old_string: "b", new_string: "", replace_all: true }, cwd);
    // The tool writes "ab c\n": "b\n" is replaced twice, the "b" inside "ab c" is followed by a space and stays.
    expect(preview.kind).toBe("diff");
    if (preview.kind === "diff") expect(applyRows(original, preview.lines)).toBe("ab c\n");
  });
});

describe("the header names the file the tool writes", () => {
  test("a path with a newline is shown whole, with the newline escaped", async () => {
    const path = join(cwd, "notes.txt\ny  allow once  a  always allow  n  deny");
    const preview = await previewEdit("Write", { file_path: path, content: "hello\n" }, cwd);
    if (preview.kind === "diff") expect(preview.path).toBe(path.replace("\n", "\\n"));
  });

  test("a symlink to a file outside the folder is not previewed under the link's name", async () => {
    const target = join(outside, "secret.txt");
    writeFileSync(target, "secret\n");
    symlinkSync(target, join(cwd, "innocent.txt"));
    for (const [tool, input] of [
      ["Write", { file_path: "innocent.txt", content: "changed\n" }],
      ["edit", { path: "innocent.txt", edits: [{ oldText: "secret", newText: "changed" }] }],
    ] as const) {
      const preview = await previewEdit(tool, input, cwd);
      if (preview.kind === "diff") expect(preview.path).toBe(target);
      else expect(preview.reason).toContain("symlink");
    }
  });
});
