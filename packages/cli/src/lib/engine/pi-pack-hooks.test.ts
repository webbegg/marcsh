import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileMatcher, type HooksConfig } from "../pack-hooks";
import {
  claudeToolName,
  claudeToolNames,
  createPackHooksExtension,
  judgePostToolUse,
  judgePreToolUse,
  runHookCommand,
  type HookOutcome,
} from "./pi-pack-hooks";

let dir: string;
let cwd: string;
let view: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-pack-hooks-"));
  cwd = join(dir, "project");
  view = join(dir, "view");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(view, { recursive: true });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const exit = (code: number, stdout = "", stderr = ""): HookOutcome => ({ kind: "exit", code, stdout, stderr });

describe("claudeToolName", () => {
  test("pi's tools are named the way Claude names them", () => {
    expect(
      ["bash", "edit", "write", "read", "grep", "find", "ls", "Task", "AskUserQuestion"].map(claudeToolName),
    ).toEqual(["Bash", "Edit", "Write", "Read", "Grep", "Glob", "LS", "Agent", "AskUserQuestion"]);
  });

  test("Claude renamed Task to Agent: the hook is told Agent, and a matcher written for either name matches", () => {
    expect(claudeToolName("Task")).toBe("Agent");
    expect(claudeToolNames("Task")).toEqual(["Agent", "Task"]);
    expect(claudeToolNames("bash")).toEqual(["Bash"]);
    expect(claudeToolNames("find")).toEqual(["Glob"]);
  });

  test("MCP tools already carry Claude's mcp__server__tool name; any other tool keeps its own", () => {
    expect(claudeToolName("mcp__fs__delete")).toBe("mcp__fs__delete");
    expect(claudeToolName("my_extension_tool")).toBe("my_extension_tool");
  });
});

describe("compileMatcher (Claude's rules)", () => {
  test("nothing, empty and * match every tool", () => {
    for (const matcher of [undefined, "", "*"]) expect(compileMatcher(matcher)("Anything")).toBe(true);
  });

  test("a plain name matches that tool exactly, case-sensitively", () => {
    const bash = compileMatcher("Bash");
    expect(bash("Bash")).toBe(true);
    expect(bash("BashOutput")).toBe(false);
    expect(bash("bash")).toBe(false);
    expect(bash("MyBash")).toBe(false);
  });

  test("a | list matches any of its names exactly", () => {
    const writes = compileMatcher("Edit|Write");
    expect([writes("Edit"), writes("Write"), writes("Read"), writes("EditX")]).toEqual([true, true, false, false]);
  });

  test("a name with a wildcard matches what starts and ends as it does around the *", () => {
    const mcp = compileMatcher("mcp__.*");
    expect([mcp("mcp__fs__read"), mcp("mcp__"), mcp("Bash"), mcp("xmcp__a")]).toEqual([true, true, false, false]);
    const middle = compileMatcher("mcp__.*__write");
    expect([middle("mcp__fs__write"), middle("mcp__fs__read"), middle("mcp__write")]).toEqual([true, false, false]);
    expect(compileMatcher("Notebook*")("NotebookEdit")).toBe(true);
    expect(compileMatcher("Edit|mcp__fs__*")("mcp__fs__delete")).toBe(true);
  });

  test("a matcher that is not a plain name list throws: no regular expressions", () => {
    for (const matcher of ["(", "^(Edit|Write)$", "(a+)+$", "[ab]", "Bash|", ".+"]) expect(() => compileMatcher(matcher), matcher).toThrow();
  });
});

describe("runHookCommand", () => {
  const run = (command: string, overrides: Partial<Parameters<typeof runHookCommand>[0]> = {}) =>
    runHookCommand({ command, cwd, env: { CLAUDE_PLUGIN_ROOT: view, CLAUDE_PROJECT_DIR: cwd }, input: "{}", timeoutMs: 10_000, ...overrides });

  test("runs the command with sh -c and reports the exit code, stdout and stderr", async () => {
    expect(await run("echo out; echo err >&2; exit 3")).toEqual({ kind: "exit", code: 3, stdout: "out\n", stderr: "err\n" });
    expect(await run("true")).toMatchObject({ kind: "exit", code: 0 });
  });

  test("the command runs in the session's cwd with the plugin root and project dir in its environment", async () => {
    const outcome = await run('printf "%s|%s|%s" "$(pwd -P)" "$CLAUDE_PLUGIN_ROOT" "$CLAUDE_PROJECT_DIR"');
    expect(outcome.kind).toBe("exit");
    const [pwd, root, project] = (outcome as { stdout: string }).stdout.split("|");
    expect(pwd).toBe(realpathSync(cwd));
    expect(root).toBe(view);
    expect(project).toBe(cwd);
  });

  test("the hook's stdin is the JSON it was given", async () => {
    const out = join(dir, "stdin.json");
    await run(`cat > ${out}`, { input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" }) });
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ hook_event_name: "PreToolUse", tool_name: "Bash" });
  });

  test("a hook that never reads its stdin is fine", async () => {
    expect(await run("exit 0", { input: "x".repeat(2_000_000) })).toMatchObject({ kind: "exit", code: 0 });
  });

  test("a command that outlives the timeout is killed with everything it started, and reported as a timeout", async () => {
    const marker = join(dir, "child-ran");
    const started = Date.now();
    const outcome = await run(`(sleep 1.5; touch ${marker}) & sleep 30`, { timeoutMs: 300 });
    expect(outcome).toEqual({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(5000);
    await sleep(2200);
    expect(existsSync(marker)).toBe(false);
  });

  test("aborting the signal kills the command and reports it", async () => {
    const marker = join(dir, "child-ran");
    const controller = new AbortController();
    const running = run(`(sleep 1.5; touch ${marker}) & sleep 30`, { signal: controller.signal });
    await sleep(200);
    controller.abort();
    expect(await running).toEqual({ kind: "aborted" });
    await sleep(2200);
    expect(existsSync(marker)).toBe(false);
  });

  test("a signal that is already aborted runs nothing", async () => {
    const marker = join(dir, "ran");
    const controller = new AbortController();
    controller.abort();
    expect(await run(`touch ${marker}`, { signal: controller.signal })).toEqual({ kind: "aborted" });
    expect(existsSync(marker)).toBe(false);
  });

  test("a command that cannot be started is reported as failed", async () => {
    const outcome = await run("true", { cwd: join(dir, "missing") });
    expect(outcome.kind).toBe("failed");
  });

  test("output beyond the cap is dropped, not buffered without limit", async () => {
    const outcome = await run("head -c 3000000 /dev/zero | tr '\\0' x");
    expect(outcome.kind).toBe("exit");
    expect((outcome as { stdout: string }).stdout.length).toBeLessThanOrEqual(300_000);
  });

  test("a background process that keeps the pipes open does not hold the hook up", async () => {
    const started = Date.now();
    const outcome = await run("(sleep 5 &) ; echo hi", { timeoutMs: 20_000 });
    expect(outcome).toMatchObject({ kind: "exit", code: 0, stdout: "hi\n" });
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe("judgePreToolUse: hooks can only narrow", () => {
  test("exit 2 blocks, with what the hook wrote to stderr as the reason", () => {
    expect(judgePreToolUse(exit(2, "", "no force pushes\n"))).toEqual({ block: "no force pushes" });
  });

  test("exit 2 with nothing on stderr still blocks, with a default reason", () => {
    const verdict = judgePreToolUse(exit(2));
    expect(verdict.block).toMatch(/blocked/i);
  });

  test("JSON {decision: block} blocks with its reason", () => {
    expect(judgePreToolUse(exit(0, JSON.stringify({ decision: "block", reason: "not here" })))).toEqual({ block: "not here" });
    expect(judgePreToolUse(exit(0, JSON.stringify({ decision: "block" }))).block).toBeTruthy();
  });

  test("hookSpecificOutput.permissionDecision deny blocks with its reason", () => {
    const stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "policy" } });
    expect(judgePreToolUse(exit(0, stdout))).toEqual({ block: "policy" });
  });

  test("continue: false stops the call", () => {
    expect(judgePreToolUse(exit(0, JSON.stringify({ continue: false, stopReason: "halt" })))).toEqual({ block: "halt" });
  });

  test("allow, ask, approve and an updated input have no effect: the normal approval still applies", () => {
    for (const body of [
      { hookSpecificOutput: { permissionDecision: "allow" } },
      { hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "check" } },
      { decision: "approve", reason: "fine" },
      { hookSpecificOutput: { permissionDecision: "allow", updatedInput: { command: "rm -rf /" } } },
      { hookSpecificOutput: { permissionDecision: "something-new" } },
    ]) {
      expect(judgePreToolUse(exit(0, JSON.stringify(body))), JSON.stringify(body)).toEqual({});
    }
  });

  test("a deny next to an allow is still a deny", () => {
    const stdout = JSON.stringify({ decision: "approve", hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "no" } });
    expect(judgePreToolUse(exit(0, stdout))).toEqual({ block: "no" });
  });

  test("plain text, broken JSON and no output do not block", () => {
    for (const stdout of ["", "all good", "{not json", "[]", "null", '"deny"']) expect(judgePreToolUse(exit(0, stdout)), stdout).toEqual({});
  });

  test("a JSON decision on a non-zero exit other than 2 is ignored, like Claude", () => {
    expect(judgePreToolUse(exit(1, JSON.stringify({ decision: "block", reason: "x" }), "boom"))).toMatchObject({ notice: expect.stringContaining("boom") });
  });

  test("other exit codes do not block; stderr becomes a notice", () => {
    expect(judgePreToolUse(exit(1, "", "warning: x"))).toEqual({ notice: "exit 1: warning: x" });
    expect(judgePreToolUse(exit(127, "", "")).block).toBeUndefined();
    expect(judgePreToolUse(exit(1)).notice).toBeTruthy();
  });

  test("a hook that is killed by a signal does not block", () => {
    expect(judgePreToolUse({ kind: "exit", code: null, stdout: "", stderr: "" }).block).toBeUndefined();
  });

  test("a timeout blocks (fail closed: the check did not finish), and so does a hook that could not run or a turn that ended", () => {
    expect(judgePreToolUse({ kind: "timeout" }).block).toMatch(/timed out/);
    expect(judgePreToolUse({ kind: "failed", message: "spawn sh ENOENT" }).block).toMatch(/could not run/);
    expect(judgePreToolUse({ kind: "aborted" }).block).toBeTruthy();
  });

  test("the reason has no escape sequences and is bounded", () => {
    const verdict = judgePreToolUse(exit(2, "", `\u001b[2Jbad${"x".repeat(10_000)}`));
    expect(verdict.block).not.toContain("\u001b");
    expect(verdict.block!.length).toBeLessThanOrEqual(4100);
  });
});

describe("judgePostToolUse", () => {
  test("exit 2 and a block decision are feedback for the model", () => {
    expect(judgePostToolUse(exit(2, "", "tests failed"))).toEqual({ feedback: "tests failed" });
    expect(judgePostToolUse(exit(0, JSON.stringify({ decision: "block", reason: "lint errors" })))).toEqual({ feedback: "lint errors" });
  });

  test("anything else is nothing, or a notice for the user", () => {
    expect(judgePostToolUse(exit(0, "ok"))).toEqual({});
    expect(judgePostToolUse(exit(1, "", "meh")).notice).toContain("meh");
    expect(judgePostToolUse({ kind: "timeout" }).notice).toMatch(/timed out/);
    expect(judgePostToolUse({ kind: "failed", message: "x" }).notice).toMatch(/could not run/);
    expect(judgePostToolUse({ kind: "aborted" })).toEqual({});
  });
});

// ---- the extension, against a stand-in for pi ----

type Handler = (event: any, ctx: any) => any;

function load(config: HooksConfig, options: { notify?: (message: string, level: string) => void; signal?: AbortSignal } = {}) {
  const handlers = new Map<string, Handler>();
  createPackHooksExtension({ config, view, cwd, signal: options.signal ?? new AbortController().signal, notify: options.notify as any })({
    on: (name: string, handler: Handler) => void handlers.set(name, handler),
  } as any);
  const ctx = { sessionManager: { getSessionId: () => "session-1" } };
  return {
    handlers,
    call: (toolName: string, input: Record<string, unknown> = {}) => handlers.get("tool_call")?.({ type: "tool_call", toolCallId: "c1", toolName, input }, ctx),
    result: (toolName: string, input: Record<string, unknown>, text: string, isError = false) =>
      handlers.get("tool_result")?.({ type: "tool_result", toolCallId: "c1", toolName, input, content: [{ type: "text", text }], isError, details: undefined }, ctx),
  };
}

const group = (command: string, matcher?: string, timeout?: number) => [{ ...(matcher === undefined ? {} : { matcher }), hooks: [{ command, ...(timeout === undefined ? {} : { timeout }) }] }];

describe("createPackHooksExtension", () => {
  test("registers nothing for events pi does not run", () => {
    const { handlers } = load({ SessionStart: group("true"), Stop: group("true") });
    expect([...handlers.keys()]).toEqual([]);
  });

  test("registers only the handler of the events the pack declares", () => {
    expect([...load({ PreToolUse: group("true") }).handlers.keys()]).toEqual(["tool_call"]);
    expect([...load({ PostToolUse: group("true") }).handlers.keys()]).toEqual(["tool_result"]);
    expect([...load({ PostToolUseFailure: group("true") }).handlers.keys()]).toEqual(["tool_result"]);
  });

  test("a matcher written for Task or for Agent matches pi's Task tool, which the hook is told is Agent", async () => {
    const out = join(dir, "stdin.json");
    for (const matcher of ["Task", "Agent", "Task|Agent", "Ag*"]) {
      rmSync(out, { force: true });
      await load({ PreToolUse: group(`cat > ${out}`, matcher) }).call("Task", { description: "d", prompt: "p" });
      expect(JSON.parse(readFileSync(out, "utf8")).tool_name, matcher).toBe("Agent");
    }
  });

  test("Glob, Grep and LS are what a hook is told for pi's find, grep and ls, and what its matcher is matched against", async () => {
    const ran: string[] = [];
    const notices = (name: string) => `echo ${name} >> ${join(dir, "ran.txt")}`;
    await load({ PreToolUse: [...group(notices("glob"), "Glob"), ...group(notices("grep"), "Grep"), ...group(notices("ls"), "LS"), ...group(notices("never"), "find")] }).call("find", {});
    await load({ PreToolUse: group(notices("grep"), "Grep") }).call("grep", {});
    await load({ PreToolUse: group(notices("ls"), "LS") }).call("ls", {});
    ran.push(...readFileSync(join(dir, "ran.txt"), "utf8").trim().split("\n"));
    expect(ran).toEqual(["glob", "grep", "ls"]);
  });

  test("a tool call that no matcher matches runs no hook and is not blocked", async () => {
    const marker = join(dir, "ran");
    const { call } = load({ PreToolUse: group(`touch ${marker}; exit 2`, "Bash") });
    expect(await call("read", { path: "a.ts" })).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
  });

  test("a hook that exits 2 blocks the call with its stderr", async () => {
    const { call } = load({ PreToolUse: group("echo 'use the other tool' >&2; exit 2", "Bash") });
    expect(await call("bash", { command: "ls" })).toEqual({ block: true, reason: "use the other tool" });
  });

  test("the hook gets Claude's JSON on stdin, with the Claude tool name and the session", async () => {
    const out = join(dir, "stdin.json");
    const { call } = load({ PreToolUse: group(`cat > ${out}`) });
    await call("bash", { command: "ls -la" });
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
      session_id: "session-1",
      cwd,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
    });
  });

  test("pi's path input of read, edit and write is also given as file_path, like Claude's", async () => {
    const out = join(dir, "stdin.json");
    const { call } = load({ PreToolUse: group(`cat > ${out}`) });
    await call("edit", { path: "/work/a.ts", oldText: "a", newText: "b" });
    expect(JSON.parse(readFileSync(out, "utf8")).tool_input).toEqual({ path: "/work/a.ts", file_path: "/work/a.ts", oldText: "a", newText: "b" });
    await call("find", { path: "x" });
    expect(JSON.parse(readFileSync(out, "utf8")).tool_input).toEqual({ path: "x" });
  });

  test("a deny decision in JSON blocks; allow does not", async () => {
    const deny = JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "policy" } });
    const allow = JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } });
    expect(await load({ PreToolUse: group(`echo '${deny}'`) }).call("bash", {})).toEqual({ block: true, reason: "policy" });
    expect(await load({ PreToolUse: group(`echo '${allow}'`) }).call("bash", {})).toBeUndefined();
  });

  test("when several hooks match, one block is enough, and identical commands run once", async () => {
    const counter = join(dir, "count");
    const config: HooksConfig = {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ command: `echo x >> ${counter}` }] },
        { matcher: "Bash|Edit", hooks: [{ command: `echo x >> ${counter}` }, { command: "echo nope >&2; exit 2" }] },
      ],
    };
    expect(await load(config).call("bash", {})).toEqual({ block: true, reason: "nope" });
    expect(readFileSync(counter, "utf8")).toBe("x\n");
  });

  test("a timed-out PreToolUse hook blocks the call", async () => {
    const { call } = load({ PreToolUse: group("sleep 30", undefined, 0.3) });
    const verdict = await call("bash", {});
    expect(verdict).toMatchObject({ block: true });
    expect(verdict.reason).toMatch(/timed out/);
  });

  test("a hook that is not blocking shows its stderr as a notice", async () => {
    const notices: [string, string][] = [];
    const { call } = load({ PreToolUse: group("echo careful >&2; exit 1") }, { notify: (message, level) => notices.push([message, level]) });
    expect(await call("bash", {})).toBeUndefined();
    expect(notices).toHaveLength(1);
    expect(notices[0]![0]).toContain("careful");
    expect(notices[0]![1]).toBe("warning");
  });

  test("a turn that ends while a PreToolUse hook runs blocks the call and stops the hook", async () => {
    const controller = new AbortController();
    const marker = join(dir, "after");
    const { call } = load({ PreToolUse: group(`sleep 1; touch ${marker}`) }, { signal: controller.signal });
    const running = call("bash", {});
    await sleep(150);
    controller.abort();
    expect(await running).toMatchObject({ block: true });
    await sleep(1400);
    expect(existsSync(marker)).toBe(false);
  });

  test("PostToolUse runs after the tool with tool_response, and exit 2 reaches the model as feedback", async () => {
    const out = join(dir, "post.json");
    const { result } = load({ PostToolUse: group(`cat > ${out}; echo 'lint failed' >&2; exit 2`, "Edit") });

    const changed = await result("edit", { path: "a.ts" }, "edited a.ts");

    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
      session_id: "session-1",
      cwd,
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { path: "a.ts", file_path: "a.ts" },
      tool_response: { content: [{ type: "text", text: "edited a.ts" }], is_error: false },
    });
    expect(changed.content).toEqual([
      { type: "text", text: "edited a.ts" },
      { type: "text", text: "Pack hook feedback (PostToolUse): lint failed" },
    ]);
    // The tool's own result is not turned into an error by a hook.
    expect(changed.isError).toBeUndefined();
  });

  test("PostToolUse leaves the result alone when the hook is quiet or the matcher does not match", async () => {
    expect(await load({ PostToolUse: group("true", "Edit") }).result("edit", {}, "ok")).toBeUndefined();
    const marker = join(dir, "ran");
    expect(await load({ PostToolUse: group(`touch ${marker}; exit 2`, "Edit") }).result("bash", {}, "ok")).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
  });

  test("PostToolUse runs only for a call that succeeded; a failed call runs nothing when no PostToolUseFailure is declared", async () => {
    const marker = join(dir, "ran");
    const { result } = load({ PostToolUse: group(`touch ${marker}; exit 2`) });
    expect(await result("bash", { command: "false" }, "exit 1", true)).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
  });

  test("a failed call runs the PostToolUseFailure hooks with the error, and exit 2 reaches the model as feedback", async () => {
    const out = join(dir, "failure.json");
    const ran = join(dir, "post-ran");
    const { result } = load({
      PostToolUse: group(`touch ${ran}`),
      PostToolUseFailure: group(`cat > ${out}; echo 'try another path' >&2; exit 2`, "Read"),
    });

    const changed = await result("read", { path: "missing.ts" }, "ENOENT: no such file", true);

    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
      session_id: "session-1",
      cwd,
      hook_event_name: "PostToolUseFailure",
      tool_name: "Read",
      tool_input: { path: "missing.ts", file_path: "missing.ts" },
      error: "ENOENT: no such file",
      is_interrupt: false,
    });
    expect(existsSync(ran)).toBe(false);
    expect(changed.content).toEqual([
      { type: "text", text: "ENOENT: no such file" },
      { type: "text", text: "Pack hook feedback (PostToolUseFailure): try another path" },
    ]);
  });

  test("PostToolUseFailure does not run for a call that succeeded", async () => {
    const marker = join(dir, "ran");
    const { result } = load({ PostToolUseFailure: group(`touch ${marker}`) });
    expect(await result("read", { path: "a.ts" }, "contents")).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
  });

  test("a PostToolUse timeout does not change the result; the user is told", async () => {
    const notices: string[] = [];
    const { result } = load({ PostToolUse: group("sleep 30", undefined, 0.3) }, { notify: (message) => notices.push(message) });
    expect(await result("bash", {}, "ok")).toBeUndefined();
    expect(notices.join("\n")).toMatch(/timed out/);
  });
});
