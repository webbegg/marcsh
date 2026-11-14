import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachmentLabel,
  loadAttachments,
  MAX_ATTACHMENT_BYTES,
  mentionFor,
  parsePastedPaths,
  referenceText,
  resolvePastedAttachments,
  splitAttachments,
  type Attachment,
  type AttachmentFs,
} from "./attachments";
import { renderTranscript } from "./transcript";

// S6: pasting or dropping a path to an image or file attaches it to the next message (image types and PDF up to 20 MB).

let dir: string;
let cwd: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-attachments-"));
  cwd = join(dir, "project");
  mkdirSync(join(cwd, "docs"), { recursive: true });
  writeFileSync(join(cwd, "shot.png"), "png-bytes");
  writeFileSync(join(cwd, "My Shot.png"), "spaced");
  writeFileSync(join(cwd, "spec.pdf"), "%PDF-1.4");
  writeFileSync(join(cwd, "notes.txt"), "text");
  writeFileSync(join(cwd, "docs", "a.md"), "# a");
  writeFileSync(join(dir, "outside.jpg"), "jpg");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("parsePastedPaths", () => {
  test("splits on whitespace and newlines, honors quotes and backslash escapes", () => {
    expect(parsePastedPaths("/a/b.png /c/d.pdf")).toEqual(["/a/b.png", "/c/d.pdf"]);
    expect(parsePastedPaths("/a/My\\ Shot.png")).toEqual(["/a/My Shot.png"]);
    expect(parsePastedPaths(`'/a/My Shot.png' "/c/d e.pdf"`)).toEqual(["/a/My Shot.png", "/c/d e.pdf"]);
    expect(parsePastedPaths("/a/b.png\n/c/d.pdf\n")).toEqual(["/a/b.png", "/c/d.pdf"]);
  });

  test("decodes file:// URLs and refuses remote hosts", () => {
    expect(parsePastedPaths("file:///a/My%20Shot.png")).toEqual(["/a/My Shot.png"]);
    expect(parsePastedPaths("file://localhost/a/b.png")).toEqual(["/a/b.png"]);
    expect(parsePastedPaths("file://otherhost/a/b.png")).toBeNull();
  });

  test("prose, URLs and unbalanced quotes are not paths", () => {
    expect(parsePastedPaths("fix the bug in the parser")).toBeNull();
    expect(parsePastedPaths("https://example.com/a.png")).toBeNull();
    expect(parsePastedPaths(`"/a/b.png`)).toBeNull();
    expect(parsePastedPaths("   ")).toBeNull();
  });

  test("absolute, home and dot-relative paths and bare image or PDF names count; a bare word does not", () => {
    expect(parsePastedPaths("./x/y")).toEqual(["./x/y"]);
    expect(parsePastedPaths("../y")).toEqual(["../y"]);
    expect(parsePastedPaths("logo.png")).toEqual(["logo.png"]);
    expect(parsePastedPaths("package.json")).toBeNull();
    expect(parsePastedPaths("src")).toBeNull();
  });

  test("more than 32 paths is not a drop", () => {
    expect(parsePastedPaths(Array.from({ length: 33 }, (_, i) => `/a/${i}.png`).join(" "))).toBeNull();
    expect(parsePastedPaths(Array.from({ length: 32 }, (_, i) => `/a/${i}.png`).join(" "))).toHaveLength(32);
  });
});

describe("resolvePastedAttachments", () => {
  test("an image, a PDF and another file resolve with their kinds and MIME types, without bytes", async () => {
    const found = await resolvePastedAttachments(`${join(cwd, "shot.png")} ${join(cwd, "spec.pdf")} ${join(cwd, "notes.txt")}`, cwd);

    expect(found?.problems).toEqual([]);
    expect(found?.attachments).toEqual([
      { path: join(cwd, "shot.png"), mime: "image/png", kind: "image" },
      { path: join(cwd, "spec.pdf"), mime: "application/pdf", kind: "pdf" },
      { path: join(cwd, "notes.txt"), mime: "text/plain", kind: "file" },
    ]);
    expect(found?.attachments.every((a) => !("bytes" in a))).toBe(true);
  });

  test("escaped, quoted and file:// forms of a dropped path resolve to the same file", async () => {
    const spaced = join(cwd, "My Shot.png");
    for (const text of [spaced.replace(/ /g, "\\ "), `'${spaced}'`, `file://${spaced.replace(/ /g, "%20")}`]) {
      const found = await resolvePastedAttachments(text, cwd);
      expect(found?.attachments.map((a) => a.path)).toEqual([spaced]);
    }
  });

  test("a relative image path resolves against the session cwd; a bare relative non-image name stays text", async () => {
    expect((await resolvePastedAttachments("shot.png", cwd))?.attachments.map((a) => a.path)).toEqual([join(cwd, "shot.png")]);
    expect((await resolvePastedAttachments("./docs/a.md", cwd))?.attachments).toEqual([{ path: join(cwd, "docs", "a.md"), mime: "text/markdown", kind: "file" }]);
    expect(await resolvePastedAttachments("notes.txt", cwd)).toBeNull();
  });

  test("a path outside the cwd attaches too", async () => {
    expect((await resolvePastedAttachments(join(dir, "outside.jpg"), cwd))?.attachments).toEqual([{ path: join(dir, "outside.jpg"), mime: "image/jpeg", kind: "image" }]);
  });

  test("text that is not (all) existing files stays ordinary text", async () => {
    expect(await resolvePastedAttachments("fix the bug", cwd)).toBeNull();
    expect(await resolvePastedAttachments(join(cwd, "missing.png"), cwd)).toBeNull();
    expect(await resolvePastedAttachments(`${join(cwd, "shot.png")} ${join(cwd, "missing.png")}`, cwd)).toBeNull();
    // A directory is not a file.
    expect(await resolvePastedAttachments(join(cwd, "docs"), cwd)).toBeNull();
  });

  test("an image or PDF over 20 MB is refused with a reason and the rest still attach", async () => {
    const big: AttachmentFs = {
      stat: async (path) => ({ size: path.endsWith("big.png") ? MAX_ATTACHMENT_BYTES + 1 : 10, isFile: true }),
      readFile: async () => new Uint8Array(),
    };

    const found = await resolvePastedAttachments("/x/big.png /x/ok.pdf", "/x", big);

    expect(found?.attachments.map((a) => a.path)).toEqual(["/x/ok.pdf"]);
    expect(found?.problems).toEqual(["big.png is larger than 20 MB, so it was not attached."]);
  });

  test("exactly 20 MB is accepted", async () => {
    const edge: AttachmentFs = { stat: async () => ({ size: MAX_ATTACHMENT_BYTES, isFile: true }), readFile: async () => new Uint8Array() };
    expect((await resolvePastedAttachments("/x/a.png", "/x", edge))?.attachments).toHaveLength(1);
  });

  test("a file that cannot be read is refused with a reason", async () => {
    const denied: AttachmentFs = {
      stat: async () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
      readFile: async () => new Uint8Array(),
    };

    const found = await resolvePastedAttachments("/x/a.png", "/x", denied);

    expect(found?.attachments).toEqual([]);
    expect(found?.problems).toEqual(["Could not read a.png: EACCES."]);
  });
});

describe("loadAttachments (at send time)", () => {
  const png: Attachment = { path: "/x/a.png", mime: "image/png", kind: "image" };
  const pdf: Attachment = { path: "/x/b.pdf", mime: "application/pdf", kind: "pdf" };
  const text: Attachment = { path: "/x/c.txt", mime: "text/plain", kind: "file" };

  test("reads the bytes of images and PDFs only", async () => {
    const read: string[] = [];
    const fs: AttachmentFs = {
      stat: async () => ({ size: 3, isFile: true }),
      readFile: async (path) => {
        read.push(path);
        return new Uint8Array([1, 2, 3]);
      },
    };

    const { loaded, failed } = await loadAttachments([png, pdf, text], fs);

    expect(read).toEqual(["/x/a.png", "/x/b.pdf"]);
    expect(loaded).toEqual([{ ...png, bytes: new Uint8Array([1, 2, 3]) }, { ...pdf, bytes: new Uint8Array([1, 2, 3]) }, text]);
    expect(failed).toEqual([]);
  });

  test("a file that vanished, grew past the cap, or fails to read is reported and left out", async () => {
    const fs: AttachmentFs = {
      stat: async (path) => {
        if (path === "/x/a.png") throw Object.assign(new Error("gone"), { code: "ENOENT" });
        return { size: path === "/x/b.pdf" ? MAX_ATTACHMENT_BYTES + 1 : 1, isFile: true };
      },
      readFile: async () => new Uint8Array(),
    };

    const { loaded, failed } = await loadAttachments([png, pdf], fs);

    expect(loaded).toEqual([]);
    expect(failed.map((f) => [f.attachment.path, f.reason])).toEqual([
      ["/x/a.png", "Could not read a.png: ENOENT."],
      ["/x/b.pdf", "b.pdf is larger than 20 MB."],
    ]);
  });
});

describe("references and labels", () => {
  test("@path uses the project-relative form inside the cwd and the absolute path outside it", () => {
    expect(mentionFor("/p/docs/a.md", "/p")).toBe("@docs/a.md");
    expect(mentionFor("/other/a.md", "/p")).toBe("@/other/a.md");
    expect(mentionFor("/p/../q/a.md", "/p")).toBe("@/q/a.md");
  });

  test("referenceText lists the mentions on a line of their own", () => {
    const refs: Attachment[] = [
      { path: "/p/a.png", mime: "image/png", kind: "image" },
      { path: "/p/b.pdf", mime: "application/pdf", kind: "pdf" },
    ];
    expect(referenceText("look", refs, "/p")).toBe("look\n@a.png @b.pdf");
    expect(referenceText("", refs, "/p")).toBe("@a.png @b.pdf");
    expect(referenceText("look", [], "/p")).toBe("look");
  });

  test("labels name the kind and the file", () => {
    expect(attachmentLabel({ path: "/p/a.png", mime: "image/png", kind: "image" })).toBe("[image: a.png]");
    expect(attachmentLabel({ path: "/p/b.pdf", mime: "application/pdf", kind: "pdf" })).toBe("[pdf: b.pdf]");
    expect(attachmentLabel({ path: "/p/c.txt", mime: "text/plain", kind: "file" })).toBe("[file: c.txt]");
  });
});

describe("splitAttachments", () => {
  const png: Attachment = { path: "/p/a.png", mime: "image/png", kind: "image" };
  const pdf: Attachment = { path: "/p/b.pdf", mime: "application/pdf", kind: "pdf" };
  const txt: Attachment = { path: "/p/c.txt", mime: "text/plain", kind: "file" };

  test("an engine that takes both sends images and PDFs inline and other files as references", () => {
    expect(splitAttachments([png, pdf, txt], { image: true, pdf: true })).toEqual({ inline: [png, pdf], references: [txt], notices: [] });
  });

  test("an engine without PDF input sends the PDF as a reference and says so", () => {
    const split = splitAttachments([png, pdf], { image: true, pdf: false });
    expect(split.inline).toEqual([png]);
    expect(split.references).toEqual([pdf]);
    expect(split.notices).toEqual(["This engine cannot take PDFs as input, so b.pdf goes as an @path reference."]);
  });

  test("a model without image input sends images as references and says so once", () => {
    const split = splitAttachments([png, { ...png, path: "/p/d.png" }], { image: false, pdf: false });
    expect(split.inline).toEqual([]);
    expect(split.references).toHaveLength(2);
    expect(split.notices).toEqual(["This model cannot take images as input, so a.png, d.png go as @path references."]);
  });
});

describe("the transcript lists the attachments under the user message", () => {
  const session = {
    id: "abcdef123456",
    title: "t",
    cwd: "/p",
    engine: "claude",
    createdAt: new Date("2030-01-01T00:00:00Z"),
    updatedAt: new Date("2030-01-01T00:00:00Z"),
    messages: [
      {
        id: "m1",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "what is this?" }],
        metadata: {
          attachments: [
            { path: "/p/shot.png", mime: "image/png", kind: "image" as const },
            { path: "/p/spec.pdf", mime: "application/pdf", kind: "pdf" as const },
          ],
        },
      },
      { id: "m2", role: "user" as const, parts: [{ type: "text" as const, text: "" }], metadata: { attachments: [{ path: "/p/a.png", mime: "image/png", kind: "image" as const }] } },
    ],
  };

  test("markdown has one line per file after the text, even when the message has no text", () => {
    const md = renderTranscript(session, "md");
    expect(md).toContain("## You\n\nwhat is this?\n\n- Attached image `/p/shot.png`\n- Attached pdf `/p/spec.pdf`");
    expect(md).toContain("## You\n\n- Attached image `/p/a.png`");
  });

  test("json keeps path, MIME type and kind, never bytes", () => {
    const json = JSON.parse(renderTranscript(session, "json"));
    expect(json.messages[0].attachments).toEqual([
      { path: "/p/shot.png", mime: "image/png", kind: "image" },
      { path: "/p/spec.pdf", mime: "application/pdf", kind: "pdf" },
    ]);
    expect("attachments" in json.messages[1]).toBe(true);
  });

  test("a message without attachments has no attachments key", () => {
    const json = JSON.parse(renderTranscript({ ...session, messages: [{ id: "m", role: "user", parts: [] }] }, "json"));
    expect("attachments" in json.messages[0]).toBe(false);
  });
});
