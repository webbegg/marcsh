import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorage } from "../storage";
import { createApprovalHandler, DENIED_REASON, needsApproval, offeredInPlan, PLAN_MODE_REASON, runsUnasked, type ToolSource } from "./pi-permissions";
import { guardBashCommand, type Decision, type Guard } from "./pi-guard";
import type { PermissionAsk, PermissionDecision } from "./types";

// S1a: marcsh's bg_start asks exactly like pi's bash for the same command; its other bg_* tools run unasked.
const builtin = (name: string): ToolSource => ({ name, sourceInfo: { path: `builtin:${name}` } });
const marcshBg = (name: string): ToolSource => ({ name, sourceInfo: { path: "<inline:marcsh-background>" } });
const fromExtension = (name: string): ToolSource => ({ name, sourceInfo: { path: `/agent/extensions/${name}.ts` } });
const BG = ["bg_start", "bg_status", "bg_list", "bg_kill"];
const tools = [...["read", "bash", "edit"].map(builtin), ...BG.map(marcshBg)];

function setup({ decision = "allow", guard, planMode, list = tools }: { decision?: PermissionDecision; guard?: Guard; planMode?: boolean; list?: ToolSource[] } = {}) {
  const rules = openStorage(":memory:");
  const asks: PermissionAsk[] = [];
  const handler = createApprovalHandler({
    cwd: "/work",
    rules,
    signal: new AbortController().signal,
    tools: () => list,
    planMode,
    host: {
      askPermission: async (ask) => {
        asks.push(ask);
        return decision;
      },
    },
    ...(guard ? { guard } : { guard: () => null }),
  });
  return { rules, asks, handler };
}

describe("bg_* approval (S1a)", () => {
  test("bg_status, bg_list and bg_kill run unasked; bg_start asks", () => {
    for (const name of ["bg_status", "bg_list", "bg_kill"]) expect(needsApproval(name, tools)).toBe(false);
    expect(needsApproval("bg_start", tools)).toBe(true);
  });

  test("a same-named tool from another source asks, whatever its name", () => {
    for (const name of BG) expect(needsApproval(name, [fromExtension(name)])).toBe(true);
    for (const name of BG) expect(runsUnasked(fromExtension(name))).toBe(false);
  });

  test("bg_start asks with its own name and full input, so the user sees it runs in the background", async () => {
    const { asks, handler } = setup();
    const input = { command: "npm run dev", title: "dev server" };
    expect(await handler({ toolName: "bg_start", input })).toBeUndefined();
    expect(asks).toEqual([{ toolName: "bg_start", input }]);
  });

  test("an \"always\" for bg_start is bash's rule for that command, and covers bash", async () => {
    const { rules, asks, handler } = setup({ decision: "always" });
    await handler({ toolName: "bg_start", input: { command: "make watch", title: "watch" } });
    expect(rules.hasPermissionRule({ cwd: "/work", toolName: "bash", command: "make watch" })).toBe(true);
    expect(await handler({ toolName: "bash", input: { command: "make watch" } })).toBeUndefined();
    expect(await handler({ toolName: "bg_start", input: { command: "make watch", title: "again" } })).toBeUndefined();
    expect(asks).toHaveLength(1);
    // Another command still asks.
    await handler({ toolName: "bg_start", input: { command: "make other", title: "other" } });
    expect(asks).toHaveLength(2);
  });

  test("an \"always\" for bash covers bg_start with the same command", async () => {
    const { rules, asks, handler } = setup();
    rules.addPermissionRule({ cwd: "/work", toolName: "bash", command: "npm test" });
    expect(await handler({ toolName: "bg_start", input: { command: "npm test", title: "tests" } })).toBeUndefined();
    expect(asks).toEqual([]);
  });

  test("a bash rule does not cover a bg_start from another source", async () => {
    const { rules, asks, handler } = setup({ list: [builtin("bash"), fromExtension("bg_start")] });
    rules.addPermissionRule({ cwd: "/work", toolName: "bash", command: "npm test" });
    await handler({ toolName: "bg_start", input: { command: "npm test" } });
    expect(asks).toHaveLength(1);
  });

  test("the guard judges bg_start's command: deny blocks without asking", async () => {
    const seen: string[] = [];
    const guard: Guard = (command) => (seen.push(command), { decision: "deny", reason: "No pushes from here." } as Decision);
    const { asks, handler } = setup({ guard });
    expect(await handler({ toolName: "bg_start", input: { command: "git push", title: "push" } })).toEqual({ block: true, reason: "No pushes from here." });
    expect(seen).toEqual(["git push"]);
    expect(asks).toEqual([]);
  });

  test("a guard ask always asks, with its reason, and is never stored as a rule", async () => {
    const guard: Guard = () => ({ decision: "ask", reason: "This commits on main." }) as Decision;
    const { rules, asks, handler } = setup({ guard, decision: "always" });
    rules.addPermissionRule({ cwd: "/work", toolName: "bash", command: "git commit -m x" });
    await handler({ toolName: "bg_start", input: { command: "git commit -m x", title: "commit" } });
    expect(asks).toEqual([
      { toolName: "bg_start", input: { command: "git commit -m x", title: "commit" }, decisionReason: "This commits on main.", suppressAlwaysAllowRule: true },
    ]);
  });

  test("a denied bg_start is blocked", async () => {
    const { handler } = setup({ decision: "deny" });
    expect(await handler({ toolName: "bg_start", input: { command: "ls", title: "ls" } })).toEqual({ block: true, reason: DENIED_REASON });
  });
});

// S1a, Verify #1 B1: a bg_start with a working_dir is judged in the directory it runs in, not the session's.
const root = mkdtempSync(join(tmpdir(), "marcsh-bg-working-dir-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let repos = 0;
function repo(branch: string): string {
  const dir = join(root, `repo-${repos++}`);
  mkdirSync(dir);
  const git = Bun.spawnSync(["git", "init", "-q", "-b", branch], { cwd: dir, stdout: "ignore", stderr: "pipe" });
  if (git.exitCode !== 0) throw new Error(git.stderr.toString());
  return dir;
}
const COMMIT = "git -c user.email=a@b -c user.name=a commit --allow-empty -m PROBE";
const ON_MAIN = "marcsh: commits on main are blocked; create a branch first (git switch -c <type>/<description>)";

function inRepo(cwd: string, { decision = "allow", guard = guardBashCommand }: { decision?: PermissionDecision; guard?: Guard } = {}) {
  const rules = openStorage(":memory:");
  const asks: PermissionAsk[] = [];
  const handler = createApprovalHandler({
    cwd,
    rules,
    signal: new AbortController().signal,
    tools: () => tools,
    host: { askPermission: async (ask) => (asks.push(ask), decision) },
    guard,
  });
  return { rules, asks, handler };
}

describe("bg_start with a working_dir (S1a, B1)", () => {
  test("the guard judges the command in working_dir: a commit there on main is denied, whatever rule the session folder has", async () => {
    const session = repo("feat/x");
    const other = repo("main");
    const { rules, asks, handler } = inRepo(session);
    rules.addPermissionRule({ cwd: session, toolName: "bash", command: COMMIT });
    expect(await handler({ toolName: "bash", input: { command: `git -C ${other} commit -m PROBE` } })).toEqual({ block: true, reason: ON_MAIN });
    expect(await handler({ toolName: "bg_start", input: { command: COMMIT, title: "c", working_dir: other } })).toEqual({ block: true, reason: ON_MAIN });
    // A relative working_dir resolves against the session folder, like bg_start runs it.
    expect(await handler({ toolName: "bg_start", input: { command: COMMIT, title: "c", working_dir: `../${other.split("/").pop()}` } })).toEqual({ block: true, reason: ON_MAIN });
    expect(asks).toEqual([]);
  });

  test("a rule saved in the session folder does not cover another folder: it asks, without an always option, and stores nothing", async () => {
    const session = repo("feat/x");
    const other = join(root, `plain-${repos++}`);
    mkdirSync(other);
    const { rules, asks, handler } = inRepo(session, { decision: "always", guard: () => null });
    rules.addPermissionRule({ cwd: session, toolName: "bash", command: "make watch" });
    rules.addPermissionRule({ cwd: session, toolName: "bg_start", command: "make watch" });
    const input = { command: "make watch", title: "w", working_dir: other };
    expect(await handler({ toolName: "bg_start", input })).toBeUndefined();
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ toolName: "bg_start", input, suppressAlwaysAllowRule: true });
    expect(asks[0]!.decisionReason).toContain(other);
    // "always" stored no rule: a new command in that folder asks again and leaves no rule for the session folder.
    await handler({ toolName: "bg_start", input: { command: "make other", title: "o", working_dir: other } });
    expect(asks).toHaveLength(2);
    expect(rules.hasPermissionRule({ cwd: session, toolName: "bash", command: "make other" })).toBe(false);
  });

  test("a working_dir that is the session folder is covered by its rule", async () => {
    const session = repo("feat/x");
    const { rules, asks, handler } = inRepo(session, { guard: () => null });
    rules.addPermissionRule({ cwd: session, toolName: "bash", command: "make watch" });
    for (const working_dir of [".", session, `${session}/`])
      expect(await handler({ toolName: "bg_start", input: { command: "make watch", title: "w", working_dir } })).toBeUndefined();
    expect(asks).toEqual([]);
  });

  test("a working_dir that does not exist or is a file is an error before anything is judged or asked", async () => {
    const session = repo("feat/x");
    const file = join(root, `file-${repos++}`);
    writeFileSync(file, "x");
    const judged: string[] = [];
    const { asks, handler } = inRepo(session, { guard: (_command, cwd) => (judged.push(cwd), null) });
    expect(await handler({ toolName: "bg_start", input: { command: "ls", title: "l", working_dir: "missing" } })).toEqual({
      block: true,
      reason: `working_dir is not a directory: ${join(session, "missing")}`,
    });
    expect(await handler({ toolName: "bg_start", input: { command: "ls", title: "l", working_dir: file } })).toEqual({ block: true, reason: `working_dir is not a directory: ${file}` });
    expect(judged).toEqual([]);
    expect(asks).toEqual([]);
  });
});

describe("bg_* in plan mode (S1a, A10)", () => {
  test("bg_start and bg_kill are blocked without asking; bg_status and bg_list run", async () => {
    const { rules, asks, handler } = setup({ planMode: true });
    rules.addPermissionRule({ cwd: "/work", toolName: "bash", command: "ls" });
    expect(await handler({ toolName: "bg_start", input: { command: "ls", title: "ls" } })).toEqual({ block: true, reason: PLAN_MODE_REASON });
    expect(await handler({ toolName: "bg_kill", input: { ids: ["bt-1"] } })).toEqual({ block: true, reason: PLAN_MODE_REASON });
    expect(await handler({ toolName: "bg_status", input: { id: "bt-1" } })).toBeUndefined();
    expect(await handler({ toolName: "bg_list", input: {} })).toBeUndefined();
    expect(asks).toEqual([]);
  });

  test("plan mode offers only the reading bg tools", () => {
    expect(tools.filter(offeredInPlan).map((tool) => tool.name)).toEqual(["read", "bg_status", "bg_list"]);
  });
});

// S4: marcsh's task_* tools only read, wait for or stop this session's background subagents: they run unasked.
const marcshTask = (name: string): ToolSource => ({ name, sourceInfo: { path: "<inline:marcsh-subagent>" } });
const TASK = ["task_wait", "task_check", "task_cancel", "task_list"];
const taskTools = [builtin("read"), marcshTask("Task"), ...TASK.map(marcshTask)];

describe("task_* approval (S4)", () => {
  test("marcsh's task tools run unasked", () => {
    for (const name of TASK) expect(needsApproval(name, taskTools), name).toBe(false);
  });

  test("a same-named tool from another source asks: a foreign task_cancel is not marcsh's", async () => {
    for (const name of TASK) expect(runsUnasked(fromExtension(name)), name).toBe(false);
    const { asks, handler } = setup({ list: [fromExtension("task_cancel")] });
    await handler({ toolName: "task_cancel", input: { ids: ["sa-1"] } });
    expect(asks).toEqual([{ toolName: "task_cancel", input: { ids: ["sa-1"] } }]);
  });

  test("plan mode offers task_wait, task_check and task_list, and blocks task_cancel without asking (A10)", async () => {
    expect(taskTools.filter(offeredInPlan).map((tool) => tool.name)).toEqual(["read", "Task", "task_wait", "task_check", "task_list"]);
    const { asks, handler } = setup({ planMode: true, list: taskTools });
    expect(await handler({ toolName: "task_cancel", input: { ids: ["sa-1"] } })).toEqual({ block: true, reason: PLAN_MODE_REASON });
    for (const name of ["task_wait", "task_check", "task_list"]) expect(await handler({ toolName: name, input: {} }), name).toBeUndefined();
    expect(asks).toEqual([]);
  });
});
