import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/** How long a foreground `bash` or `Task` call may run before marcsh stops it (davi7's limit for child tool calls). */
export const TOOL_CALL_TIMEOUT_MS = 180_000;

const BASH_TOOL = "bash";
const BUILTIN_BASH = "builtin:bash";
const BASH_TIMEOUT_EXTENSION = "marcsh-bash-timeout";
/** What pi's bash tool says when its `timeout` ran out; the number is the seconds it was given. */
const PI_TIMED_OUT = /Command timed out after [\d.]+ seconds/;

function formatTimeout(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

/** What the model reads when a call ran out of time: what to use instead for longer work. */
export function toolTimeoutMessage(toolName: string, ms: number): string {
  return (
    `Tool call "${toolName}" timed out after ${formatTimeout(ms)} and was stopped. ` +
    "For longer work, run the command with bg_start, or start the subagent with Task and `background: true`."
  );
}

export class ToolCallTimeoutError extends Error {
  constructor(toolName: string, ms: number) {
    super(toolTimeoutMessage(toolName, ms));
    this.name = "ToolCallTimeoutError";
  }
}

/** Whether the call asked to run in the background, which no timeout applies to. */
export function isBackgroundCall(params: unknown): boolean {
  return typeof params === "object" && params !== null && (params as Record<string, unknown>).background === true;
}

/**
 * Runs `execute` with a signal that aborts when `signal` does or when `ms` have passed. Rejects with a
 * `ToolCallTimeoutError` on timeout, and with the abort reason when `signal` aborts first, without waiting
 * for `execute` to notice.
 *
 * Ported from davi7 `extensions/shared/tool-call-timeout.ts` (MIT).
 */
export async function runWithToolTimeout<T>(toolName: string, ms: number, signal: AbortSignal | undefined, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeoutController = new AbortController();
  const executionSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
  const timeoutError = new ToolCallTimeoutError(toolName, ms);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(timeoutError);
      timeoutController.abort(timeoutError);
    }, ms);
  });

  let removeAbortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error(`Tool call "${toolName}" was aborted.`));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });

  try {
    return await Promise.race([execute(executionSignal), timeout, aborted]);
  } finally {
    clearTimeout(timer);
    removeAbortListener?.();
  }
}

/**
 * Gives pi's own `bash` tool a `timeout` of `ms` when the call passes none, so pi's bash stops the command and its
 * process tree itself. A `background` field on a bash call changes nothing: only `bg_start` and `Task` run in the background. The tool is not replaced, so its shell settings stay.
 *
 * pi runs a call with the object its first `tool_call` handler gets as `event.input`, and hands the same event to
 * each handler in load order. The timeout goes on that object, and the handlers after this one (pack hooks,
 * approval) get a copy of the model's input instead, which nothing changes: approval asks, and the host keeps,
 * what the model sent. So this extension loads ahead of them. Its `tool_result` handler takes the timeout off again
 * for the result handlers after it. The transcript keeps the model's arguments too (pi validates a copy of them).
 *
 * For the calls it gave a timeout, pi's `Command timed out after N seconds` becomes marcsh's message. A call blocked
 * after this handler ran gets no `tool_result`, only `tool_execution_end`, which forgets it too.
 */
export function createBashTimeoutExtension(ms: number = TOOL_CALL_TIMEOUT_MS): InlineExtension {
  return {
    name: BASH_TIMEOUT_EXTENSION,
    hidden: true,
    factory: (pi) => {
      const defaulted = new Set<string>();
      // A `bash` from an extension may take no `timeout`: only pi's own gets one.
      const isPiBash = () => pi.getAllTools().some((tool) => tool.name === BASH_TOOL && tool.sourceInfo.path === BUILTIN_BASH);

      pi.on("tool_call", (event) => {
        if (event.toolName !== BASH_TOOL) return;
        const input = event.input as Record<string, unknown>;
        if (input.timeout !== undefined && input.timeout !== null) return;
        if (!isPiBash()) return;
        event.input = { ...input };
        input.timeout = ms / 1_000;
        defaulted.add(event.toolCallId);
      });

      pi.on("tool_result", (event) => {
        if (!defaulted.delete(event.toolCallId)) return;
        delete event.input.timeout;
        if (!event.isError) return;
        let changed = false;
        const content = event.content.map((block) => {
          if (block.type !== "text" || !PI_TIMED_OUT.test(block.text)) return block;
          changed = true;
          return { ...block, text: block.text.replace(PI_TIMED_OUT, toolTimeoutMessage(BASH_TOOL, ms)) };
        });
        return changed ? { content } : undefined;
      });

      // A call aborted after this handler ran ends without a `tool_result`.
      pi.on("tool_execution_end", (event) => {
        defaulted.delete(event.toolCallId);
      });
    },
  };
}
