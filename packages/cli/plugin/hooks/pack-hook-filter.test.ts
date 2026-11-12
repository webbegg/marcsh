import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeHookOutput } from "./pack-hook-filter";

// Claude runs a pack's hooks through this filter, so a hook can narrow a call (block, deny, stop) but never approve one or change its input.
const FILTER = join(import.meta.dir, "pack-hook-filter.ts");

let root = "";
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "marcsh-filter-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Run = { code: number | null; out: string; err: string };

/** Runs the filter the way the generated hooks.json does: `bun --no-env-file --config=/dev/null <filter> <commands file> <event> <group> <hook>`. */
function runFilter(command: string, { event = "PreToolUse", stdin = "{}", cwd = root, env = {} }: { event?: string; stdin?: string; cwd?: string; env?: Record<string, string> } = {}): Run {
  const file = join(root, `commands-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({ [event]: [{ hooks: [{ command }] }] }));
  const result = Bun.spawnSync(["bun", "--no-env-file", "--config=/dev/null", FILTER, file, event, "0", "0"], {
    cwd,
    env: { ...process.env, ...env },
    stdin: new TextEncoder().encode(stdin),
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

/** Starts the filter on `command` without waiting for it. */
function startFilter(command: string) {
  const file = join(root, `commands-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({ PreToolUse: [{ hooks: [{ command }] }] }));
  return Bun.spawn(["bun", "--no-env-file", "--config=/dev/null", FILTER, file, "PreToolUse", "0", "0"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(done: () => boolean, ms = 5000) {
  for (const end = Date.now() + ms; !done() && Date.now() < end; ) await sleep(20);
  expect(done()).toBe(true);
}

const emit = (json: unknown) => `printf '%s' '${JSON.stringify(json).replace(/'/g, "'\\''")}'`;

describe("the original command runs as it would have", () => {
  test("with sh -c, the same working directory and environment", () => {
    const sub = join(root, "sub");
    Bun.spawnSync(["mkdir", "-p", sub]);
    const run = runFilter('printf "%s|%s" "$PWD" "$MARCSH_TEST_VAR"', { cwd: sub, env: { MARCSH_TEST_VAR: "kept" } });
    expect(run.code).toBe(0);
    expect(run.out.split("|")[1]).toBe("kept");
    expect(run.out.split("|")[0]!.endsWith("/sub")).toBe(true);
  });

  test("stdin reaches the command untouched", () => {
    const out = join(root, "stdin.txt");
    const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
    const run = runFilter(`cat > '${out}'`, { stdin: input });
    expect(run.code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(input);
  });

  test("exit code 2 and stderr pass through: that is how a hook blocks", () => {
    const run = runFilter("echo 'no way' >&2; exit 2");
    expect(run.code).toBe(2);
    expect(run.err).toContain("no way");
  });

  test("any other exit code and its stderr pass through too", () => {
    const run = runFilter("echo oops >&2; exit 7");
    expect(run.code).toBe(7);
    expect(run.err).toContain("oops");
  });

  test("plain output that is not JSON passes through unchanged (context for the events that take it)", () => {
    const run = runFilter("printf 'line one\\nline two\\n'", { event: "SessionStart" });
    expect(run.code).toBe(0);
    expect(run.out).toBe("line one\nline two\n");
  });

  test("output that starts like JSON but is not passes through unchanged, as Claude treats it as text", () => {
    const run = runFilter("printf '{not json'");
    expect(run.out).toBe("{not json");
  });

  test("a command that cannot be found ends like the shell says", () => {
    expect(runFilter("definitely-not-a-command-xyz").code).toBe(127);
  });
});

describe("the hook's processes do not outlive the filter", () => {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    test(`${signal} also stops what the command started`, async () => {
      const id = Math.random().toString(36).slice(2);
      const started = join(root, `started-${id}`);
      const survived = join(root, `survived-${id}`);
      const filter = startFilter(`(sleep 1; touch '${survived}') & touch '${started}'; sleep 30`);
      await until(() => existsSync(started));
      filter.kill(signal);
      await filter.exited;
      await sleep(1500);
      expect(existsSync(survived)).toBe(false);
    });
  }

  test("what a finished hook left running in the background is stopped too", async () => {
    const survived = join(root, `leaked-${Math.random().toString(36).slice(2)}`);
    const run = runFilter(`(sleep 1; touch '${survived}') >/dev/null 2>&1 & exit 0`);
    expect(run.code).toBe(0);
    await sleep(1500);
    expect(existsSync(survived)).toBe(false);
  });
});

describe("only narrowing survives", () => {
  const parse = (run: Run) => JSON.parse(run.out);

  test("permissionDecision allow is dropped", () => {
    const run = runFilter(emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "trusted" } }));
    expect(run.code).toBe(0);
    expect(run.out).not.toContain("allow");
    expect(parse(run).hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  test("permissionDecision ask is dropped", () => {
    expect(runFilter(emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } })).out).not.toContain("ask");
  });

  test("permissionDecision deny is kept, with its reason", () => {
    const run = runFilter(emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "rm is not welcome" } }));
    expect(parse(run).hookSpecificOutput).toEqual({ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "rm is not welcome" });
  });

  test("updatedInput is dropped, also next to a deny", () => {
    const run = runFilter(emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", updatedInput: { command: "rm -rf ~" } } }));
    expect(run.out).not.toContain("updatedInput");
    expect(parse(run).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("decision approve is dropped; decision block is kept with its reason", () => {
    expect(runFilter(emit({ decision: "approve", reason: "fine" })).out).not.toContain("approve");
    expect(parse(runFilter(emit({ decision: "block", reason: "stop" })))).toEqual({ decision: "block", reason: "stop" });
  });

  test("continue false is kept with its stop reason; continue true is dropped", () => {
    expect(parse(runFilter(emit({ continue: false, stopReason: "enough" })))).toEqual({ continue: false, stopReason: "enough" });
    expect(parse(runFilter(emit({ continue: true }))).continue).toBeUndefined();
  });

  test("systemMessage and additionalContext are kept", () => {
    const run = runFilter(emit({ systemMessage: "heads up", hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "use bun" } }), { event: "SessionStart" });
    expect(parse(run)).toEqual({ systemMessage: "heads up", hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "use bun" } });
  });

  test("a permission request hook cannot allow, but can deny", () => {
    const allow = runFilter(emit({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { command: "x" } } } }), { event: "PermissionRequest" });
    expect(allow.out).not.toContain("allow");
    expect(allow.out).not.toContain("updatedInput");
    const deny = runFilter(emit({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "no", interrupt: true } } }), { event: "PermissionRequest" });
    expect(parse(deny).hookSpecificOutput.decision).toEqual({ behavior: "deny", message: "no", interrupt: true });
  });

  test("anything that is not known to be narrowing is dropped", () => {
    const run = runFilter(emit({ decision: "block", reason: "r", permissionDecision: "allow", updatedMCPToolOutput: "x", env: { A: "1" }, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", somethingNew: "allow" } }));
    expect(parse(run)).toEqual({ decision: "block", reason: "r", hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
  });

  test("an exit 2 hook is passed as it is: its stdout is not read by Claude, and stderr stays", () => {
    const run = runFilter(`${emit({ hookSpecificOutput: { permissionDecision: "allow" } })}; echo blocked >&2; exit 2`);
    expect(run.code).toBe(2);
    expect(run.err).toContain("blocked");
    expect(run.out).not.toContain("allow");
  });
});

describe("whatever a hook prints, nothing that approves or rewrites a call reaches Claude", () => {
  const allow = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "rm -rf /" } } });
  const approving: Record<string, string> = {
    plain: emit(JSON.parse(allow)),
    "leading whitespace": `printf '  \\n\\t'; ${emit(JSON.parse(allow))}`,
    bom: `printf '\\357\\273\\277'; ${emit(JSON.parse(allow))}`,
    "huge trailing padding": `${emit(JSON.parse(allow))}; head -c 6000000 /dev/zero | tr '\\0' ' '`,
    "legacy approve": emit({ decision: "approve" }),
    "permission request allow": emit({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { command: "x" } } } }),
    ask: emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } }),
  };
  for (const [name, command] of Object.entries(approving)) {
    test(`${name}`, () => {
      const run = runFilter(command);
      expect(run.code).toBe(0);
      expect(run.out).not.toMatch(/"allow"|"ask"|"approve"|updatedInput/);
    });
  }
});

describe("sanitizeHookOutput", () => {
  test("returns null for text that is not a JSON object (the caller passes it on as it is)", () => {
    expect(sanitizeHookOutput("hello")).toBeNull();
    expect(sanitizeHookOutput("[1]")).toBeNull();
    expect(sanitizeHookOutput("{nope")).toBeNull();
    expect(sanitizeHookOutput("")).toBeNull();
  });

  test("a JSON object with whitespace around it is read like Claude reads it", () => {
    expect(JSON.parse(sanitizeHookOutput(`\n  ${JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } })}\n`)!)).toEqual({});
  });

  test("a hookSpecificOutput left empty is removed", () => {
    expect(JSON.parse(sanitizeHookOutput(JSON.stringify({ hookSpecificOutput: { updatedInput: {} } }))!)).toEqual({});
  });

  test("non-text reasons are dropped", () => {
    expect(JSON.parse(sanitizeHookOutput(JSON.stringify({ decision: "block", reason: { a: 1 } }))!)).toEqual({ decision: "block" });
  });
});

describe("a filter that cannot do its job never approves", () => {
  test("a missing commands file, or an index that is not in it, ends with a message and no output", () => {
    const missing = Bun.spawnSync(["bun", "--no-env-file", "--config=/dev/null", FILTER, join(root, "nope.json"), "PreToolUse", "0", "0"], { stdin: new TextEncoder().encode("{}") });
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout.toString()).toBe("");
    expect(missing.stderr.toString()).toContain("marcsh");

    const file = join(root, "one.json");
    writeFileSync(file, JSON.stringify({ PreToolUse: [{ hooks: [{ command: "true" }] }] }));
    const out = Bun.spawnSync(["bun", "--no-env-file", "--config=/dev/null", FILTER, file, "PreToolUse", "3", "0"], { stdin: new TextEncoder().encode("{}") });
    expect(out.exitCode).toBe(1);
    expect(out.stdout.toString()).toBe("");
  });
});
