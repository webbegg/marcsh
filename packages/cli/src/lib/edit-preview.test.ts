import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EditPreview, type EditPreviewLine, previewEdit } from "./edit-preview";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "edit-preview-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

let counter = 0;
/** A fresh file in the temp folder; returns its absolute path. */
async function file(content: string | Uint8Array, name = `f${counter++}.txt`): Promise<string> {
  const path = join(root, name);
  await writeFile(path, content);
  return path;
}

const NOT_FOUND = "old text not found exactly (the tool may match it loosely)";

function diffOf(result: EditPreview) {
  if (result.kind !== "diff") throw new Error(`expected a diff, got raw: ${result.reason}`);
  return result;
}
function rawOf(result: EditPreview) {
  if (result.kind !== "raw") throw new Error(`expected raw, got a diff with ${result.lines.length} lines`);
  return result;
}

/** Applies a diff's rows to the original (every line of it ends in a newline), checking each row against the original and the new line numbers as it goes. */
function applyRows(original: string, lines: EditPreviewLine[]): string {
  const old = original.split("\n");
  old.pop();
  const out: string[] = [];
  let cursor = 0;
  for (const line of lines) {
    if (line.kind === "hunk") {
      expect(line.text.startsWith("@@")).toBe(true);
      continue;
    }
    if (line.kind === "add") {
      out.push(line.text);
      expect(line.newLine).toBe(out.length);
      continue;
    }
    const index = line.oldLine! - 1;
    while (cursor < index) out.push(old[cursor++]!);
    expect(old[index]).toBe(line.text);
    cursor = index + 1;
    if (line.kind === "context") {
      out.push(line.text);
      expect(line.newLine).toBe(out.length);
    }
  }
  while (cursor < old.length) out.push(old[cursor++]!);
  return out.map((text) => `${text}\n`).join("");
}

describe("Claude Edit", () => {
  test("one exact match gives the diff of what will be written", async () => {
    const path = await file("one\ntwo\nthree\n");
    const result = diffOf(await previewEdit("Edit", { file_path: path, old_string: "two", new_string: "2" }, root));
    expect(result.newFile).toBe(false);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.path).toBe(path);
    expect(result.lines).toEqual([
      { kind: "hunk", text: "@@ -1,3 +1,3 @@" },
      { kind: "context", text: "one", oldLine: 1, newLine: 1 },
      { kind: "remove", text: "two", oldLine: 2 },
      { kind: "add", text: "2", newLine: 2 },
      { kind: "context", text: "three", oldLine: 3, newLine: 3 },
    ]);
    expect(result.patch).toContain("-two\n+2\n");
  });

  test("a partial-line match shows the whole changed line", async () => {
    const path = await file("const a = 1;\nconst b = 2;\n");
    const result = diffOf(await previewEdit("Edit", { file_path: path, old_string: "b = 2", new_string: "b = 3" }, root));
    expect(result.lines.filter((l) => l.kind === "remove").map((l) => l.text)).toEqual(["const b = 2;"]);
    expect(result.lines.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["const b = 3;"]);
  });

  test("replace_all replaces every match", async () => {
    const original = "x\nfoo\ny\nfoo\nz\n";
    const path = await file(original);
    const result = diffOf(
      await previewEdit("Edit", { file_path: path, old_string: "foo", new_string: "bar", replace_all: true }, root),
    );
    expect(result.added).toBe(2);
    expect(result.removed).toBe(2);
    expect(applyRows(original, result.lines)).toBe("x\nbar\ny\nbar\nz\n");
  });

  test("a text that is not in the file falls back to the raw input with the reason", async () => {
    const path = await file("one\ntwo\n");
    const result = rawOf(await previewEdit("Edit", { file_path: path, old_string: "three", new_string: "3" }, root));
    expect(result.reason).toBe(NOT_FOUND);
  });

  test("two matches without replace_all fall back", async () => {
    const path = await file("foo\nfoo\n");
    const result = rawOf(await previewEdit("Edit", { file_path: path, old_string: "foo", new_string: "bar" }, root));
    expect(result.reason).toContain("2 times");
    expect(result.reason).toContain("replace_all");
  });

  test("replace_all with no match falls back", async () => {
    const path = await file("a\n");
    const result = rawOf(
      await previewEdit("Edit", { file_path: path, old_string: "z", new_string: "y", replace_all: true }, root),
    );
    expect(result.reason).toBe(NOT_FOUND);
  });

  test("an edit that changes nothing falls back", async () => {
    const path = await file("a\n");
    const result = rawOf(await previewEdit("Edit", { file_path: path, old_string: "a", new_string: "a" }, root));
    expect(result.reason).toContain("identical");
  });

  test("an empty old_string on an existing file falls back", async () => {
    const path = await file("a\n");
    const result = rawOf(await previewEdit("Edit", { file_path: path, old_string: "", new_string: "b" }, root));
    expect(result.reason).toContain("empty");
  });

  test("a missing file falls back, unless old_string is empty (which creates it)", async () => {
    const missing = join(root, "does-not-exist.txt");
    expect(rawOf(await previewEdit("Edit", { file_path: missing, old_string: "a", new_string: "b" }, root)).reason).toContain(
      "does not exist",
    );
    const created = diffOf(await previewEdit("Edit", { file_path: missing, old_string: "", new_string: "hi\n" }, root));
    expect(created.newFile).toBe(true);
    expect(created.added).toBe(1);
    expect(created.removed).toBe(0);
  });

  test("new text with trailing whitespace falls back (the tool may strip it), except in markdown", async () => {
    const path = await file("a\nb\n");
    expect(rawOf(await previewEdit("Edit", { file_path: path, old_string: "b", new_string: "b  " }, root)).reason).toContain(
      "trailing whitespace",
    );
    const md = await file("a\nb\n", `doc${counter++}.md`);
    expect(diffOf(await previewEdit("Edit", { file_path: md, old_string: "b", new_string: "b  " }, root)).added).toBe(1);
  });

  test("a relative path resolves against cwd", async () => {
    await mkdir(join(root, "sub"), { recursive: true });
    const path = await file("hello\nworld\n", `sub/rel${counter++}.txt`);
    const name = path.slice(join(root, "sub").length + 1);
    const result = diffOf(await previewEdit("Edit", { file_path: name, old_string: "world", new_string: "there" }, join(root, "sub")));
    expect(result.path).toBe(path);
    rawOf(await previewEdit("Edit", { file_path: name, old_string: "world", new_string: "there" }, root));
  });
});

describe("Claude MultiEdit", () => {
  test("edits apply in order on the running result", async () => {
    const original = "alpha\nbeta\ngamma\n";
    const path = await file(original);
    const result = diffOf(
      await previewEdit(
        "MultiEdit",
        {
          file_path: path,
          edits: [
            { old_string: "alpha", new_string: "ALPHA" },
            // matches text the first edit produced (together with the line after it), without being inside its new text
            { old_string: "ALPHA\nbeta", new_string: "X" },
            { old_string: "gamma", new_string: "g" },
          ],
        },
        root,
      ),
    );
    expect(applyRows(original, result.lines)).toBe("X\ng\n");
  });

  test("a later old_string inside an earlier new_string is refused by the tool, so there is no diff", async () => {
    const path = await file("alpha\nbeta\ngamma\n");
    const reason = "Cannot edit file: old_string is a substring of a new_string from a previous edit.";
    const result = rawOf(
      await previewEdit(
        "MultiEdit",
        { file_path: path, edits: [{ old_string: "alpha", new_string: "ALPHA\nextra" }, { old_string: "extra", new_string: "EXTRA" }] },
        root,
      ),
    );
    expect(result.reason).toBe(`edit 2 of 2: ${reason}`);
    // the check ignores the old_string's trailing line breaks
    const trailing = rawOf(
      await previewEdit(
        "MultiEdit",
        { file_path: path, edits: [{ old_string: "alpha", new_string: "ALPHA\nextra" }, { old_string: "extra\n", new_string: "EXTRA\n" }] },
        root,
      ),
    );
    expect(trailing.reason).toBe(`edit 2 of 2: ${reason}`);
  });

  test("an empty new_string drops the line break after old_string in each edit", async () => {
    const original = "alpha\nbeta\ngamma\ndelta\n";
    const path = await file(original);
    const result = diffOf(
      await previewEdit(
        "MultiEdit",
        { file_path: path, edits: [{ old_string: "beta", new_string: "" }, { old_string: "gamma", new_string: "" }] },
        root,
      ),
    );
    expect(applyRows(original, result.lines)).toBe("alpha\ndelta\n");
    expect([result.added, result.removed]).toEqual([0, 2]);
  });

  test("an edit that does not match names its position", async () => {
    const path = await file("a\nb\n");
    const result = rawOf(
      await previewEdit(
        "MultiEdit",
        { file_path: path, edits: [{ old_string: "a", new_string: "x" }, { old_string: "a", new_string: "y" }] },
        root,
      ),
    );
    expect(result.reason).toBe(`edit 2 of 2: ${NOT_FOUND}`);
  });

  test("replace_all inside MultiEdit", async () => {
    const original = "k\nk\nm\n";
    const path = await file(original);
    const result = diffOf(
      await previewEdit(
        "MultiEdit",
        { file_path: path, edits: [{ old_string: "k", new_string: "j", replace_all: true }] },
        root,
      ),
    );
    expect(applyRows(original, result.lines)).toBe("j\nj\nm\n");
  });

  test("an empty edits list falls back", async () => {
    const path = await file("a\n");
    rawOf(await previewEdit("MultiEdit", { file_path: path, edits: [] }, root));
  });
});

describe("Write (Claude and pi)", () => {
  test("a new file is everything added", async () => {
    const path = join(root, `new${counter++}.txt`);
    for (const [tool, input] of [
      ["Write", { file_path: path, content: "a\nb\n" }],
      ["write", { path, content: "a\nb\n" }],
    ] as const) {
      const result = diffOf(await previewEdit(tool, input, root));
      expect(result.newFile).toBe(true);
      expect(result.added).toBe(2);
      expect(result.removed).toBe(0);
      expect(result.lines.map((l) => l.kind)).toEqual(["hunk", "add", "add"]);
    }
  });

  test("an existing file shows what is replaced", async () => {
    const original = "one\ntwo\n";
    const path = await file(original);
    for (const [tool, input] of [
      ["Write", { file_path: path, content: "one\n2\n" }],
      ["write", { path, content: "one\n2\n" }],
    ] as const) {
      const result = diffOf(await previewEdit(tool, input, root));
      expect(result.newFile).toBe(false);
      expect(result.added).toBe(1);
      expect(result.removed).toBe(1);
      expect(applyRows(original, result.lines)).toBe("one\n2\n");
    }
  });

  test("writing identical content is a diff with no changes", async () => {
    const path = await file("same\n");
    const result = diffOf(await previewEdit("write", { path, content: "same\n" }, root));
    expect(result.added + result.removed).toBe(0);
    expect(result.lines).toEqual([]);
  });

  test("pi write shows a changed line ending or BOM as it is, not hidden", async () => {
    const path = await file("a\r\nb\r\n");
    const result = diffOf(await previewEdit("write", { path, content: "a\nb\n" }, root));
    expect(result.removed).toBe(2);
    expect(result.lines.find((l) => l.kind === "remove")!.text).toBe("a\\r");
    const bom = await file("﻿a\n");
    const withBom = diffOf(await previewEdit("write", { path: bom, content: "a\n" }, root));
    expect(withBom.lines.find((l) => l.kind === "remove")!.text).toBe("\\ufeffa");
  });

  test("Claude Write over a CRLF or BOM file falls back (how the tool writes them is not known)", async () => {
    const crlf = await file("a\r\nb\r\n");
    expect(rawOf(await previewEdit("Write", { file_path: crlf, content: "a\n" }, root)).reason).toContain("CRLF");
    const bom = await file("﻿a\n");
    expect(rawOf(await previewEdit("Write", { file_path: bom, content: "a\n" }, root)).reason).toContain("BOM");
    const fresh = join(root, `fresh${counter++}.txt`);
    rawOf(await previewEdit("Write", { file_path: fresh, content: "a\r\nb\r\n" }, root));
  });
});

describe("pi edit", () => {
  test("each edit matches once in the original text and is applied", async () => {
    const original = "one\ntwo\nthree\nfour\n";
    const path = await file(original);
    const result = diffOf(
      await previewEdit(
        "edit",
        { path, edits: [{ oldText: "one", newText: "1" }, { oldText: "four", newText: "4" }] },
        root,
      ),
    );
    expect(applyRows(original, result.lines)).toBe("1\ntwo\nthree\n4\n");
  });

  test("overlapping edits fall back", async () => {
    const path = await file("abcdef\n");
    const result = rawOf(
      await previewEdit("edit", { path, edits: [{ oldText: "abcd", newText: "X" }, { oldText: "cdef", newText: "Y" }] }, root),
    );
    expect(result.reason).toContain("overlap");
  });

  test("an old text that only matches loosely falls back with the exact-match reason", async () => {
    // pi would match this after normalising smart quotes, trailing spaces and dashes: never guess
    const quotes = await file("say “hello”\n");
    expect(rawOf(await previewEdit("edit", { path: quotes, edits: [{ oldText: 'say "hello"', newText: "x" }] }, root)).reason).toBe(
      NOT_FOUND,
    );
    const spaces = await file("a  \nb\n");
    expect(rawOf(await previewEdit("edit", { path: spaces, edits: [{ oldText: "a\nb", newText: "x" }] }, root)).reason).toBe(
      NOT_FOUND,
    );
    const missing = await file("one\n");
    expect(rawOf(await previewEdit("edit", { path: missing, edits: [{ oldText: "zzz", newText: "x" }] }, root)).reason).toBe(NOT_FOUND);
  });

  test("a second edit cannot match text the first one writes (all edits match the original)", async () => {
    const path = await file("a\nb\n");
    const result = rawOf(
      await previewEdit("edit", { path, edits: [{ oldText: "a", newText: "zzz" }, { oldText: "zzz", newText: "q" }] }, root),
    );
    expect(result.reason).toBe(`edit 2 of 2: ${NOT_FOUND}`);
  });

  test("a text that matches twice, or twice once matched loosely, falls back", async () => {
    const twice = await file("foo\nfoo\n");
    expect(rawOf(await previewEdit("edit", { path: twice, edits: [{ oldText: "foo", newText: "x" }] }, root)).reason).toContain(
      "unique",
    );
    // exactly one exact match, but pi counts matches after loose normalisation: the second line differs by trailing spaces only
    const loose = await file("foo\nfoo   \n");
    expect(rawOf(await previewEdit("edit", { path: loose, edits: [{ oldText: "foo\n", newText: "x\n" }] }, root)).reason).toContain(
      "unique",
    );
  });

  test("an empty old text and a no-op both fall back", async () => {
    const path = await file("a\n");
    expect(rawOf(await previewEdit("edit", { path, edits: [{ oldText: "", newText: "x" }] }, root)).reason).toContain("empty");
    expect(rawOf(await previewEdit("edit", { path, edits: [{ oldText: "a", newText: "a" }] }, root)).reason).toContain("nothing");
  });

  test("pi's argument forms: edits as a JSON string, one edit object, legacy oldText/newText", async () => {
    const path = await file("a\nb\n");
    const expected = "A\nb\n";
    for (const input of [
      { path, edits: JSON.stringify([{ oldText: "a", newText: "A" }]) },
      { path, edits: { oldText: "a", newText: "A" } },
      { path, oldText: "a", newText: "A" },
    ]) {
      expect(applyRows("a\nb\n", diffOf(await previewEdit("edit", input, root)).lines)).toBe(expected);
    }
  });

  test("a leading @ and a relative path resolve as pi resolves them", async () => {
    const path = await file("a\nb\n");
    const name = path.slice(root.length + 1);
    const result = diffOf(await previewEdit("edit", { path: `@${name}`, edits: [{ oldText: "a", newText: "A" }] }, root));
    expect(result.path).toBe(path);
  });

  test("a missing file falls back", async () => {
    const result = rawOf(await previewEdit("edit", { path: join(root, "nope.txt"), edits: [{ oldText: "a", newText: "b" }] }, root));
    expect(result.reason).toContain("does not exist");
  });
});

describe("line endings and BOM", () => {
  test("a CRLF file: pi writes CRLF back, so the diff shows lines without the carriage returns", async () => {
    const path = await file("a\r\nb\r\nc\r\n");
    const result = diffOf(await previewEdit("edit", { path, edits: [{ oldText: "b", newText: "B" }] }, root));
    expect(result.crlf).toBe(true);
    expect(result.lines.filter((l) => l.kind === "remove").map((l) => l.text)).toEqual(["b"]);
    expect(result.lines.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["B"]);
    expect(result.lines.some((l) => l.text.includes("\\r"))).toBe(false);
  });

  test("an old text written with CRLF still matches a CRLF file in pi", async () => {
    const path = await file("a\r\nb\r\nc\r\n");
    const result = diffOf(await previewEdit("edit", { path, edits: [{ oldText: "a\r\nb", newText: "x\r\ny" }] }, root));
    expect(result.removed).toBe(2);
    expect(result.added).toBe(2);
  });

  test("a file pi would rewrite beyond the edit (mixed endings, a lone CR) falls back", async () => {
    const mixed = await file("a\r\nb\nc\r\n");
    expect(rawOf(await previewEdit("edit", { path: mixed, edits: [{ oldText: "a", newText: "A" }] }, root)).reason).toContain("line endings");
    const lone = await file("a\rb\n");
    rawOf(await previewEdit("edit", { path: lone, edits: [{ oldText: "b", newText: "B" }] }, root));
  });

  test("a BOM is kept by pi and is not part of what the edit matches or shows", async () => {
    const path = await file("﻿first\nsecond\n");
    const result = diffOf(await previewEdit("edit", { path, edits: [{ oldText: "first", newText: "FIRST" }] }, root));
    expect(result.lines.filter((l) => l.kind === "remove").map((l) => l.text)).toEqual(["first"]);
  });

  test("Claude Edit and MultiEdit on a CRLF or BOM file fall back", async () => {
    const crlf = await file("a\r\nb\r\n");
    expect(rawOf(await previewEdit("Edit", { file_path: crlf, old_string: "a", new_string: "x" }, root)).reason).toContain("CRLF");
    const bom = await file("﻿a\n");
    expect(
      rawOf(await previewEdit("MultiEdit", { file_path: bom, edits: [{ old_string: "a", new_string: "x" }] }, root)).reason,
    ).toContain("BOM");
  });

  test("Claude Edit text containing a carriage return falls back", async () => {
    const path = await file("a\nb\n");
    rawOf(await previewEdit("Edit", { file_path: path, old_string: "a", new_string: "x\r" }, root));
  });

  test("no newline at the end of the file is shown, and is exact", async () => {
    const path = await file("a\nb");
    const result = diffOf(await previewEdit("Edit", { file_path: path, old_string: "b", new_string: "c" }, root));
    expect(result.lines.map((l) => l.text)).toEqual(["@@ -1,2 +1,2 @@", "a", "b", "\\ No newline at end of file", "c", "\\ No newline at end of file"]);
    const added = await file("a\nb");
    const grew = diffOf(await previewEdit("Edit", { file_path: added, old_string: "b", new_string: "b\n" }, root));
    expect(grew.added).toBe(1);
    expect(grew.removed).toBe(1);
  });
});

describe("files that cannot be previewed", () => {
  test("a directory", async () => {
    const dir = join(root, `dir${counter++}`);
    await mkdir(dir);
    expect(rawOf(await previewEdit("Edit", { file_path: dir, old_string: "a", new_string: "b" }, root)).reason).toContain("directory");
    expect(rawOf(await previewEdit("write", { path: dir, content: "x" }, root)).reason).toContain("directory");
  });

  test("a binary file", async () => {
    const path = await file(new Uint8Array([104, 105, 0, 10, 119]));
    expect(rawOf(await previewEdit("Edit", { file_path: path, old_string: "hi", new_string: "ho" }, root)).reason).toContain("binary");
    expect(rawOf(await previewEdit("write", { path, content: "x" }, root)).reason).toContain("binary");
  });

  test("a file that is not valid UTF-8 (the tool would write replacement characters over it)", async () => {
    const path = await file(new Uint8Array([104, 105, 10, 0xff, 0xfe, 10]));
    expect(rawOf(await previewEdit("Edit", { file_path: path, old_string: "hi", new_string: "ho" }, root)).reason).toContain("UTF-8");
  });

  test("a file over the size cap, with the default 1 MB and with a smaller cap", async () => {
    const big = await file(`${"x".repeat(1023)}\n`.repeat(1025));
    expect(rawOf(await previewEdit("Edit", { file_path: big, old_string: "x", new_string: "y" }, root)).reason).toContain("too large");
    const small = await file("0123456789\n");
    expect(rawOf(await previewEdit("write", { path: small, content: "x\n" }, root, { maxBytes: 5 })).reason).toContain("too large");
    expect(diffOf(await previewEdit("write", { path: small, content: "x\n" }, root)).removed).toBe(1);
  });

  test("new content over the size cap", async () => {
    const path = join(root, `huge${counter++}.txt`);
    expect(rawOf(await previewEdit("write", { path, content: "y".repeat(100) }, root, { maxBytes: 50 })).reason).toContain("too large");
  });

  test("an unreadable file", async () => {
    if (process.getuid?.() === 0) return; // root reads everything
    const path = await file("secret\n");
    await chmod(path, 0o000);
    try {
      expect(rawOf(await previewEdit("Edit", { file_path: path, old_string: "secret", new_string: "x" }, root)).reason).toContain("EACCES");
    } finally {
      await chmod(path, 0o600);
    }
  });

  test("a change too large to diff in good time", async () => {
    const path = await file(Array.from({ length: 3000 }, (_, i) => `old ${i}\n`).join(""));
    const content = Array.from({ length: 3000 }, (_, i) => `new ${i}\n`).join("");
    const started = performance.now();
    expect(rawOf(await previewEdit("write", { path, content }, root)).reason).toContain("too large to preview");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("a small edit in a big file is quick and shows only its hunk", async () => {
    const original = Array.from({ length: 20000 }, (_, i) => `line ${i}\n`).join("");
    const path = await file(original);
    const started = performance.now();
    const result = diffOf(await previewEdit("edit", { path, edits: [{ oldText: "line 10000\n", newText: "changed\n" }] }, root));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(result.lines[0]).toEqual({ kind: "hunk", text: "@@ -9998,7 +9998,7 @@" });
    expect(result.lines.length).toBe(9);
  });
});

describe("input", () => {
  test("a tool that is not an edit tool, and input in the wrong shape, fall back", async () => {
    expect(rawOf(await previewEdit("Bash", { command: "ls" }, root)).reason).toContain("Bash");
    expect(rawOf(await previewEdit("Edit", { file_path: 3 }, root)).reason).toContain("shape");
    expect(rawOf(await previewEdit("Edit", null, root)).reason).toContain("shape");
    expect(rawOf(await previewEdit("edit", { path: "a", edits: [{ oldText: 1, newText: "x" }] }, root)).reason).toContain("shape");
    expect(rawOf(await previewEdit("Write", { file_path: "a" }, root)).reason).toContain("shape");
    expect(rawOf(await previewEdit("Edit", { file_path: "a", old_string: "a", new_string: "b", replace_all: "yes" }, root)).reason).toContain("shape");
  });

  test("a path starting with ~ is not guessed for Claude's tools", async () => {
    rawOf(await previewEdit("Edit", { file_path: "~/x.txt", old_string: "a", new_string: "b" }, root));
  });
});

describe("display escaping", () => {
  test("control characters are shown as escapes in the rows and the patch, never raw", async () => {
    const path = await file("plain\n");
    const content = "red \u001b[31mtext\u001b[0m\nbidi ‮evil\nbell \u0007\nnul \u0000\n";
    const result = diffOf(await previewEdit("write", { path, content }, root));
    const text = result.lines.map((l) => l.text).join("\n");
    expect(text).toContain("red \\u001b[31mtext\\u001b[0m");
    expect(text).toContain("bidi \\u202eevil");
    expect(text).toContain("bell \\u0007");
    expect(text).toContain("nul \\u0000");
    for (const bad of ["\u001b", "‮", "\u0007", "\u0000"]) {
      expect(text.includes(bad)).toBe(false);
      expect(result.patch.includes(bad)).toBe(false);
    }
  });

  test("escaping is on the displayed rows only: an old text with a control character still matches", async () => {
    const path = await file("a\u001bb\nc\n");
    const result = diffOf(await previewEdit("edit", { path, edits: [{ oldText: "a\u001bb", newText: "x" }] }, root));
    expect(result.lines.find((l) => l.kind === "remove")!.text).toBe("a\\u001bb");
  });

  test("the path is escaped too", async () => {
    const result = diffOf(await previewEdit("write", { path: join(root, "bad‮name.txt"), content: "x\n" }, root));
    expect(result.path.includes("‮")).toBe(false);
    expect(result.path).toContain("\\u202e");
  });
});

describe("hunks", () => {
  test("a tab is shown as an escape, like every control character", async () => {
    const path = await file("a\n\tb\n");
    const result = diffOf(await previewEdit("edit", { path, edits: [{ oldText: "\tb", newText: "\tc" }] }, root));
    expect(result.lines.filter((l) => l.kind === "remove").map((l) => l.text)).toEqual(["\\tb"]);
  });

  test("the diff is a shortest one: moving a line shows one removal and one addition", async () => {
    const original = "a\nb\nc\nd\ne\n";
    const path = await file(original);
    const result = diffOf(await previewEdit("write", { path, content: "a\nc\nd\ne\nb\n" }, root));
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
  });

  test("three lines of context, separate hunks for distant edits, exact line numbers", async () => {
    const original = Array.from({ length: 30 }, (_, i) => `l${i + 1}\n`).join("");
    const path = await file(original);
    const result = diffOf(
      await previewEdit("edit", { path, edits: [{ oldText: "l5\n", newText: "five\n" }, { oldText: "l25\n", newText: "" }] }, root),
    );
    expect(result.lines.filter((l) => l.kind === "hunk").map((l) => l.text)).toEqual(["@@ -2,7 +2,7 @@", "@@ -22,7 +22,6 @@"]);
    expect(result.lines.find((l) => l.kind === "add")).toEqual({ kind: "add", text: "five", newLine: 5 });
    expect(result.lines.filter((l) => l.kind === "remove")).toEqual([
      { kind: "remove", text: "l5", oldLine: 5 },
      { kind: "remove", text: "l25", oldLine: 25 },
    ]);
    expect(applyRows(original, result.lines)).toBe(original.replace("l5\n", "five\n").replace("l25\n", ""));
  });
});

// A small seeded generator, so a failure is reproducible.
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("property: the rows applied to the original give exactly the tool's result", () => {
  const vocabulary = ["a", "b", "c", "ab", "foo bar", "x = 1;", "", "  indented", "ünïcode", "日本語", "}"];

  test("random small files and random exact single-match edits (Claude Edit and pi edit)", async () => {
    const next = random(20240607);
    const pick = <T>(items: T[]) => items[Math.floor(next() * items.length)]!;
    let compared = 0;
    for (let round = 0; round < 250; round++) {
      const lineCount = 1 + Math.floor(next() * 12);
      const original = Array.from({ length: lineCount }, () => pick(vocabulary)).join("\n") + "\n";
      // an exact substring, sometimes a whole run of lines, sometimes only part of one
      const start = Math.floor(next() * original.length);
      const end = Math.min(original.length, start + 1 + Math.floor(next() * 14));
      const oldText = original.slice(start, end);
      const newText = next() < 0.2 ? "" : Array.from({ length: Math.floor(next() * 3) }, () => pick(vocabulary)).join("\n");
      const first = original.indexOf(oldText);
      if (first !== start && first === -1) continue;
      if (original.indexOf(oldText, first + 1) !== -1) continue; // not a single exact match
      const expected = original.slice(0, first) + newText + original.slice(first + oldText.length);
      // Claude's applier also takes the line break after a deleted text that does not end in one.
      const claudeExpected =
        newText === "" && !oldText.endsWith("\n") && original.includes(`${oldText}\n`)
          ? original.slice(0, first) + original.slice(first + oldText.length + 1)
          : expected;
      if ([expected, claudeExpected].some((text) => text === original || text === "" || !text.endsWith("\n"))) continue; // the applier models files that end in a newline
      const path = await file(original);

      const claude = await previewEdit("Edit", { file_path: path, old_string: oldText, new_string: newText }, root);
      const pi = await previewEdit("edit", { path, edits: [{ oldText, newText }] }, root);
      for (const [result, want] of [[claude, claudeExpected], [pi, expected]] as const) {
        // either an exact diff or an honest fallback, never a wrong diff
        if (result.kind === "raw") continue;
        compared++;
        expect(applyRows(original, result.lines)).toBe(want);
        expect(result.added).toBe(result.lines.filter((l) => l.kind === "add").length);
        expect(result.removed).toBe(result.lines.filter((l) => l.kind === "remove").length);
      }
      // the cases that must never fall back: plain text without loose-match ambiguity
      if (!/[ \t]\n|[ \t]$/.test(newText) && !/[ \t](\n|$)/.test(original)) expect(claude.kind).toBe("diff");
    }
    expect(compared).toBeGreaterThan(150);
  });
});

describe("Claude Edit: the empty new_string rule, exactly", () => {
  test("an old_string that ends in a line break is replaced as written", async () => {
    const original = "alpha\nbeta\ngamma\n";
    const path = await file(original);
    const result = diffOf(await previewEdit("Edit", { file_path: path, old_string: "beta\n", new_string: "" }, root));
    expect(applyRows(original, result.lines)).toBe("alpha\ngamma\n");
  });

  test("text in the middle of a line, not followed by a line break, leaves the line", async () => {
    const original = "alpha\nbeta gamma\n";
    const path = await file(original);
    const result = diffOf(await previewEdit("Edit", { file_path: path, old_string: "beta", new_string: "" }, root));
    expect(applyRows(original, result.lines)).toBe("alpha\n gamma\n");
  });

  test("the last line without a line break is just emptied of the text", async () => {
    const original = "alpha\nbeta";
    const path = await file(original);
    const result = diffOf(await previewEdit("Edit", { file_path: path, old_string: "beta", new_string: "" }, root));
    expect(result.removed).toBe(1);
    expect(result.lines.some((line) => line.kind === "add")).toBe(false);
  });

  test("the uniqueness check still comes first", async () => {
    const path = await file("a\nb\na\n");
    const result = rawOf(await previewEdit("Edit", { file_path: path, old_string: "a", new_string: "" }, root));
    expect(result.reason).toContain("matches 2 times");
  });

  test("a deletion with replace_all where no occurrence is followed by a line break is a plain replace", async () => {
    const original = "a b a";
    const path = await file(original);
    const result = diffOf(await previewEdit("Edit", { file_path: path, old_string: "a", new_string: "", replace_all: true }, root));
    expect(result.lines.filter((line) => line.kind === "add").map((line) => line.text)).toEqual([" b "]);
  });
});

describe("Claude notebooks", () => {
  test("Edit and MultiEdit on an .ipynb file fall back", async () => {
    const path = await file('{"cells": []}\n', "book.ipynb");
    const edit = await previewEdit("Edit", { file_path: path, old_string: "cells", new_string: "rows" }, root);
    const multi = await previewEdit("MultiEdit", { file_path: path, edits: [{ old_string: "cells", new_string: "rows" }] }, root);
    expect(rawOf(edit).reason).toContain(".ipynb");
    expect(rawOf(multi).reason).toContain(".ipynb");
  });
});

describe("the file the tool writes: path escaping and symlinks", () => {
  test("a path with a newline or another control character is one escaped line", async () => {
    const result = diffOf(await previewEdit("Write", { file_path: join(root, "a\nb\u001b[2Jc.txt"), content: "x\n" }, root));
    expect(result.path).toBe(`${join(root, "a")}\\nb\\u001b[2Jc.txt`);
    expect(result.path).not.toContain("\n");
    expect(result.patch.split("\n")[0]).toBe(`--- ${result.path}`);
  });

  test("a symlink to a file outside the folder shows the target, with the path given in via", async () => {
    const outside = await mkdtemp(join(tmpdir(), "edit-preview-outside-"));
    try {
      const target = join(await realpath(outside), "secret.txt");
      await writeFile(target, "secret\n");
      const link = join(root, `link-${counter++}.txt`);
      await symlink(target, link);
      for (const [tool, input] of [
        ["Write", { file_path: link, content: "changed\n" }],
        ["Edit", { file_path: link, old_string: "secret", new_string: "changed" }],
        ["write", { path: link, content: "changed\n" }],
        ["edit", { path: link, edits: [{ oldText: "secret", newText: "changed" }] }],
      ] as const) {
        const result = diffOf(await previewEdit(tool, input, root));
        expect(result.path).toBe(target);
        expect(result.via).toBe(link);
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("a file under a symlinked folder shows the real file, even when it does not exist yet", async () => {
    const outside = await mkdtemp(join(tmpdir(), "edit-preview-outside-"));
    try {
      const real = await realpath(outside);
      const dir = join(root, `dir-link-${counter++}`);
      await symlink(real, dir);
      const result = diffOf(await previewEdit("Write", { file_path: join(dir, "new.txt"), content: "x\n" }, root));
      expect(result.path).toBe(join(real, "new.txt"));
      expect(result.via).toBe(join(dir, "new.txt"));
      expect(result.newFile).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("a plain file in a folder that is itself reached through a symlink is not marked", async () => {
    const path = await file("x\n");
    const result = diffOf(await previewEdit("Write", { file_path: path, content: "y\n" }, root));
    expect(result.path).toBe(path);
    expect(result.via).toBeUndefined();
  });

  test("a dangling symlink stays raw", async () => {
    const link = join(root, `dangling-${counter++}.txt`);
    await symlink(join(root, "does-not-exist-anywhere.txt"), link);
    expect(rawOf(await previewEdit("Write", { file_path: link, content: "y\n" }, root)).reason).toContain("symlink");
  });
});
