import { afterAll, describe, expect, test } from "bun:test";
import type { CanUseTool, PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalModeLine, type ApprovalMode } from "../approval-policy";
import { Mode } from "../modes";
import { claudeQueryOptions, createCanUseTool } from "./claude";
import type { PermissionAsk, PermissionDecision, TurnHost } from "./types";

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-claude-approval-")));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

type CallOptions = Partial<Parameters<CanUseTool>[2]>;

function setup(approvalMode: ApprovalMode | undefined, answer: PermissionDecision = "allow") {
  const asked: PermissionAsk[] = [];
  const host = {
    askPermission: async (ask: PermissionAsk) => {
      asked.push(ask);
      return answer;
    },
  } as unknown as TurnHost;
  const canUseTool = createCanUseTool(host, undefined, approvalMode ? { approvalMode, cwd } : undefined);
  const call = (toolName: string, input: Record<string, unknown>, extra: CallOptions = {}) =>
    canUseTool(toolName, input, { signal: new AbortController().signal, toolUseID: "tool-1", requestId: "req-1", ...extra });
  return { asked, call };
}

const allowed = (input: Record<string, unknown>): PermissionResult => ({ behavior: "allow", updatedInput: input });

/** The "don't ask again" suggestion Claude would attach to an ask for `ruleContent`. */
const suggestionFor = (ruleContent: string): PermissionUpdate[] => [
  { type: "addRules", rules: [{ toolName: "Bash", ruleContent }], behavior: "allow", destination: "session" },
];

describe("canUseTool in normal mode (and without a mode)", () => {
  test("asks as today, and passes the SDK's own flags through", async () => {
    for (const mode of [undefined, "normal"] as const) {
      const { asked, call } = setup(mode);

      expect(await call("Bash", { command: "ls" })).toEqual(allowed({ command: "ls" }));
      expect(await call("Edit", { file_path: join(cwd, "a.ts") })).toEqual(allowed({ file_path: join(cwd, "a.ts") }));

      expect(asked.map((ask) => ask.toolName)).toEqual(["Bash", "Edit"]);
      expect(asked[0]?.decisionReason).toBeUndefined();
      expect(asked[0]?.suppressAlwaysAllowRule).toBeUndefined();
    }
  });

  test("an always answer still returns the SDK's suggestions as a permission update", async () => {
    const { call } = setup("normal", "always");
    const suggestions = suggestionFor("ls");

    expect(await call("Bash", { command: "ls" }, { suggestions })).toEqual({
      behavior: "allow",
      updatedInput: { command: "ls" },
      updatedPermissions: suggestions,
    });
  });

  test("a catastrophic command is blocked without asking", async () => {
    const { asked, call } = setup("normal");

    const result = await call("Bash", { command: "rm -rf ~" });

    expect(result).toMatchObject({ behavior: "deny", message: expect.stringContaining("never allowed") });
    expect(asked).toEqual([]);
  });
});

describe("canUseTool in auto mode", () => {
  test("an edit inside the project and an ordinary command run without asking", async () => {
    const { asked, call } = setup("auto");
    const file = join(cwd, "src", "a.ts");

    expect(await call("Edit", { file_path: file })).toEqual(allowed({ file_path: file }));
    expect(await call("Write", { file_path: file, content: "" })).toEqual(allowed({ file_path: file, content: "" }));
    expect(await call("MultiEdit", { file_path: file })).toEqual(allowed({ file_path: file }));
    expect(await call("NotebookEdit", { notebook_path: join(cwd, "n.ipynb") })).toEqual(allowed({ notebook_path: join(cwd, "n.ipynb") }));
    expect(await call("Bash", { command: "ls -la" })).toEqual(allowed({ command: "ls -la" }));
    expect(asked).toEqual([]);
  });

  test("git push asks with the policy's reason and no always-allow", async () => {
    const { asked, call } = setup("auto", "always");
    const result = await call("Bash", { command: "git push origin feat/x" }, { suggestions: suggestionFor("git push") });

    expect(result).toEqual(allowed({ command: "git push origin feat/x" }));
    expect(asked).toEqual([
      {
        toolName: "Bash",
        input: { command: "git push origin feat/x" },
        title: undefined,
        description: undefined,
        decisionReason: expect.stringContaining("git push"),
        blockedPath: undefined,
        defaultToNo: undefined,
        suppressAlwaysAllowRule: true,
      },
    ]);
  });

  test("an edit outside the project asks, with the path in the reason", async () => {
    const { asked, call } = setup("auto");

    await call("Edit", { file_path: "/etc/hosts" });

    expect(asked).toHaveLength(1);
    expect(asked[0]?.decisionReason).toContain("/etc/hosts");
    expect(asked[0]?.suppressAlwaysAllowRule).toBe(true);
  });
});

describe("canUseTool in yolo mode", () => {
  test("delivery runs without asking", async () => {
    const { asked, call } = setup("yolo");

    expect(await call("Bash", { command: "git push origin feat/x" })).toEqual(allowed({ command: "git push origin feat/x" }));
    expect(asked).toEqual([]);
  });

  test("a dependency install asks, and an always answer stores no rule", async () => {
    const { asked, call } = setup("yolo", "always");
    const result = await call("Bash", { command: "npm install left-pad" }, { suggestions: suggestionFor("npm install") });

    expect(result).toEqual(allowed({ command: "npm install left-pad" }));
    expect(asked).toHaveLength(1);
    expect(asked[0]?.suppressAlwaysAllowRule).toBe(true);
    expect(asked[0]?.decisionReason).toContain("npm install");
  });

  test("a denied floor ask is refused", async () => {
    const { call } = setup("yolo", "deny");

    expect(await call("Bash", { command: "npm install left-pad" })).toEqual({ behavior: "deny", message: "The user denied this tool call." });
  });

  test("the user's ask rules and Claude's own safety prompts keep asking, as today", async () => {
    const { asked, call } = setup("yolo");
    const matchedAskRule = { source: "userSettings", toolName: "Bash", ruleContent: "ls" };

    await call("Bash", { command: "ls" }, { matchedAskRule });
    await call("Bash", { command: "ls" }, { defaultToNo: true });
    await call("Edit", { file_path: join(cwd, "a.ts") }, { blockedPath: "/etc/passwd", decisionReason: "outside" });

    expect(asked.map((ask) => ask.toolName)).toEqual(["Bash", "Bash", "Edit"]);
    expect(asked[0]?.decisionReason).toBeUndefined();
    expect(asked[1]?.defaultToNo).toBe(true);
    expect(asked[2]).toMatchObject({ blockedPath: "/etc/passwd", decisionReason: "outside" });
  });

  test("a catastrophic command is blocked even when Claude flagged the ask", async () => {
    const { asked, call } = setup("yolo");

    const result = await call("Bash", { command: "rm -rf /" });

    expect(result).toMatchObject({ behavior: "deny" });
    expect(asked).toEqual([]);
  });

  test("MCP, web and unknown tools keep asking, with no policy reason", async () => {
    const { asked, call } = setup("yolo");

    await call("mcp__server__tool", { a: 1 });
    await call("WebFetch", { url: "https://example.com" });
    await call("SomethingNew", {});
    await call("Bash", { command: 42 });
    await call("Edit", {});

    expect(asked.map((ask) => ask.toolName)).toEqual(["mcp__server__tool", "WebFetch", "SomethingNew", "Bash", "Edit"]);
    for (const ask of asked) {
      expect(ask.decisionReason).toBeUndefined();
      expect(ask.suppressAlwaysAllowRule).toBeUndefined();
    }
  });

  test("a denied tool is still refused first", async () => {
    const asked: PermissionAsk[] = [];
    const host = { askPermission: async (ask: PermissionAsk) => (asked.push(ask), "allow" as const) } as unknown as TurnHost;
    const canUseTool = createCanUseTool(host, ["bash"], { approvalMode: "yolo", cwd });

    const result = await canUseTool("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "t", requestId: "r" });

    expect(result).toEqual({ behavior: "deny", message: "Bash is not available to this agent" });
    expect(asked).toEqual([]);
  });
});

describe("the mode line in the options of a Claude turn", () => {
  const base = { cwd, mode: Mode.BUILD, model: "sonnet", abortController: new AbortController(), plugins: [] as string[], canUseTool: (async () => ({ behavior: "deny", message: "" })) as CanUseTool };

  test("auto and yolo append their line after the agent prompt", () => {
    for (const approvalMode of ["auto", "yolo"] as const) {
      const line = approvalModeLine(approvalMode)!;

      expect(claudeQueryOptions({ ...base, approvalMode }).systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: line });
      expect(claudeQueryOptions({ ...base, approvalMode, systemPromptAppend: "You are FTD." }).systemPrompt).toEqual({
        type: "preset",
        preset: "claude_code",
        append: `You are FTD.\n\n${line}`,
      });
    }
  });

  test("normal mode leaves the options as they were", () => {
    for (const approvalMode of [undefined, "normal"] as const) {
      expect(claudeQueryOptions({ ...base, approvalMode }).systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
      expect(claudeQueryOptions({ ...base, approvalMode, systemPromptAppend: "You are FTD." }).systemPrompt).toEqual({
        type: "preset",
        preset: "claude_code",
        append: "You are FTD.",
      });
    }
  });

  test("the permission mode stays default or plan, never bypassPermissions", () => {
    for (const approvalMode of ["normal", "auto", "yolo"] as const) {
      const sent = claudeQueryOptions({ ...base, approvalMode });
      expect(sent.permissionMode).toBe("default");
      expect("allowedTools" in sent).toBe(false);
      expect(claudeQueryOptions({ ...base, approvalMode, mode: Mode.PLAN }).permissionMode).toBe("plan");
    }
  });
});

describe("a catastrophic command Claude forces to ask is still blocked", () => {
  test("matchedAskRule, defaultToNo or blockedPath: denied and never asked, in every mode", async () => {
    for (const mode of ["normal", "auto", "yolo"] as const) {
      for (const extra of [{ matchedAskRule: { source: "userSettings", toolName: "Bash", ruleContent: "rm:*" } }, { defaultToNo: true }, { blockedPath: "/Users" }]) {
        const { asked, call } = setup(mode);
        expect(await call("Bash", { command: "rm -rf ~" }, extra)).toEqual({ behavior: "deny", message: "marcsh: rm on a root, home or wildcard target (~) is never allowed" });
        expect(asked).toEqual([]);
      }
    }
  });

  test("a forced ask that is not catastrophic keeps asking, with Claude's own flags", async () => {
    const { asked, call } = setup("yolo");
    await call("Bash", { command: "ls" }, { defaultToNo: true });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.defaultToNo).toBe(true);
    expect(asked[0]?.decisionReason).toBeUndefined();
  });
});

describe("the branch guard's ask is only skipped for delivery", () => {
  const guardReason = (name: string) => ({ decisionReason: `marcsh: ${name} needs your approval` });

  test("a merge or publish the guard asked about still asks in yolo and auto, without always-allow", async () => {
    for (const mode of ["auto", "yolo"] as const) {
      for (const [command, name] of [["make release", "gh pr merge"], ["make ship", "npm publish"], ["./publish.sh", "pnpm publish"]] as const) {
        const { asked, call } = setup(mode, "always");
        const result = await call("Bash", { command }, { ...guardReason(name), suggestions: suggestionFor(command) });
        expect(result).toEqual(allowed({ command }));
        expect(asked).toHaveLength(1);
        expect(asked[0]?.suppressAlwaysAllowRule).toBe(true);
        expect(asked[0]?.decisionReason).toContain(name);
      }
    }
  });

  test("a push or PR creation the guard asked about runs in yolo, and asks in auto", async () => {
    for (const [command, name] of [["git push origin feat", "git push"], ["gh pr create --fill", "gh pr create"]] as const) {
      const yolo = setup("yolo");
      expect(await yolo.call("Bash", { command }, guardReason(name))).toEqual(allowed({ command }));
      expect(yolo.asked).toEqual([]);

      const auto = setup("auto");
      await auto.call("Bash", { command }, guardReason(name));
      expect(auto.asked).toHaveLength(1);
    }
  });

  test("normal mode keeps today's prompt for a guard ask", async () => {
    const { asked, call } = setup("normal");
    await call("Bash", { command: "npm publish" }, guardReason("npm publish"));
    expect(asked).toHaveLength(1);
    expect(asked[0]?.decisionReason).toBe("marcsh: npm publish needs your approval");
    expect(asked[0]?.suppressAlwaysAllowRule).toBeUndefined();
  });
});

describe("plan mode gets no approval mode line", () => {
  const base = { cwd, model: "sonnet", abortController: new AbortController(), plugins: [] as string[], canUseTool: (async () => ({ behavior: "deny", message: "" })) as CanUseTool };

  test("the options of a plan turn leave the prompt as it was, even in yolo", () => {
    for (const approvalMode of ["auto", "yolo"] as const) {
      expect(claudeQueryOptions({ ...base, mode: Mode.PLAN, approvalMode }).systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
      expect(claudeQueryOptions({ ...base, mode: Mode.PLAN, approvalMode, systemPromptAppend: "You are FTD." }).systemPrompt).toEqual({
        type: "preset",
        preset: "claude_code",
        append: "You are FTD.",
      });
    }
  });
});
