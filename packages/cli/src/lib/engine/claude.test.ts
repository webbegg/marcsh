import { describe, expect, test } from "bun:test";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { Mode } from "../modes";
import { claudeQueryOptions, createCanUseTool } from "./claude";
import type { PermissionAsk, TurnHost, TurnRequest } from "./types";

// The names are spelled out on purpose: this pins what the SDK is sent, so a renamed or dropped entry in the tool table fails here.
const DENIED_BY_GROUP = {
  edit: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
  bash: ["Bash", "BashOutput", "KillShell", "KillBash", "PowerShell", "TaskOutput", "TaskStop"],
  web: ["WebFetch", "WebSearch"],
  task: ["Task", "Agent", "Workflow", "TaskOutput", "TaskStop"],
  mcp: ["mcp__*", "ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool"],
};

const base = { cwd: "/tmp/marcsh-cwd", mode: Mode.BUILD, model: "sonnet", abortController: new AbortController(), plugins: [] as string[] };
const noAsk: CanUseTool = async () => ({ behavior: "deny", message: "unused" });

function options(deniedTools: TurnRequest["deniedTools"]) {
  return claudeQueryOptions({ ...base, deniedTools, canUseTool: noAsk });
}

describe("the options of a Claude turn for an agent's tools", () => {
  test("a tools list sends the denied groups' names in disallowedTools, the Task/Agent and MCP-resource ones included", () => {
    const sent = options(["edit", "bash", "web", "task", "mcp"]);

    expect(sent.disallowedTools).toEqual(expect.arrayContaining(Object.values(DENIED_BY_GROUP).flat()));
    expect(sent.disallowedTools).toHaveLength(new Set(Object.values(DENIED_BY_GROUP).flat()).size);
    for (const kept of ["Read", "Grep", "Glob", "AskUserQuestion"]) expect(sent.disallowedTools).not.toContain(kept);
  });

  test("a group alone sends only its names", () => {
    expect(options(["task"]).disallowedTools).toEqual(DENIED_BY_GROUP.task);
    expect(options(["mcp"]).disallowedTools).toEqual(DENIED_BY_GROUP.mcp);
  });

  test("allowedTools is never sent: it would approve tools without asking", () => {
    for (const denied of [undefined, [], ["bash"], ["edit", "bash", "web", "task", "mcp"]] as TurnRequest["deniedTools"][]) {
      const sent = options(denied);
      expect("allowedTools" in sent).toBe(false);
      expect("tools" in sent).toBe(false);
    }
  });

  test("an agent without a tools list sends no disallowedTools key, and the callback is the one given", () => {
    for (const denied of [undefined, []] as TurnRequest["deniedTools"][]) {
      const sent = options(denied);
      expect("disallowedTools" in sent).toBe(false);
      expect(sent.canUseTool).toBe(noAsk);
    }
  });
});

describe("the canUseTool backstop for an agent's tools", () => {
  function setup(denied: TurnRequest["deniedTools"]) {
    const asked: PermissionAsk[] = [];
    const host = {
      askPermission: async (ask: PermissionAsk) => {
        asked.push(ask);
        return "allow" as const;
      },
    } as unknown as TurnHost;
    const call = (toolName: string, input: Record<string, unknown>, agentID?: string) =>
      createCanUseTool(host, denied)(toolName, input, { signal: new AbortController().signal, toolUseID: "tool-1", requestId: "req-1", ...(agentID ? { agentID } : {}) });
    return { asked, call };
  }

  test("a denied tool is refused without asking, from the turn and from a Task child alike", async () => {
    const { asked, call } = setup(["edit", "bash", "web", "task", "mcp"]);

    for (const agentID of [undefined, "task-child-1"]) {
      for (const [tool, input] of [
        ["Bash", { command: "ls" }],
        ["Write", { file_path: "/tmp/x", content: "" }],
        ["WebFetch", { url: "https://example.com" }],
        ["Task", { description: "d", prompt: "p", subagent_type: "general-purpose" }],
        ["Agent", { description: "d", prompt: "p" }],
        ["mcp__server__tool", {}],
        ["ReadMcpResourceTool", { server: "s", uri: "u" }],
      ] as const) {
        expect(await call(tool, { ...input }, agentID)).toEqual({ behavior: "deny", message: `${tool} is not available to this agent` });
      }
    }
    expect(asked).toEqual([]);
  });

  test("a tool the agent keeps still goes through the approval, also from a Task child", async () => {
    const { asked, call } = setup(["bash", "task", "mcp"]);

    expect(await call("Read", { file_path: "/tmp/x" }, "task-child-1")).toEqual({ behavior: "allow", updatedInput: { file_path: "/tmp/x" } });
    expect(await call("Edit", { file_path: "/tmp/x" })).toEqual({ behavior: "allow", updatedInput: { file_path: "/tmp/x" } });
    expect(asked.map((ask) => ask.toolName)).toEqual(["Read", "Edit"]);
  });

  test("an agent without a tools list asks for every tool", async () => {
    const { asked, call } = setup(undefined);

    await call("Bash", { command: "ls" }, "task-child-1");
    expect(asked.map((ask) => ask.toolName)).toEqual(["Bash"]);
  });
});
