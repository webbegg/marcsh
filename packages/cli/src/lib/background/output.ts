import { chmodSync, createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What a background terminal printed: a bounded copy in memory per stream, the full stream in a private log file, and the
 * rendering that strips terminal control codes. Ported from davi7's `extensions/background-terminals/src/output.ts` and
 * `src/ui/output-view.ts` (MIT license), in plain TypeScript.
 */

/** In-memory output kept per stream. */
export const RETAINED_PER_STREAM = 2 * 1024 * 1024;
/** The full log of one stream stops here, so a process that floods its output cannot fill the disk. */
export const MAX_LOG_BYTES_PER_STREAM = 256 * 1024 * 1024;

export type OutputView = {
  /** The newest output, as it came (control codes included): at most the in-memory cap. */
  text: string;
  /** Every byte the stream has had. */
  totalBytes: number;
  /** Bytes dropped from the head of `text` (0 = complete). */
  truncatedBytes: number;
  /** The full log on disk, when it could be written. */
  logPath?: string;
  /** Why the log is incomplete, when it is. */
  logNote?: string;
};

export type LogFile = {
  path: string;
  /** False when the file wants the source paused until it drains. */
  write(chunk: string): boolean;
  /** Flushes and closes the file. */
  end(): Promise<void>;
  readonly note: string | undefined;
};

/** Opens a log for appending (mode 0600). `onDrain` resumes a paused source. */
export function openLog(path: string, { maxBytes = MAX_LOG_BYTES_PER_STREAM, onDrain }: { maxBytes?: number; onDrain?: () => void } = {}): LogFile | undefined {
  let file: ReturnType<typeof createWriteStream>;
  try {
    file = createWriteStream(path, { flags: "a", mode: 0o600 });
  } catch {
    return undefined;
  }
  let written = 0;
  let note: string | undefined;
  let ended: Promise<void> | undefined;
  file.on("error", (error) => {
    note ??= `The full log could not be written: ${error.message}`;
    onDrain?.();
  });
  return {
    path,
    write(chunk) {
      if (note !== undefined || ended || file.writableEnded) return true;
      const bytes = Buffer.byteLength(chunk, "utf8");
      if (written + bytes > maxBytes) {
        note = `The full log stopped at its ${maxBytes}-byte limit.`;
        return true;
      }
      written += bytes;
      const accepted = file.write(chunk);
      if (!accepted && onDrain) file.once("drain", onDrain);
      return accepted;
    },
    end() {
      ended ??= new Promise<void>((resolve) => {
        try {
          file.end(() => resolve());
          file.once("error", () => resolve());
        } catch {
          resolve();
        }
      });
      return ended;
    },
    get note() {
      return note;
    },
  };
}

/** One private directory (mode 0700) for a session's logs, made on first use; `dispose` removes it with its files. */
export type LogDir = {
  /** The path of a new log file in the directory; undefined once disposed or when the directory cannot be made. */
  file(name: string): string | undefined;
  readonly path: string | undefined;
  dispose(): void;
};

export function createLogDir(base = tmpdir()): LogDir {
  let dir: string | undefined;
  let state: "new" | "ready" | "failed" | "disposed" = "new";
  return {
    file(name) {
      if (state === "new") {
        try {
          dir = mkdtempSync(join(base, "marcsh-bg-"));
          chmodSync(dir, 0o700);
          state = "ready";
        } catch {
          state = "failed";
        }
      }
      return state === "ready" && dir ? join(dir, name) : undefined;
    },
    get path() {
      return dir;
    },
    dispose() {
      if (state === "ready" && dir) rmSync(dir, { recursive: true, force: true });
      state = "disposed";
    },
  };
}

/**
 * The newest output of one stream, at most `maxBytes`: whole old chunks are evicted (and counted), and a chunk larger than the
 * cap keeps its tail. Every chunk goes to the log first, so the file has all of it.
 */
export class OutputBuffer {
  private chunks: string[] = [];
  private retainedBytes = 0;
  private cachedText: string | undefined = "";
  /** Changes on every push, for the views that cache what they draw. */
  version = 0;
  totalBytes = 0;
  truncatedBytes = 0;

  constructor(
    private readonly maxBytes: number = RETAINED_PER_STREAM,
    private readonly log?: LogFile,
  ) {}

  /** False when the log wants the source paused. */
  push(chunk: string): boolean {
    if (chunk.length === 0) return true;
    let bytes = Buffer.byteLength(chunk, "utf8");
    this.totalBytes += bytes;
    const accepted = this.log ? this.log.write(chunk) : true;
    if (bytes > this.maxBytes) {
      // Everything kept precedes this chunk, so it all goes; the chunk keeps its tail, cut on a UTF-8 boundary.
      this.truncatedBytes += this.retainedBytes;
      this.chunks = [];
      this.retainedBytes = 0;
      const raw = Buffer.from(chunk, "utf8");
      let start = raw.length - this.maxBytes;
      while (start < raw.length && (raw[start]! & 0xc0) === 0x80) start++;
      this.truncatedBytes += start;
      chunk = raw.subarray(start).toString("utf8");
      bytes = raw.length - start;
    }
    this.chunks.push(chunk);
    this.retainedBytes += bytes;
    while (this.retainedBytes > this.maxBytes && this.chunks.length > 1) {
      const evicted = this.chunks.shift()!;
      const evictedBytes = Buffer.byteLength(evicted, "utf8");
      this.retainedBytes -= evictedBytes;
      this.truncatedBytes += evictedBytes;
    }
    this.cachedText = undefined;
    this.version++;
    return accepted;
  }

  view(): OutputView {
    this.cachedText ??= this.chunks.join("");
    return {
      text: this.cachedText,
      totalBytes: this.totalBytes,
      truncatedBytes: this.truncatedBytes,
      ...(this.log ? { logPath: this.log.path } : {}),
      ...(this.log?.note ? { logNote: this.log.note } : {}),
    };
  }
}

// OSC strings (titles, links) end in BEL or ST; they go before the generic pass so their payload never shows.
// eslint-disable-next-line no-control-regex
const OSC_PATTERN = /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g;
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Output as text to show: ANSI sequences and control characters removed, tabs as two spaces. Newlines stay. */
export function sanitizeText(text: string): string {
  return text.replace(OSC_PATTERN, "").replace(CSI_PATTERN, "").replace(ESCAPE_PATTERN, "").replaceAll("\t", "  ").replace(CONTROL_PATTERN, "");
}

/** Output as lines to show: a carriage-return progress line keeps its last state, and a trailing newline adds no empty line. */
export function outputLines(text: string): string[] {
  const lines = text.split("\n").map((raw) => {
    const segments = raw.split("\r");
    const last = segments.at(-1) || [...segments].reverse().find((segment) => segment) || "";
    return sanitizeText(last);
  });
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
