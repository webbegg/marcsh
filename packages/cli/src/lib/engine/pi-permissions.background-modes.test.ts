import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPROVAL_MODES, type ApprovalMode } from "../approval-policy";
import type { BranchState } from "../git-branch";
import { openStorage } from "../storage";
import type { Guard } from "./pi-guard";
import { createApprovalHandler, type ToolSource } from "./pi-permissions";
import type { PermissionAsk, PermissionDecision } from "./types";

// S1a: marcsh's bg_start gets exactly the approval pi's bash gets for the same command, in every approval mode, on a feature
// branch and off it. In another folder it is judged like bash's `cd <folder> && <command>` from the session folder.
const root = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-bg-modes-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cwd = join(root, "project");
const sub = join(cwd, "sub");
const other = join(root, "other");
const scratch = join(root, "scratch");
for (const dir of [cwd, sub, other, scratch]) mkdirSync(dir, { recursive: true });

const feature: BranchState = { kind: "feature", branch: "feat/x" };
const onMain: BranchState = { kind: "default", branch: "main" };

const builtin = (name: string): ToolSource => ({ name, sourceInfo: { path: `builtin:${name}` } });
const marcshBg = (name: string): ToolSource => ({ name, sourceInfo: { path: "<inline:marcsh-background>" } });
const tools = [...["read", "bash", "edit", "write"].map(builtin), ...["bg_start", "bg_status", "bg_list", "bg_kill"].map(marcshBg)];

// The branch guard's push ask, as the real guard words it.
const guardAsksPush: Guard = (command) => (/git push/.test(command) ? { decision: "ask", reason: "marcsh: git push needs your approval" } : null);

function setup(approvalMode: ApprovalMode, branch: BranchState, { decision = "allow" as PermissionDecision, pathRule = false } = {}) {
  const rules = openStorage(":memory:");
  if (pathRule) rules.addPathRule({ cwd, program: "rm", dir: scratch });
  const asks: PermissionAsk[] = [];
  const handler = createApprovalHandler({
    cwd,
    rules,
    signal: new AbortController().signal,
    tools: () => tools,
    guard: guardAsksPush,
    approvalMode,
    branchOf: () => branch,
    host: { askPermission: async (ask) => (asks.push(ask), decision) },
  });
  return { handler, asks };
}

/** What a call came to: its result and its asks, without the tool name and input (bash and bg_start differ there by design). */
async function outcome(mode: ApprovalMode, branch: BranchState, toolName: "bash" | "bg_start", input: Record<string, unknown>, options?: { pathRule?: boolean }) {
  const { handler, asks } = setup(mode, branch, options);
  const result = await handler({ toolName, input });
  return { result, asks: asks.map(({ toolName: _name, input: _input, ...rest }) => rest) };
}

const COMMANDS = [
  "npm run build",
  "echo hi > out.txt",
  "git commit -m x",
  "npm install left-pad",
  "sudo ls",
  "git push",
  "git switch main",
  "rm -rf /",
  `rm ${join(scratch, "a.txt")}`,
];

describe("bg_start in the session folder follows every approval mode exactly like bash (S1a)", () => {
  for (const mode of APPROVAL_MODES)
    for (const [where, branch] of [
      ["a feature branch", feature],
      ["the default branch", onMain],
    ] as const)
      test(`${mode} on ${where}: same result and same ask for every command`, async () => {
        for (const command of COMMANDS) {
          const bash = await outcome(mode, branch, "bash", { command });
          const bg = await outcome(mode, branch, "bg_start", { command, title: "t" });
          expect(bg, command).toEqual(bash);
        }
      });

  test("yolo on a feature branch: an ordinary command and a local commit start without asking", async () => {
    for (const command of ["npm run build", "git commit -m x"]) expect(await outcome("yolo", feature, "bg_start", { command, title: "t" }), command).toEqual({ result: undefined, asks: [] });
  });

  test("auto on a feature branch: an ordinary command starts without asking, a commit asks without always", async () => {
    expect(await outcome("auto", feature, "bg_start", { command: "npm run build", title: "t" })).toEqual({ result: undefined, asks: [] });
    const commit = await outcome("auto", feature, "bg_start", { command: "git commit -m x", title: "t" });
    expect(commit.asks).toHaveLength(1);
    expect(commit.asks[0]).toMatchObject({ suppressAlwaysAllowRule: true });
  });

  test("yolo still asks for a floor command, without always, and a denial blocks it", async () => {
    for (const command of ["npm install left-pad", "sudo ls", "git push", "git switch main"]) {
      const { handler, asks } = setup("yolo", feature, { decision: "deny" });
      expect(await handler({ toolName: "bg_start", input: { command, title: "t" } }), command).toMatchObject({ block: true });
      expect(asks, command).toHaveLength(1);
      expect(asks[0], command).toMatchObject({ toolName: "bg_start", suppressAlwaysAllowRule: true });
      expect(asks[0]!.decisionReason, command).toMatch(/^marcsh: .+ needs your approval$/);
    }
  });

  test("a catastrophic command is blocked without asking in every mode", async () => {
    for (const mode of APPROVAL_MODES) {
      const { result, asks } = await outcome(mode, feature, "bg_start", { command: "rm -rf /", title: "t" });
      expect(result, mode).toMatchObject({ block: true });
      expect(asks, mode).toEqual([]);
    }
  });

  test("auto and yolo on the default branch ask like normal", async () => {
    for (const mode of ["auto", "yolo"] as const)
      expect(await outcome(mode, onMain, "bg_start", { command: "npm run build", title: "t" }), mode).toEqual({ result: undefined, asks: [{}] });
  });

  test("a folder rule (allow rm under a folder) covers bg_start like bash, in every mode", async () => {
    const command = `rm ${join(scratch, "a.txt")}`;
    for (const mode of APPROVAL_MODES) {
      const bash = await outcome(mode, onMain, "bash", { command }, { pathRule: true });
      const bg = await outcome(mode, onMain, "bg_start", { command, title: "t" }, { pathRule: true });
      expect(bash, mode).toEqual({ result: undefined, asks: [] });
      expect(bg, mode).toEqual(bash);
    }
  });
});

describe("bg_start in another folder: judged like bash's `cd <folder> && <command>`, saved rules never cover it (S1a, T7)", () => {
  const ran = (o: Awaited<ReturnType<typeof outcome>>) => (o.result ? "blocked" : o.asks.length > 0 ? "asked" : "ran");

  test("every mode and branch: it runs, asks or is blocked exactly when that bash command would; an ask never offers always", async () => {
    for (const mode of APPROVAL_MODES)
      for (const branch of [feature, onMain])
        for (const dir of [sub, other])
          for (const command of COMMANDS.filter((command) => command !== "git push")) {
            const label = `${mode} ${branch.kind} ${dir} ${command}`;
            const bash = await outcome(mode, branch, "bash", { command: `cd '${dir}' && ${command}` });
            const bg = await outcome(mode, branch, "bg_start", { command, title: "t", working_dir: dir });
            expect(ran(bg), label).toBe(ran(bash));
            for (const ask of bg.asks) expect(ask, label).toMatchObject({ suppressAlwaysAllowRule: true });
          }
  });

  test("auto on a feature branch: an ordinary command in a folder inside the project starts without asking", async () => {
    expect(await outcome("auto", feature, "bg_start", { command: "npm run build", title: "t", working_dir: sub })).toEqual({ result: undefined, asks: [] });
  });

  test("yolo on a feature branch: a commit in a folder outside the project leaves the branch, so it asks", async () => {
    const { asks } = await outcome("yolo", feature, "bg_start", { command: "git commit -m x", title: "t", working_dir: other });
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ suppressAlwaysAllowRule: true });
  });

  test("a folder rule for the session folder does not cover a bg_start in another folder", async () => {
    const { asks } = await outcome("normal", onMain, "bg_start", { command: `rm ${join(scratch, "a.txt")}`, title: "t", working_dir: other }, { pathRule: true });
    expect(asks).toHaveLength(1);
    expect(asks[0]).not.toHaveProperty("pathRule");
  });
});
