import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentsDir, deleteSessionImages, discardClipboardImage, isPng, PENDING_SESSION, prunePendingImages, saveClipboardImage } from "./clipboard-images";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
const mode = (path: string) => statSync(path).mode & 0o777;

let root: string;
let outside: string;
beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), "marcsh-images-")), "attachments");
  outside = mkdtempSync(join(tmpdir(), "marcsh-images-outside-"));
});
afterEach(() => {
  rmSync(join(root, ".."), { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("attachmentsDir", () => {
  const saved = process.env.MARCSH_ATTACHMENTS_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.MARCSH_ATTACHMENTS_DIR;
    else process.env.MARCSH_ATTACHMENTS_DIR = saved;
  });

  test("is MARCSH_ATTACHMENTS_DIR when it is an absolute path", () => {
    process.env.MARCSH_ATTACHMENTS_DIR = "/var/marcsh-images";
    expect(attachmentsDir()).toBe("/var/marcsh-images");
  });
  test("ignores a relative MARCSH_ATTACHMENTS_DIR (it would put images in the project), and falls back to ~/.marcsh/attachments", () => {
    process.env.MARCSH_ATTACHMENTS_DIR = "images";
    expect(attachmentsDir()).toBe(join(homedir(), ".marcsh", "attachments"));
  });
});

describe("isPng", () => {
  test("checks the PNG signature", () => {
    expect(isPng(PNG)).toBe(true);
    expect(isPng(Buffer.from("GIF89a\u0001\u0000"))).toBe(false);
    expect(isPng(new Uint8Array())).toBe(false);
  });
});

describe("saveClipboardImage", () => {
  test("writes a private file in a private folder", async () => {
    const path = await saveClipboardImage(PNG, "s1", root);

    expect(path).toBe(join(root, "s1", "clipboard-1.png"));
    expect(mode(path)).toBe(0o600);
    expect(mode(join(root, "s1"))).toBe(0o700);
  });

  test("refuses a session folder that is a symbolic link, and leaves its target alone", async () => {
    mkdirSync(root, { recursive: true });
    symlinkSync(outside, join(root, "s1"));
    const before = mode(outside);

    await expect(saveClipboardImage(PNG, "s1", root)).rejects.toThrow("not a folder");

    expect(readdirSync(outside)).toEqual([]);
    expect(mode(outside)).toBe(before);
  });

  test("a write that fails leaves no partial file behind", async () => {
    await expect(saveClipboardImage({} as Uint8Array, "s1", root)).rejects.toThrow();

    expect(readdirSync(join(root, "s1"))).toEqual([]);
  });
});

describe("discardClipboardImage", () => {
  test("deletes an image this process saved", async () => {
    const path = await saveClipboardImage(PNG, "s1", root);

    await discardClipboardImage(path);

    expect(existsSync(path)).toBe(false);
  });

  test("leaves any other file alone: one marcsh did not save, or a pasted path", async () => {
    mkdirSync(join(root, "s1"), { recursive: true });
    const foreign = join(root, "s1", "clipboard-9.png");
    writeFileSync(foreign, PNG);
    const pasted = join(outside, "shot.png");
    writeFileSync(pasted, PNG);

    await discardClipboardImage(foreign);
    await discardClipboardImage(pasted);

    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(pasted)).toBe(true);
  });
});

describe("deleteSessionImages", () => {
  test("removes the session's folder and nothing else", async () => {
    const path = await saveClipboardImage(PNG, "s1", root);
    const other = await saveClipboardImage(PNG, "s2", root);

    deleteSessionImages("s1", root);

    expect(existsSync(join(root, "s1"))).toBe(false);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  test("a folder that is a symbolic link loses only the link", () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(outside, "keep.txt"), "x");
    symlinkSync(outside, join(root, "s1"));

    deleteSessionImages("s1", root);

    expect(existsSync(join(root, "s1"))).toBe(false);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  });

  test("a session without images is fine", () => {
    expect(() => deleteSessionImages("none", root)).not.toThrow();
  });
});

describe("prunePendingImages", () => {
  test("removes the images saved before a session had an ID", async () => {
    const pending = await saveClipboardImage(PNG, PENDING_SESSION, root);
    const kept = await saveClipboardImage(PNG, "s1", root);

    await prunePendingImages(root);

    expect(existsSync(pending)).toBe(false);
    expect(existsSync(kept)).toBe(true);
  });
});
