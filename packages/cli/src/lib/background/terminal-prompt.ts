import { sanitizeText, type OutputView } from "./output";
import { formatElapsed, formatExit, MAX_RUNNING, type KillResult, type TerminalSnapshot } from "./terminals";

/**
 * What the model is told about background terminals: the tool descriptions and the text of their results. Ported from
 * davi7's `extensions/background-terminals/src/prompt.ts` (MIT license; see THIRD_PARTY_NOTICES.md).
 */

const KIB = 1024;
/** bg_status tails. */
const STATUS_STDOUT = { maxBytes: 16 * KIB, maxLines: 400 };
const STATUS_STDERR = { maxBytes: 8 * KIB, maxLines: 200 };
/** The result delivered when a terminal finishes: short, `/ps` and the logs have the rest. */
const RESULT_STDOUT = { maxBytes: 8 * KIB, maxLines: 80 };
const RESULT_STDERR = { maxBytes: 4 * KIB, maxLines: 40 };

export function formatSize(bytes: number): string {
  if (bytes < KIB) return `${bytes} B`;
  if (bytes < KIB * KIB) return `${(bytes / KIB).toFixed(1)} KiB`;
  return `${(bytes / KIB / KIB).toFixed(1)} MiB`;
}

export const BG_START_DESCRIPTION =
  "Start a long-running shell command as a background terminal (run with sh -c). It returns at once with an id; when the process exits you get " +
  "a message with its exit status and the end of its output. The process gets NO stdin and nothing can be sent to it later, so interactive " +
  "commands will not work; use bg_kill to stop one. Terminals belong to this session: they are killed when the session is closed or marcsh quits. " +
  `Output shown to you is cut to its end; the full logs are kept in files and in the /ps view. At most ${MAX_RUNNING} run at once.`;

export const BG_START_SNIPPET = "Run a long-lived shell command in the background (dev servers, watchers, long builds); you are told when it exits";

export const BG_START_GUIDELINES = [
  "Use bg_start for commands that run long or forever (servers, watch modes, long builds); use bash for quick commands.",
  "bg_start processes get no stdin: never start a command that needs interactive input.",
  "After bg_start, keep working: the exit result arrives by itself. Use bg_status only when you need the current output before going on.",
];

export const BG_STATUS_DESCRIPTION =
  "Show a background terminal's status and current output (cut to its end) without waiting. If it already exited, this is its final result.";
export const BG_LIST_DESCRIPTION = "List this session's background terminals (running and finished) with pid, runtime, exit status and output sizes.";
export const BG_KILL_DESCRIPTION =
  "Stop running background terminals (SIGTERM to the whole process group, then SIGKILL). Returns each one's final state; ids that already finished are reported as such.";

export function buildStartResult(snapshot: TerminalSnapshot): string {
  return (
    `Started background terminal ${snapshot.id} "${snapshot.title}" (pid ${snapshot.pid ?? "?"}, ${snapshot.cwd}).\n` +
    `It runs in the background with no stdin. You will get a message when it exits; ` +
    `use bg_status(id: "${snapshot.id}") to look at it, bg_kill to stop it, bg_list to see all.`
  );
}

/** `bt-1 [running] "dev server" (pid 12345, 3m12s, exit -, /path, stdout 1.2 KiB, stderr 0 B)` */
export function describeTerminal(snapshot: TerminalSnapshot): string {
  const details = [
    `pid ${snapshot.pid ?? "?"}`,
    formatElapsed(snapshot),
    snapshot.status === "running" ? "exit -" : formatExit(snapshot),
    snapshot.cwd,
    `stdout ${formatSize(snapshot.stdout.totalBytes)}, stderr ${formatSize(snapshot.stderr.totalBytes)}`,
  ];
  return `${snapshot.id} [${snapshot.status}] "${snapshot.title}" (${details.join(", ")})`;
}

/** The end of a text: at most `maxLines` lines and `maxBytes` bytes, starting on a whole line when it was cut. */
export function tailOf(text: string, { maxBytes, maxLines }: { maxBytes: number; maxLines: number }): { text: string; truncated: boolean } {
  let lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let truncated = false;
  if (lines.length > maxLines) {
    lines = lines.slice(-maxLines);
    truncated = true;
  }
  let tail = lines.join("\n");
  const raw = Buffer.from(tail, "utf8");
  if (raw.length > maxBytes) {
    let start = raw.length - maxBytes;
    while (start < raw.length && (raw[start]! & 0xc0) === 0x80) start++;
    tail = raw.subarray(start).toString("utf8");
    const newline = tail.indexOf("\n");
    if (newline !== -1 && newline < tail.length - 1) tail = tail.slice(newline + 1);
    truncated = true;
  }
  return { text: tail, truncated };
}

function section(label: string, view: OutputView, limits: { maxBytes: number; maxLines: number }): string {
  if (view.totalBytes === 0) return `${label}: (empty)`;
  const tail = tailOf(sanitizeText(view.text), limits);
  let text = `${label}:\n${tail.text}`;
  if (tail.truncated || view.truncatedBytes > 0) {
    text += `\n[${label} cut: showing the end of ${formatSize(view.totalBytes)}. ${view.logPath ? `Full log: ${view.logPath}` : "The full output is in /ps."}]`;
  }
  if (view.logNote) text += `\n[${view.logNote}]`;
  return text;
}

const logLine = (snapshot: TerminalSnapshot) => {
  const paths = [snapshot.stdout.logPath && `stdout ${snapshot.stdout.logPath}`, snapshot.stderr.logPath && `stderr ${snapshot.stderr.logPath}`].filter(Boolean);
  return paths.length > 0 ? `\nFull logs: ${paths.join(", ")}` : "";
};

export function buildStatusResult(snapshot: TerminalSnapshot): string {
  let text = describeTerminal(snapshot);
  if (snapshot.errorText) text += `\nError: ${snapshot.errorText}`;
  text += `\n\n${section("stdout", snapshot.stdout, STATUS_STDOUT)}`;
  text += `\n\n${section("stderr", snapshot.stderr, STATUS_STDERR)}`;
  return text + logLine(snapshot);
}

/** The result the model gets when a terminal finishes. */
export function buildTerminalResult(snapshot: TerminalSnapshot): string {
  const how = snapshot.status === "killed" ? `was killed (${formatExit(snapshot)})` : `exited (${formatExit(snapshot)})`;
  let text = `Background terminal ${snapshot.id} "${snapshot.title}" ${how} after ${formatElapsed(snapshot)}.`;
  if (snapshot.errorText) text += `\nError: ${snapshot.errorText}`;
  text += `\n\n${section("stdout", snapshot.stdout, RESULT_STDOUT)}`;
  if (snapshot.stderr.totalBytes > 0) text += `\n\n${section("stderr", snapshot.stderr, RESULT_STDERR)}`;
  return text + logLine(snapshot);
}

export function describeKill(result: KillResult): string {
  if (result.killed) return `Killed ${result.id} "${result.title}" (${result.exit}).`;
  if (result.wasRunning) return `${result.id} "${result.title}" exited on its own before the kill landed (${result.exit}).`;
  return `${result.id} "${result.title}" was already ${result.status} (${result.exit}).`;
}
