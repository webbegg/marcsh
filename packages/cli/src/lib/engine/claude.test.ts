import { describe, expect, test } from "bun:test";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { Mode } from "../modes";
import { applyClaudeMessage, claudePrompt, claudeQueryOptions, createCanUseTool } from "./claude";
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

describe("the cost of a resumed turn", () => {
  const result = (total: number) => ({ type: "result", subtype: "success", is_error: false, result: "ok", duration_ms: 1, total_cost_usd: total }) as never;
  const empty = { id: "r", role: "assistant" as const, parts: [], metadata: { model: "sonnet" } };

  test("a first turn keeps the reported cost, and the running total is stored next to it", () => {
    const reply = applyClaudeMessage(empty, result(0.25), undefined);
    expect(reply.metadata?.costUsd).toBe(0.25);
    expect(reply.metadata?.usage).toMatchObject({ costUsd: 0.25, cumulativeCostUsd: 0.25 });
  });

  test("a resumed turn's total includes the earlier turns: the reply holds only the difference", () => {
    const reply = applyClaudeMessage(empty, result(0.75), 0.5);
    expect(reply.metadata?.costUsd).toBeCloseTo(0.25, 10);
    expect(reply.metadata?.usage?.costUsd).toBeCloseTo(0.25, 10);
    expect(reply.metadata?.usage?.cumulativeCostUsd).toBe(0.75);
  });

  test("a total below what the session had cost means the transcript carried nothing over: it is the turn's own cost", () => {
    const reply = applyClaudeMessage(empty, result(0.125), 0.5);
    expect(reply.metadata?.costUsd).toBe(0.125);
    expect(reply.metadata?.usage?.cumulativeCostUsd).toBe(0.5 + 0.125);
  });

  test("messages that are not the result pass through untouched", () => {
    const message = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] }, parent_tool_use_id: null } as never;
    expect(applyClaudeMessage(empty, message, 0.5).parts).toEqual([{ type: "text", text: "hi" }]);
  });
});

describe("the prompt of a Claude turn with attachments (S6)", () => {
  const png = { path: "/tmp/marcsh-cwd/shot.png", mime: "image/png", kind: "image" as const, bytes: new Uint8Array([1, 2, 3]) };
  const pdf = { path: "/tmp/marcsh-cwd/spec.pdf", mime: "application/pdf", kind: "pdf" as const, bytes: new Uint8Array([4, 5]) };
  const note = { path: "/tmp/marcsh-cwd/notes.txt", mime: "text/plain", kind: "file" as const };
  const collect = async (prompt: string | AsyncIterable<unknown>) => {
    if (typeof prompt === "string") return prompt;
    const messages: unknown[] = [];
    for await (const message of prompt) messages.push(message);
    return messages;
  };

  test("a turn without attachments sends the prompt as the plain string, as before", () => {
    expect(claudePrompt("hello", undefined, "/tmp/marcsh-cwd")).toBe("hello");
    expect(claudePrompt("hello", [], "/tmp/marcsh-cwd")).toBe("hello");
  });

  test("images and PDFs go as one user message: the text first, then image and document blocks in base64", async () => {
    const sent = await collect(claudePrompt("what is this?", [png, pdf], "/tmp/marcsh-cwd"));

    expect(sent).toEqual([
      {
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from([1, 2, 3]).toString("base64") } },
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from([4, 5]).toString("base64") } },
          ],
        },
      },
    ]);
  });

  test("another file is an @path mention in the text, relative to the project", async () => {
    const sent = (await collect(claudePrompt("read this", [png, note], "/tmp/marcsh-cwd"))) as any[];

    expect(sent[0].message.content[0]).toEqual({ type: "text", text: "read this\n@notes.txt" });
    expect(sent[0].message.content).toHaveLength(2);
  });

  test("only files to mention keep the prompt a plain string", () => {
    expect(claudePrompt("read this", [note], "/tmp/marcsh-cwd")).toBe("read this\n@notes.txt");
  });

  test("an image whose bytes were not read is mentioned instead of sent", () => {
    const { bytes: _bytes, ...unread } = png;
    expect(claudePrompt("look", [unread], "/tmp/marcsh-cwd")).toBe("look\n@shot.png");
  });

  test("no text means no text block (the API refuses an empty one)", async () => {
    const sent = (await collect(claudePrompt("", [png], "/tmp/marcsh-cwd"))) as any[];
    expect(sent[0].message.content.map((block: { type: string }) => block.type)).toEqual(["image"]);
  });
});
