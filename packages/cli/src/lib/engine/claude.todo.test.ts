import { describe, expect, test } from "bun:test";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { Mode } from "../modes";
import { CLAUDE_TOOLS, TOOL_GROUPS } from "../tool-names";
import { claudeQueryOptions } from "./claude";

// S2/T7: on Claude the todo list is the SDK's own TodoWrite. marcsh adds nothing; it only must never take it away.
const base = {
  cwd: process.cwd(),
  mode: Mode.BUILD,
  model: "sonnet",
  abortController: new AbortController(),
  plugins: [] as string[],
  canUseTool: (async () => ({ behavior: "deny", message: "" })) as CanUseTool,
};

describe("TodoWrite on the Claude engine", () => {
  test("no tool group takes it away", () => {
    expect(CLAUDE_TOOLS.some((tool) => tool.name === "TodoWrite")).toBe(false);
    for (const group of TOOL_GROUPS) {
      const options = claudeQueryOptions({ ...base, deniedTools: [group] });
      expect(options.disallowedTools ?? []).not.toContain("TodoWrite");
    }
  });

  test("not when every group is denied, in a plan turn, or for a subagent", () => {
    const options = claudeQueryOptions({ ...base, deniedTools: [...TOOL_GROUPS] });
    expect(options.disallowedTools ?? []).not.toContain("TodoWrite");
    expect(claudeQueryOptions({ ...base, mode: Mode.PLAN, deniedTools: ["bash", "edit"] }).disallowedTools ?? []).not.toContain("TodoWrite");

    const withAgent = claudeQueryOptions({
      ...base,
      deniedTools: ["bash"],
      subagents: [{ name: "developer", description: "Builds", prompt: "You build.", readOnly: false, deniedTools: [...TOOL_GROUPS] }],
    });
    for (const agent of Object.values(withAgent.agents ?? {})) expect(agent.disallowedTools ?? []).not.toContain("TodoWrite");
  });
});
