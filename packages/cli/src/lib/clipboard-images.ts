import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where images pasted from the clipboard are kept, one folder per session: `MARCSH_ATTACHMENTS_DIR`, else `~/.marcsh/attachments`. */
export function attachmentsDir(): string {
  return process.env.MARCSH_ATTACHMENTS_DIR?.trim() || join(homedir(), ".marcsh", "attachments");
}

const NUMBERED = /^clipboard-(\d+)\.png$/;

// A session ID is a UUID; anything else is made safe to be one folder's name.
const folderName = (sessionId: string) => {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
  return safe === "" ? "_" : safe;
};

/**
 * Writes a PNG from the clipboard as `<attachments>/<session>/clipboard-<n>.png`, `n` the next free number, so that it attaches like a
 * pasted path. The folders are private to the user (0700) and so is the file (0600); an existing file is never overwritten.
 */
export async function saveClipboardImage(bytes: Uint8Array, sessionId: string, root = attachmentsDir()): Promise<string> {
  const dir = join(root, folderName(sessionId));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  let next = 1;
  for (const name of await readdir(dir)) {
    const match = NUMBERED.exec(name);
    if (match) next = Math.max(next, Number(match[1]) + 1);
  }
  for (;; next++) {
    const path = join(dir, `clipboard-${next}.png`);
    try {
      await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}
