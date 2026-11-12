import { describe, expect, test } from "bun:test";
import { claudeDeniedTools, groupOf, isClaudeToolDenied, isPiToolDenied } from "./agent-tools";
import { TOOL_GROUPS, claudeToolName, claudeToolNames, type Group } from "./tool-names";

// The tool-name knowledge lives in one table; these are the answers it must keep giving, spelled out so a table edit cannot change them unseen.

const FIELD_NAMES: Record<Exclude<Group, "mcp">, string[]> = {
  read: ["read", "grep", "glob", "find", "ls", "list", "notebookread"],
  edit: ["edit", "write", "patch", "multiedit", "notebookedit"],
  bash: ["bash", "shell", "powershell"],
  web: ["web", "webfetch", "websearch", "fetch"],
  task: ["task", "agent", "subagent"],
  ask: ["ask", "askuserquestion", "question", "ask_user"],
};

const CLAUDE_DENIED: Record<Group, string[]> = {
  read: ["Read", "Grep", "Glob", "NotebookRead", "LS"],
  edit: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
  bash: ["Bash", "BashOutput", "KillShell", "KillBash", "PowerShell", "TaskOutput", "TaskStop"],
  web: ["WebFetch", "WebSearch"],
  task: ["Task", "Agent", "Workflow", "TaskOutput", "TaskStop"],
  ask: [],
  mcp: ["mcp__*", "ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool"],
};

describe("the group of a tool name", () => {
  test("every accepted spelling lands in its group, in any case and with a permission scope", () => {
    for (const [group, names] of Object.entries(FIELD_NAMES)) {
      for (const name of names) {
        const label = `${name} -> ${group}`;
        expect([label, groupOf(name)]).toEqual([label, group]);
        expect([label, groupOf(name.toUpperCase())]).toEqual([label, group]);
        expect([label, groupOf(`${name}(x:*)`)]).toEqual([label, group]);
      }
    }
  });

  test("Claude tools the field never named stay in no group", () => {
    for (const name of ["BashOutput", "KillShell", "KillBash", "TaskOutput", "TaskStop", "Workflow", "Skill", "LSP", "TodoWrite", "", "  "]) {
      expect([name, groupOf(name)]).toEqual([name, undefined]);
    }
  });

  test("mcp names", () => {
    for (const name of ["mcp", "MCP", "mcp__fs__read", "mcp_fs_read", "fs_*"]) expect([name, groupOf(name)]).toEqual([name, "mcp"]);
  });
});

describe("what Claude is told to disallow", () => {
  test("each group", () => {
    for (const group of TOOL_GROUPS) expect([group, claudeDeniedTools([group])]).toEqual([group, CLAUDE_DENIED[group]]);
  });

  test("groups together keep the order given, without repeats", () => {
    expect(claudeDeniedTools([])).toEqual([]);
    expect(claudeDeniedTools(["bash", "task"])).toEqual([...CLAUDE_DENIED.bash, "Task", "Agent", "Workflow"]);
    expect(claudeDeniedTools(["task", "bash"])).toEqual([...CLAUDE_DENIED.task, "Bash", "BashOutput", "KillShell", "KillBash", "PowerShell"]);
    expect(claudeDeniedTools([...TOOL_GROUPS])).toEqual([
      ...CLAUDE_DENIED.read,
      ...CLAUDE_DENIED.edit,
      ...CLAUDE_DENIED.bash,
      ...CLAUDE_DENIED.web,
      "Task",
      "Agent",
      "Workflow",
      ...CLAUDE_DENIED.mcp,
    ]);
  });

  test("a call is denied exactly when its name is in a denied group's list", () => {
    const known = [...new Set(Object.values(CLAUDE_DENIED).flat())];
    for (const name of [...known, "AskUserQuestion", "Skill", "read", "bash", "Agent2"]) {
      for (const group of TOOL_GROUPS) {
        const expected = CLAUDE_DENIED[group].includes(name);
        expect([name, group, isClaudeToolDenied(name, [group])]).toEqual([name, group, expected]);
      }
      expect([name, isClaudeToolDenied(name, [])]).toEqual([name, false]);
    }
  });

  test("mcp tools follow the mcp group only", () => {
    expect(isClaudeToolDenied("mcp__fs__delete", ["mcp"])).toBe(true);
    expect(isClaudeToolDenied("mcp__fs__delete", ["bash", "edit", "task", "web", "read", "ask"])).toBe(false);
    expect(isClaudeToolDenied("ReadMcpResourceTool", ["mcp"])).toBe(true);
    expect(isClaudeToolDenied("AskUserQuestion", [...TOOL_GROUPS])).toBe(false);
    expect(isClaudeToolDenied("Skill", [...TOOL_GROUPS])).toBe(false);
  });
});

describe("pi tools by group", () => {
  test("names group like the field's, and the question tool is never denied", () => {
    expect(isPiToolDenied("bash", ["bash"])).toBe(true);
    expect(isPiToolDenied("Bash", ["bash"])).toBe(true);
    expect(isPiToolDenied("find", ["read"])).toBe(true);
    expect(isPiToolDenied("write", ["edit"])).toBe(true);
    expect(isPiToolDenied("write", ["read"])).toBe(false);
    expect(isPiToolDenied("ask", [...TOOL_GROUPS])).toBe(false);
    expect(isPiToolDenied("read_mcp_resource", ["mcp"])).toBe(true);
    expect(isPiToolDenied("my_extension_tool", [...TOOL_GROUPS])).toBe(false);
  });
});

describe("the name Claude's hooks use for a pi tool", () => {
  test("every pi tool", () => {
    const pairs: [string, string][] = [
      ["bash", "Bash"],
      ["edit", "Edit"],
      ["write", "Write"],
      ["read", "Read"],
      ["grep", "Grep"],
      ["find", "Glob"],
      ["ls", "LS"],
      ["Task", "Agent"],
    ];
    for (const [pi, claude] of pairs) {
      expect([pi, claudeToolName(pi)]).toEqual([pi, claude]);
      expect([pi, claudeToolNames(pi)[0]]).toEqual([pi, claude]);
    }
  });

  test("a matcher may also use the names Claude used before", () => {
    expect(claudeToolNames("Task")).toEqual(["Agent", "Task"]);
    expect(claudeToolNames("Agent")).toEqual(["Agent", "Task"]);
    expect(claudeToolNames("bash")).toEqual(["Bash"]);
    expect(claudeToolNames("find")).toEqual(["Glob"]);
  });

  test("anything else keeps its name", () => {
    for (const name of ["AskUserQuestion", "mcp__fs__delete", "my_extension_tool", "Bash", "task", "Read"]) {
      expect([name, claudeToolName(name)]).toEqual([name, name]);
      expect([name, claudeToolNames(name)]).toEqual([name, [name]]);
    }
  });

  test("a pi tool named like an Object.prototype member keeps its name", () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect([name, claudeToolName(name)]).toEqual([name, name]);
      expect([name, claudeToolNames(name)]).toEqual([name, [name]]);
    }
  });
});
