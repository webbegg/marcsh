// marcsh's filter for a pack's hooks on Claude: runs the pack's original command and passes on only what can narrow a tool call.
//
//   bun --no-env-file --config=/dev/null pack-hook-filter.ts <commands file> <event> <group> <hook>
//
// The generated hooks/hooks.json of a pack view calls this instead of the pack's command (see src/lib/pack-hooks.ts). The command is looked
// up in the marcsh-owned commands file by event, group and hook number, and runs with `sh -c`, in the same directory, with the same
// environment and stdin, so it behaves as it would have. Its exit code and stderr pass through (exit 2 is how a hook blocks). Its stdout
// is rewritten when it is a JSON object: a hook may block, deny or stop, but never approve a call or change its input, so
// `permissionDecision: "allow" | "ask"`, `decision: "approve"`, `updatedInput` and everything not known to be narrowing are dropped.
// Anything else on stdout is not JSON for Claude either and passes unchanged.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";

/** The narrowing part of `hookSpecificOutput`: a deny (of a tool call or of a permission request) and context for the model. */
function narrowSpecific(specific: unknown): Json | undefined {
  if (!isObject(specific)) return undefined;
  const kept: Json = {};
  if (specific.permissionDecision === "deny") {
    kept.permissionDecision = "deny";
    if (isText(specific.permissionDecisionReason)) kept.permissionDecisionReason = specific.permissionDecisionReason;
  }
  if (isText(specific.additionalContext)) kept.additionalContext = specific.additionalContext;
  const request = specific.decision;
  if (isObject(request) && request.behavior === "deny") {
    kept.decision = {
      behavior: "deny",
      ...(isText(request.message) ? { message: request.message } : {}),
      ...(typeof request.interrupt === "boolean" ? { interrupt: request.interrupt } : {}),
    };
  }
  if (Object.keys(kept).length === 0) return undefined;
  return isText(specific.hookEventName) ? { hookEventName: specific.hookEventName, ...kept } : kept;
}

/**
 * A hook's stdout as Claude may see it: null when it is not a JSON object (Claude reads it as text, and so does the caller: it is
 * passed on as it is), else the JSON with only the narrowing parts left. Nothing is kept that is not known.
 */
export function sanitizeHookOutput(stdout: string): string | null {
  const text = stdout.trim();
  if (!text.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;

  const kept: Json = {};
  if (parsed.continue === false) {
    kept.continue = false;
    if (isText(parsed.stopReason)) kept.stopReason = parsed.stopReason;
  }
  if (parsed.decision === "block") {
    kept.decision = "block";
    if (isText(parsed.reason)) kept.reason = parsed.reason;
  }
  if (isText(parsed.systemMessage)) kept.systemMessage = parsed.systemMessage;
  const specific = narrowSpecific(parsed.hookSpecificOutput);
  if (specific) kept.hookSpecificOutput = specific;
  return JSON.stringify(kept);
}

function fail(message: string): never {
  console.error(`marcsh pack hook filter: ${message}`);
  process.exit(1);
}

/** The pack's original command for `event`, group and hook number, from the commands file marcsh wrote. */
function originalCommand(file: string, event: string, group: number, hook: number): string {
  let commands: unknown;
  try {
    commands = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    fail(`cannot read ${file}`);
  }
  const groups = isObject(commands) ? commands[event] : undefined;
  const entry = Array.isArray(groups) ? groups[group] : undefined;
  const hooks = isObject(entry) ? entry.hooks : undefined;
  const command = Array.isArray(hooks) && isObject(hooks[hook]) ? (hooks[hook] as Json).command : undefined;
  if (!isText(command) || command === "") fail(`no command for ${event} ${group}.${hook} in ${file}`);
  return command;
}

function main() {
  const [file, event, group, hook] = process.argv.slice(2);
  if (!file || !event || group === undefined || hook === undefined) fail("usage: <commands file> <event> <group> <hook>");
  const command = originalCommand(file, event, Number(group), Number(hook));

  // stdin and stderr are the hook's own; only stdout comes back through here.
  const child = spawn("sh", ["-c", command], { stdio: ["inherit", "pipe", "inherit"] });
  const out: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
  // Claude ends a hook that times out by signalling this process: the command must not outlive it.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      child.kill("SIGKILL");
      process.exit(signal === "SIGTERM" ? 143 : 130);
    });
  }
  child.on("error", (error) => fail(`cannot run the command: ${error.message}`));
  child.on("close", (code) => {
    const raw = Buffer.concat(out);
    const clean = sanitizeHookOutput(raw.toString("utf8"));
    const exitCode = code ?? 1;
    const finish = () => process.exit(exitCode);
    if (clean === null && raw.length === 0) return finish();
    process.stdout.write(clean ?? raw, finish);
  });
}

if (import.meta.main) main();
