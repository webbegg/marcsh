import { execFile } from "node:child_process";

/**
 * Inside tmux without extended keys, Shift+Enter reaches marcsh as a plain Enter and sends a half-written prompt; Ctrl+J still
 * adds a new line. marcsh asks tmux once whether extended keys are off, so the prompt can show `ctrl+j new line`.
 *
 * - `none`: not inside tmux.
 * - `tmux-basic`: inside tmux with `extended-keys off`.
 * - `extended`: inside tmux with `extended-keys on` or `always`.
 * - `unknown`: inside tmux but tmux did not answer (missing, slow or an unexpected value). No hint is shown.
 */
export type TmuxKeys = "none" | "tmux-basic" | "extended" | "unknown";

export type TmuxOptions = {
  env?: Record<string, string | undefined>;
  /** Runs a command and resolves with its stdout; rejects when it fails. */
  run?: (command: string[]) => Promise<string>;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 1000;
const EXTENDED_KEYS_COMMAND = ["tmux", "show", "-gv", "extended-keys"];

function runCommand(command: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const [file, ...args] = command;
    execFile(file!, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
  });
}

/** Never rejects and never takes longer than `timeoutMs`. */
export async function detectTmuxKeys(options: TmuxOptions = {}): Promise<TmuxKeys> {
  const env = options.env ?? process.env;
  if (!env.TMUX) return "none";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run = options.run ?? ((command: string[]) => runCommand(command, timeoutMs));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      run(EXTENDED_KEYS_COMMAND),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("tmux did not answer")), timeoutMs);
      }),
    ]);
    const value = answer.trim().toLowerCase();
    if (value === "off") return "tmux-basic";
    if (value === "on" || value === "always") return "extended";
    return "unknown";
  } catch {
    return "unknown";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let cached: TmuxKeys | undefined;
let pending: Promise<TmuxKeys> | undefined;

/** The answer once it is known, `undefined` before. Never starts the check. */
export function cachedTmuxKeys(): TmuxKeys | undefined {
  return cached;
}

/**
 * The answer, asked once per process. Under `bun test` the check is skipped (the answer is `unknown`) so a test run inside tmux
 * does not change what the tests see; a test that needs an answer primes it or passes its own options.
 */
export function tmuxKeys(options?: TmuxOptions): Promise<TmuxKeys> {
  if (cached !== undefined) return Promise.resolve(cached);
  if (!options && process.env.NODE_ENV === "test") return Promise.resolve("unknown");
  pending ??= detectTmuxKeys(options).then((result) => (cached = result));
  return pending;
}

/** Sets the cached answer (tests). */
export function primeTmuxKeys(value: TmuxKeys): void {
  cached = value;
  pending = undefined;
}

/** Forgets the cached answer (tests). */
export function resetTmuxKeys(): void {
  cached = undefined;
  pending = undefined;
}
