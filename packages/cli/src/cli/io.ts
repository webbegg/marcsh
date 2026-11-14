import { writeSync } from "node:fs";

/** Where a command writes: tests collect the text, the process prints it. */
export type Io = { stdout: (text: string) => void; stderr: (text: string) => void };

/**
 * Writes all of `text` to `fd` before returning. The commands end with `process.exit`, which would cut off whatever a pipe
 * had not taken yet (a session export is megabytes), so nothing is left queued. A pipe that is full is waited for; one that was
 * closed (`| head`) ends the output quietly.
 */
function writeAll(fd: number, text: string) {
  const bytes = Buffer.from(text);
  for (let written = 0; written < bytes.length; ) {
    try {
      written += writeSync(fd, bytes, written);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") Bun.sleepSync(1);
      else if (code === "EPIPE") return;
      else throw err;
    }
  }
}

export const processIo: Io = {
  stdout: (text) => writeAll(1, text),
  stderr: (text) => writeAll(2, text),
};

/** The exit codes of the commands: the usage errors (2) are the parser's. */
export const EXIT = { ok: 0, failed: 1 } as const;
