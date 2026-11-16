import { rmSync } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Where images pasted from the clipboard are kept, one folder per session: `MARCSH_ATTACHMENTS_DIR` when it is an absolute path, else
 * `~/.marcsh/attachments`. A relative one is ignored: it would follow the folder marcsh runs in, which is usually a project.
 */
export function attachmentsDir(): string {
  const moved = process.env.MARCSH_ATTACHMENTS_DIR?.trim();
  return moved && isAbsolute(moved) ? moved : join(homedir(), ".marcsh", "attachments");
}

/** The folder of images pasted before the session has an ID; emptied when marcsh starts. */
export const PENDING_SESSION = "pending";

const NUMBERED = /^clipboard-(\d+)\.png$/;
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Whether `bytes` start like a PNG file. */
export const isPng = (bytes: Uint8Array): boolean => bytes.length >= SIGNATURE.length && SIGNATURE.every((byte, i) => bytes[i] === byte);

// A session ID is a UUID; anything else is made safe to be one folder's name.
const folderName = (sessionId: string) => {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
  return safe === "" ? "_" : safe;
};

// The images this process saved: the only files `discardClipboardImage` deletes.
const saved = new Set<string>();

/** The session's folder, made private to the user (0700). One that is a link, not a folder, or another user's is refused. */
async function sessionFolder(root: string, sessionId: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = join(root, folderName(sessionId));
  await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(dir);
  if (!info.isDirectory()) throw new Error(`${dir} is not a folder (a link or a file), so the image was not saved.`);
  if (process.getuid && info.uid !== process.getuid()) throw new Error(`${dir} belongs to another user, so the image was not saved.`);
  await chmod(dir, 0o700);
  return dir;
}

/**
 * Writes a PNG from the clipboard as `<attachments>/<session>/clipboard-<n>.png`, `n` the next free number, so that it attaches like a
 * pasted path. The folders are private to the user (0700) and so is the file (0600); an existing file is never overwritten, and a write
 * that fails leaves nothing behind.
 */
export async function saveClipboardImage(bytes: Uint8Array, sessionId: string, root = attachmentsDir()): Promise<string> {
  const dir = await sessionFolder(root, sessionId);
  let next = 1;
  for (const name of await readdir(dir)) {
    const match = NUMBERED.exec(name);
    if (match) next = Math.max(next, Number(match[1]) + 1);
  }
  for (;; next++) {
    const path = join(dir, `clipboard-${next}.png`);
    let file;
    try {
      file = await open(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      await file.writeFile(bytes);
      await file.close();
    } catch (error) {
      await file.close().catch(() => {});
      await unlink(path).catch(() => {});
      throw error;
    }
    saved.add(path);
    return path;
  }
}

/** Deletes an image this process saved from the clipboard (its chip was removed before sending); any other path is left alone. */
export async function discardClipboardImage(path: string): Promise<void> {
  if (!saved.delete(path)) return;
  await unlink(path).catch(() => {});
}

/** Deletes the images pasted in a session (it was deleted). A folder that is a link loses only the link. */
export function deleteSessionImages(sessionId: string, root = attachmentsDir()): void {
  rmSync(join(root, folderName(sessionId)), { recursive: true, force: true });
}

/** Empties the folder of images pasted before their session had an ID (they belong to no session), when marcsh starts. */
export async function prunePendingImages(root = attachmentsDir()): Promise<void> {
  await rm(join(root, PENDING_SESSION), { recursive: true, force: true });
}
