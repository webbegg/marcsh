// Regression tests from the independent verification of the approval prompt's diff (S9): Claude SDK applier parity for an
// empty new_string, and symlinks.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewEdit, type EditPreviewLine } from "./edit-preview";

const root = realpathSync(mkdtempSync(join(tmpdir(), "edit-preview-recheck-")));
const proj = join(root, "proj");
const outside = join(root, "outside");
mkdirSync(proj);
mkdirSync(outside);
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The file the rows describe: the hunks applied to the original (inputs here hold no escaped characters). */
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
    if (row.kind !== "add") cursor++;
    if (row.kind !== "remove") out.push(text);
  }
  return out.join("") + old.slice(cursor).join("");
}

let n = 0;
const file = (text: string) => {
  const path = join(proj, `f${n++}.txt`);
  writeFileSync(path, text);
  return path;
};

// Expected texts are what the Claude SDK 0.3.319 applier (Edit/MultiEdit) writes for these inputs.
describe("Claude Edit/MultiEdit with an empty new_string (SDK applier parity)", () => {
  const cases: [string, string, Record<string, unknown>, string][] = [
    ["Edit", "alpha\nbeta\ngamma\n", { old_string: "beta", new_string: "" }, "alpha\ngamma\n"],
    ["Edit", "b\nab c\nb\n", { old_string: "b", new_string: "", replace_all: true }, "ab c\n"],
    ["Edit", "alpha\nbeta", { old_string: "beta", new_string: "" }, "alpha\n"],
    ["Edit", "alpha\nbeta\ngamma\n", { old_string: "beta\n", new_string: "" }, "alpha\ngamma\n"],
    ["Edit", "x ab y\nab\n", { old_string: "ab", new_string: "", replace_all: true }, "x ab y\n"],
    ["MultiEdit", "alpha\nbeta\ngamma\n", { edits: [{ old_string: "alpha", new_string: "x" }, { old_string: "gamma", new_string: "" }] }, "x\nbeta\n"],
    ["MultiEdit", "a\nb\nc\n", { edits: [{ old_string: "a", new_string: "" }, { old_string: "c", new_string: "" }] }, "b\n"],
  ];
  for (const [tool, original, edit, expected] of cases) {
    test(`${tool} ${JSON.stringify(original)} ${JSON.stringify(edit)}`, async () => {
      const path = file(original);
      const preview = await previewEdit(tool, { file_path: path, ...edit }, proj);
      expect(preview.kind).toBe("diff");
      if (preview.kind === "diff") expect(applyRows(original, preview.lines)).toBe(expected);
    });
  }

  test("a later old_string inside an earlier new_string falls back with the tool's error", async () => {
    const path = file("a\nb\n");
    const preview = await previewEdit("MultiEdit", { file_path: path, edits: [{ old_string: "a", new_string: "zz q" }, { old_string: "q", new_string: "" }] }, proj);
    expect(preview).toEqual({ kind: "raw", reason: "edit 2 of 2: Cannot edit file: old_string is a substring of a new_string from a previous edit." });
  });
});

describe("symlinks", () => {
  writeFileSync(join(outside, "secret.txt"), "top secret\n");
  symlinkSync(join(outside, "secret.txt"), join(proj, "innocent.txt"));
  symlinkSync(outside, join(proj, "sub"));
  symlinkSync(join(outside, "missing.txt"), join(proj, "dangling.txt"));

  const cases: [string, string, Record<string, unknown>, string, string][] = [
    ["Write on a link", "Write", { file_path: join(proj, "innocent.txt"), content: "hello\n" }, join(outside, "secret.txt"), join(proj, "innocent.txt")],
    ["pi edit on a link", "edit", { path: "innocent.txt", edits: [{ oldText: "top secret", newText: "x" }] }, join(outside, "secret.txt"), join(proj, "innocent.txt")],
    ["Write under a linked folder", "Write", { file_path: join(proj, "sub", "secret.txt"), content: "hello\n" }, join(outside, "secret.txt"), join(proj, "sub", "secret.txt")],
    ["pi write of a new file under a linked folder", "write", { path: "sub/new.txt", content: "hello\n" }, join(outside, "new.txt"), join(proj, "sub", "new.txt")],
  ];
  for (const [name, tool, input, real, via] of cases) {
    test(name, async () => {
      const preview = await previewEdit(tool, input, proj);
      expect(preview.kind).toBe("diff");
      if (preview.kind === "diff") {
        expect(preview.path).toBe(real);
        expect(preview.via).toBe(via);
      }
      expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("top secret\n");
    });
  }

  test("a dangling link falls back, naming the symlink", async () => {
    for (const [tool, input] of [
      ["Write", { file_path: join(proj, "dangling.txt"), content: "hello\n" }],
      ["write", { path: "dangling.txt", content: "hello\n" }],
      ["edit", { path: "dangling.txt", oldText: "a", newText: "b" }],
    ] as const) {
      expect(await previewEdit(tool, input, proj)).toEqual({ kind: "raw", reason: "the path is a symlink to a file that does not exist" });
    }
  });
});
