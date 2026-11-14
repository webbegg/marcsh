import { spawn } from "node:child_process";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { compileMatcher, type HookCommand, type HooksConfig } from "../pack-hooks";
import { claudeToolName, claudeToolNames } from "../tool-names";
import { BG_START_TOOL, bgStartDir, hasWorkingDir, workingDirError } from "./pi-bg-tools";
import type { NoticeLevel } from "./types";

// Pack hooks on pi, which has none: marcsh runs an enabled pack's tool-call events itself, with Claude's hook contract (see the agent-workflows skill).
// A hook can only narrow, and a PreToolUse hook that times out, cannot start or is cut off blocks the call: a check that did not finish is not a pass.
// Loaded before the approval extension, so a blocked call never asks.

export const DEFAULT_HOOK_TIMEOUT_SECONDS = 60;
const MAX_CAPTURE = 256 * 1024;
const MAX_REASON = 4000;
/** After the hook exited, how long its output pipes are waited for: a process it left running in the background may hold them open. */
const PIPE_GRACE_MS = 250;

/** Claude's tools take `file_path`; pi's take `path`. Both are given to the hook so a script written for Claude finds what it looks for. */
function toolInput(piName: string, input: Record<string, unknown>): Record<string, unknown> {
  if (piName === BG_START_TOOL) return { command: input.command };
  return ["read", "edit", "write"].includes(piName) && typeof input.path === "string" ? { ...input, file_path: input.path } : input;
}

/** marcsh's `bg_start` runs a shell command like Bash, so a pack's Bash hooks run on it too, told it is Bash: a hook cannot be bypassed by running in the background. */
const hookName = (piName: string) => (piName === BG_START_TOOL ? "Bash" : claudeToolName(piName));
const hookNames = (piName: string) => (piName === BG_START_TOOL ? ["Bash"] : claudeToolNames(piName));

/**
 * The directory the call's command runs in, which the hooks' payload names as `cwd`: a `bg_start`'s `working_dir` (resolved like
 * `bg_start` resolves it), the session's folder for anything else. The hook processes themselves always start in the session's folder.
 */
function runDirOf(piName: string, input: Record<string, unknown>, cwd: string): { dir: string; error?: string } {
  if (piName !== BG_START_TOOL || !hasWorkingDir(input)) return { dir: cwd };
  const dir = bgStartDir(cwd, input);
  return { dir, error: workingDirError(dir) };
}

export type HookOutcome =
  | { kind: "exit"; code: number | null; stdout: string; stderr: string }
  | { kind: "timeout" }
  /** The command could not be started. */
  | { kind: "failed"; message: string }
  /** The turn ended (or the signal was aborted) first. */
  | { kind: "aborted" };

export type HookRun = {
  command: string;
  cwd: string;
  env: Record<string, string | undefined>;
  input: string;
  timeoutMs: number;
  signal?: AbortSignal;
};

/** SIGKILL to the shell and everything it started: the command has a process group of its own. */
function killGroup(child: ReturnType<typeof spawn>) {
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** Runs one hook command and says how it ended. Never throws. Output beyond a cap is dropped. */
export function runHookCommand({ command, cwd, env, input, timeoutMs, signal }: HookRun): Promise<HookOutcome> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ kind: "aborted" });
    let settled = false;
    let exitCode: number | null | undefined;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let grace: ReturnType<typeof setTimeout> | undefined;

    const child = spawn("sh", ["-c", command], { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    const finish = (outcome: HookOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener("abort", onAbort);
      // Whatever the hook left running goes with it: a hook is a check, not a way to start a daemon.
      killGroup(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(outcome);
    };
    const exited = (): HookOutcome => ({ kind: "exit", code: exitCode ?? null, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    const onAbort = () => finish({ kind: "aborted" });
    const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    const collect = (into: Buffer[]) => {
      let size = 0;
      return (chunk: Buffer) => {
        if (size >= MAX_CAPTURE) return;
        into.push(chunk.subarray(0, MAX_CAPTURE - size));
        size += chunk.length;
      };
    };
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));
    child.on("error", (error) => finish({ kind: "failed", message: error.message }));
    child.on("exit", (code) => {
      exitCode = code;
      grace = setTimeout(() => finish(exited()), PIPE_GRACE_MS);
    });
    child.on("close", () => finish(exited()));
    // A hook that does not read its input closes the pipe early: that is its right.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** A hook's own words as they may reach the model and the screen: no control characters but line breaks, bounded. */
function clean(text: string): string {
  const plain = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").replace(/\p{Cf}/gu, "").trim();
  return plain.length > MAX_REASON ? `${plain.slice(0, MAX_REASON - 1)}…` : plain;
}

type Json = Record<string, unknown>;

/** The hook's stdout as a JSON object, or null: Claude reads JSON only from a hook that exited 0, and anything else is plain text. */
function jsonOutput(stdout: string): Json | null {
  const text = stdout.trim();
  if (!text.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? clean(value) : undefined);

const notice = (code: number | null, stderr: string) => `${code === null ? "ended by a signal" : `exit ${code}`}${clean(stderr) ? `: ${clean(stderr)}` : ""}`;

export type PreVerdict = { block?: string; notice?: string };

/** What a PreToolUse hook's ending means for the call. The only things it can do are block it or have a notice shown. */
export function judgePreToolUse(outcome: HookOutcome): PreVerdict {
  switch (outcome.kind) {
    case "aborted":
      return { block: "The turn ended before a pack hook finished checking this tool call." };
    case "timeout":
      return { block: "A pack hook timed out before it finished checking this tool call, so the call was blocked." };
    case "failed":
      return { block: `A pack hook could not run, so this tool call was blocked: ${clean(outcome.message)}` };
    case "exit": {
      if (outcome.code === 2) return { block: clean(outcome.stderr) || "Blocked by a pack hook." };
      if (outcome.code !== 0) return { notice: notice(outcome.code, outcome.stderr) };
      const json = jsonOutput(outcome.stdout);
      if (!json) return {};
      const specific = typeof json.hookSpecificOutput === "object" && json.hookSpecificOutput !== null ? (json.hookSpecificOutput as Json) : {};
      if (specific.permissionDecision === "deny") return { block: text(specific.permissionDecisionReason) ?? text(json.reason) ?? "Denied by a pack hook." };
      if (json.decision === "block") return { block: text(json.reason) ?? "Blocked by a pack hook." };
      if (json.continue === false) return { block: text(json.stopReason) ?? "Stopped by a pack hook." };
      // "allow", "ask", "approve", `updatedInput`...: a hook never widens what marcsh allows or changes what is asked.
      return {};
    }
  }
}

export type PostVerdict = { feedback?: string; notice?: string };

/** What a PostToolUse hook's ending means: feedback for the model (exit 2 or a block decision), or a notice for the user. */
export function judgePostToolUse(outcome: HookOutcome): PostVerdict {
  switch (outcome.kind) {
    case "aborted":
      return {};
    case "timeout":
      return { notice: "the hook timed out" };
    case "failed":
      return { notice: `the hook could not run: ${clean(outcome.message)}` };
    case "exit": {
      if (outcome.code === 2) return { feedback: clean(outcome.stderr) || "A pack hook reported a problem with this tool call." };
      if (outcome.code !== 0) return { notice: notice(outcome.code, outcome.stderr) };
      const json = jsonOutput(outcome.stdout);
      if (json?.decision === "block") return { feedback: text(json.reason) ?? "A pack hook reported a problem with this tool call." };
      return {};
    }
  }
}

type Plan = { matches: (toolName: string) => boolean; hooks: HookCommand[] }[];

const plan = (config: HooksConfig, event: string): Plan => (config[event] ?? []).map((group) => ({ matches: compileMatcher(group.matcher), hooks: group.hooks }));

/** The commands of the groups whose matcher accepts one of the tool's names, each command once (like Claude, identical commands are deduplicated). */
function selected(groups: Plan, toolNames: readonly string[]): HookCommand[] {
  const seen = new Set<string>();
  const commands: HookCommand[] = [];
  for (const group of groups) {
    if (!toolNames.some(group.matches)) continue;
    for (const hook of group.hooks) {
      if (seen.has(hook.command)) continue;
      seen.add(hook.command);
      commands.push(hook);
    }
  }
  return commands;
}

export type PackHooksOptions = {
  /** The enabled, verified hooks of the pack (see `prepareViewForTurn`); only PreToolUse, PostToolUse and PostToolUseFailure are used. */
  config: HooksConfig;
  /** The pack's plugin view: CLAUDE_PLUGIN_ROOT. */
  view: string;
  /** The session's project directory. */
  cwd: string;
  /** Aborts when the turn ends: running hooks are killed. */
  signal: AbortSignal;
  notify?: (message: string, level: NoticeLevel) => void;
};

const shorten = (command: string) => (command.length > 60 ? `${command.slice(0, 59)}…` : command);

/** The text of a tool result, for the hook that is told what failed. */
const resultText = (content: readonly { type: string; text?: string }[]) =>
  content.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n");

/**
 * The pi extension that runs a pack's PreToolUse, PostToolUse and PostToolUseFailure hooks for the session it is loaded into. Load it before the approval
 * extension. It registers nothing when the pack has no hook for these events.
 */
export function createPackHooksExtension({ config, view, cwd, signal, notify }: PackHooksOptions): ExtensionFactory {
  const pre = plan(config, "PreToolUse");
  const post = plan(config, "PostToolUse");
  const failure = plan(config, "PostToolUseFailure");
  return (pi) => {
    // The payload's `cwd` says where the call's command runs. The hook process starts in the session's folder (CLAUDE_PROJECT_DIR):
    // a `bg_start`'s `working_dir` is the model's choice and nothing has approved it when PreToolUse runs.
    const execute = (hooks: HookCommand[], payload: Json & { cwd: string }) => {
      const input = JSON.stringify(payload);
      const env = { ...process.env, CLAUDE_PLUGIN_ROOT: view, CLAUDE_PROJECT_DIR: cwd };
      return Promise.all(
        hooks.map(async (hook) => ({
          hook,
          outcome: await runHookCommand({ command: hook.command, cwd, env, input, timeoutMs: (hook.timeout ?? DEFAULT_HOOK_TIMEOUT_SECONDS) * 1000, signal }),
        })),
      );
    };
    const tell = (event: string, hook: HookCommand, message: string) => notify?.(`Pack hook ${event} (${shorten(hook.command)}): ${message}`, "warning");
    const sessionId = (ctx: { sessionManager?: { getSessionId?: () => string } }) => {
      try {
        return ctx.sessionManager?.getSessionId?.() ?? "";
      } catch {
        return "";
      }
    };

    if (pre.length > 0) {
      pi.on("tool_call", async (event, ctx) => {
        const name = hookName(event.toolName);
        const hooks = selected(pre, hookNames(event.toolName));
        if (hooks.length === 0) return undefined;
        const run = runDirOf(event.toolName, event.input, cwd);
        // The call cannot run there, so there is nothing to check: it is an error before anything runs.
        if (run.error) return { block: true, reason: run.error };
        try {
          const results = await execute(hooks, {
            session_id: sessionId(ctx),
            cwd: run.dir,
            hook_event_name: "PreToolUse",
            tool_name: name,
            tool_input: toolInput(event.toolName, event.input),
          });
          let block: string | undefined;
          for (const { hook, outcome } of results) {
            const verdict = judgePreToolUse(outcome);
            if (verdict.notice) tell("PreToolUse", hook, verdict.notice);
            block ??= verdict.block;
          }
          return block === undefined ? undefined : { block: true, reason: block };
        } catch (error) {
          // Whatever went wrong, the check did not pass.
          return { block: true, reason: `A pack hook check failed, so this tool call was blocked: ${clean(error instanceof Error ? error.message : String(error))}` };
        }
      });
    }

    if (post.length > 0 || failure.length > 0) {
      pi.on("tool_result", async (event, ctx) => {
        // A call that failed is PostToolUseFailure's, one that succeeded PostToolUse's: never both, and nothing when the pack has no hook for it.
        const eventName = event.isError ? "PostToolUseFailure" : "PostToolUse";
        const name = hookName(event.toolName);
        const hooks = selected(event.isError ? failure : post, hookNames(event.toolName));
        if (hooks.length === 0) return undefined;
        const run = runDirOf(event.toolName, event.input, cwd);
        try {
          const results = await execute(hooks, {
            session_id: sessionId(ctx),
            cwd: run.error ? cwd : run.dir,
            hook_event_name: eventName,
            tool_name: name,
            tool_input: toolInput(event.toolName, event.input),
            ...(event.isError ? { error: resultText(event.content), is_interrupt: false } : { tool_response: { content: event.content, is_error: false } }),
          });
          const feedback: string[] = [];
          for (const { hook, outcome } of results) {
            const verdict = judgePostToolUse(outcome);
            if (verdict.notice) tell(eventName, hook, verdict.notice);
            if (verdict.feedback) feedback.push(verdict.feedback);
          }
          if (feedback.length === 0) return undefined;
          // The model hears what the hook said next to the tool's own result; the result itself, and whether it was an error, are not changed.
          return { content: [...event.content, ...feedback.map((message) => ({ type: "text" as const, text: `Pack hook feedback (${eventName}): ${message}` }))] };
        } catch (error) {
          notify?.(`Pack hook ${eventName} failed: ${clean(error instanceof Error ? error.message : String(error))}`, "warning");
          return undefined;
        }
      });
    }
  };
}
