import { describe, expect, test } from "bun:test";
import type { ApprovalMode } from "../approval-policy";
import type { BranchState } from "../git-branch";
import { openStorage } from "../storage";
import { createCanUseTool } from "./claude";
import { createApprovalHandler, PLAN_MODE_REASON, type ToolSource } from "./pi-permissions";
import type { PermissionAsk, TurnHost } from "./types";

// The mode a user switches to with /permissions applies to every call decided after the switch, in the same turn.
const feature: BranchState = { kind: "feature", branch: "feat/x" };
const branchOf = (): BranchState => feature;
const commit = { command: "git commit -m x" };

const piTools: ToolSource[] = ["read", "bash", "edit", "write"].map((name) => ({ name, sourceInfo: { path: `builtin:${name}` } }));

function piSetup(start: ApprovalMode, planMode = false) {
  const live = { mode: start };
  const asks: PermissionAsk[] = [];
  const handler = createApprovalHandler({
    cwd: "/tmp/marcsh-live-pi",
    rules: openStorage(":memory:"),
    signal: new AbortController().signal,
    tools: () => piTools,
    guard: () => null,
    planMode,
    approvalMode: start,
    currentApprovalMode: () => live.mode,
    branchOf,
    host: {
      askPermission: async (ask) => {
        asks.push(ask);
        return "allow";
      },
    },
  });
  return { live, asks, call: () => handler({ toolName: "bash", input: commit }) };
}

function claudeSetup(start: ApprovalMode) {
  const live = { mode: start };
  const asks: PermissionAsk[] = [];
  const host = {
    askPermission: async (ask: PermissionAsk) => {
      asks.push(ask);
      return "allow";
    },
  } as unknown as TurnHost;
  const canUseTool = createCanUseTool(host, undefined, { approvalMode: start, currentApprovalMode: () => live.mode, cwd: "/tmp/marcsh-live-claude", branchOf });
  const call = (extra: Partial<Parameters<typeof canUseTool>[2]> = {}) =>
    canUseTool("Bash", commit, { signal: new AbortController().signal, toolUseID: "t", requestId: "r", ...extra });
  return { live, asks, call };
}

describe("pi: a mode switched mid-turn applies to the next call", () => {
  test("yolo -> normal asks", async () => {
    const { live, asks, call } = piSetup("yolo");
    expect(await call()).toBeUndefined();
    expect(asks).toHaveLength(0);
    live.mode = "normal";
    expect(await call()).toBeUndefined();
    expect(asks).toHaveLength(1);
  });

  test("normal -> yolo allows without asking", async () => {
    const { live, asks, call } = piSetup("normal");
    await call();
    expect(asks).toHaveLength(1);
    live.mode = "yolo";
    expect(await call()).toBeUndefined();
    expect(asks).toHaveLength(1);
  });

  test("plan mode stays blocked with a live yolo", async () => {
    const { asks, call } = piSetup("yolo", true);
    expect(await call()).toEqual({ block: true, reason: PLAN_MODE_REASON });
    expect(asks).toHaveLength(0);
  });
});

describe("claude: a mode switched mid-turn applies to the next call", () => {
  test("yolo -> normal asks", async () => {
    const { live, asks, call } = claudeSetup("yolo");
    expect(await call()).toMatchObject({ behavior: "allow" });
    expect(asks).toHaveLength(0);
    live.mode = "normal";
    await call();
    expect(asks).toHaveLength(1);
  });

  test("normal -> yolo allows without asking", async () => {
    const { live, asks, call } = claudeSetup("normal");
    await call();
    expect(asks).toHaveLength(1);
    live.mode = "yolo";
    expect(await call()).toMatchObject({ behavior: "allow" });
    expect(asks).toHaveLength(1);
  });

  test("a forced ask (matched ask rule) stays normal with a live yolo", async () => {
    const { live, asks, call } = claudeSetup("normal");
    live.mode = "yolo";
    await call({ matchedAskRule: true } as never);
    expect(asks).toHaveLength(1);
  });
});
