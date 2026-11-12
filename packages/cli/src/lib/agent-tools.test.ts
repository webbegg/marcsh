import { describe, expect, test } from "bun:test";
import {
  claudeDeniedTools,
  describeTools,
  groupOf,
  isClaudeToolDenied,
  isPiToolDenied,
  notAvailableReason,
  parseTools,
  TOOL_GROUPS,
  unsupportedGroups,
} from "./agent-tools";

describe("groupOf", () => {
  test("names map case-insensitively onto the groups", () => {
    expect(groupOf("Read")).toBe("read");
    expect(groupOf("GREP")).toBe("read");
    expect(groupOf("glob")).toBe("read");
    expect(groupOf("NotebookRead")).toBe("read");
    expect(groupOf("Edit")).toBe("edit");
    expect(groupOf("MultiEdit")).toBe("edit");
    expect(groupOf("patch")).toBe("edit");
    expect(groupOf("Bash")).toBe("bash");
    expect(groupOf("shell")).toBe("bash");
    expect(groupOf("WebFetch")).toBe("web");
    expect(groupOf("websearch")).toBe("web");
    expect(groupOf("Task")).toBe("task");
    expect(groupOf("agent")).toBe("task");
    expect(groupOf("AskUserQuestion")).toBe("ask");
    expect(groupOf("question")).toBe("ask");
    expect(groupOf("mcp")).toBe("mcp");
  });

  test("MCP tools and OpenCode wildcards map to mcp", () => {
    expect(groupOf("mcp__github__create_issue")).toBe("mcp");
    expect(groupOf("MCP__github")).toBe("mcp");
    expect(groupOf("mcp_github_search")).toBe("mcp");
    expect(groupOf("mymcp_*")).toBe("mcp");
  });

  test("a permission scope after the name is dropped: Bash(git:*) is bash", () => {
    expect(groupOf("Bash(git diff:*)")).toBe("bash");
  });

  test("unknown names have no group", () => {
    expect(groupOf("frobnicate")).toBeUndefined();
    expect(groupOf("*")).toBeUndefined();
    expect(groupOf("")).toBeUndefined();
  });
});

describe("parseTools, OpenCode map form", () => {
  test("false denies the group, true keeps it", () => {
    const parsed = parseTools("", ["bash: false", "edit: true", "write: false"]);
    expect(parsed.tools?.deny).toEqual(["edit", "bash"]);
    expect(parsed.unknown).toEqual([]);
  });

  test("a group is denied when any of its names is false", () => {
    expect(parseTools("", ["edit: true", "write: false"]).tools?.deny).toEqual(["edit"]);
  });

  test("keys and values are case-insensitive and may be quoted", () => {
    expect(parseTools("", ['"Bash": FALSE', "WebFetch: False  # no network"]).tools?.deny).toEqual(["bash", "web"]);
  });

  test("a wildcard key denies mcp", () => {
    expect(parseTools("", ["mymcp_*: false"]).tools?.deny).toEqual(["mcp"]);
  });

  test("all true is no restriction", () => {
    expect(parseTools("", ["bash: true", "edit: true"]).tools).toBeUndefined();
  });

  test("a flow map on the key line works too", () => {
    expect(parseTools("{ bash: false, edit: true }").tools?.deny).toEqual(["bash"]);
  });

  test("unknown names and values that are not booleans are returned, not applied", () => {
    const parsed = parseTools("", ["bash: false", "frobnicate: false", "edit: maybe"]);
    expect(parsed.tools?.deny).toEqual(["bash"]);
    expect(parsed.unknown).toEqual(["frobnicate", "edit"]);
  });
});

describe("parseTools, the `*` key", () => {
  test("`*: false` denies every group, and a group set to true is allowed again", () => {
    expect(parseTools("", ['"*": false', "read: true"]).tools?.deny).toEqual(["edit", "bash", "web", "task", "mcp"]);
    expect(parseTools("", ["read: true", '"*": false']).tools?.deny).toEqual(["edit", "bash", "web", "task", "mcp"]);
    expect(parseTools('{ "*": false, read: true, bash: true }').tools?.deny).toEqual(["edit", "web", "task", "mcp"]);
  });

  test("`*: false` alone keeps read (an agent needs something to read with) and says so", () => {
    const parsed = parseTools("", ['"*": false']);
    expect(parsed.tools?.deny).toEqual(["edit", "bash", "web", "task", "mcp"]);
    expect(parsed.notes).toEqual(["*: read tools are kept so the agent can work"]);
    expect(parsed.unknown).toEqual([]);
  });

  test("`*: true` with some false entries denies just those", () => {
    const parsed = parseTools("", ['"*": true', "bash: false", "edit: false"]);
    expect(parsed.tools?.deny).toEqual(["edit", "bash"]);
    expect(parsed.unknown).toEqual([]);
  });

  test("`*: true` alone restricts nothing, and an explicit false beats a true of the same group", () => {
    expect(parseTools("", ['"*": true']).tools).toBeUndefined();
    expect(parseTools("", ['"*": false', "edit: true", "write: false"]).tools?.deny).toContain("edit");
  });

  test("the question tool is not denied by `*: false` and no note is made of it", () => {
    const parsed = parseTools("", ['"*": false', "read: true"]);
    expect(parsed.tools?.deny).not.toContain("ask");
    expect(parsed.notes).toEqual([]);
  });
});

describe("parseTools, Claude Code list form", () => {
  test("a comma list allows only the named groups", () => {
    const parsed = parseTools("Read, Grep, Glob");
    expect(parsed.tools?.deny).toEqual(["edit", "bash", "web", "task", "mcp"]);
    expect(parsed.unknown).toEqual([]);
  });

  test("a space separated list and a YAML flow list work", () => {
    expect(parseTools("Read Grep").tools).toEqual(parseTools("Read, Grep").tools);
    expect(parseTools("[Read, Grep]").tools).toEqual(parseTools("Read, Grep").tools);
    expect(parseTools('["Read", "Bash"]').tools?.deny).toEqual(["edit", "web", "task", "mcp"]);
  });

  test("a YAML block list works", () => {
    expect(parseTools("", ["- Read", "- Bash"]).tools?.deny).toEqual(["edit", "web", "task", "mcp"]);
  });

  test("a scoped name keeps its parentheses together", () => {
    expect(parseTools("Read, Bash(git add:*, git commit:*)").tools?.deny).toEqual(["edit", "web", "task", "mcp"]);
  });

  test("everything not named is denied, mcp included, ask never", () => {
    const deny = parseTools("Read").tools!.deny;
    expect(deny).not.toContain("ask");
    expect(deny).not.toContain("read");
    expect([...deny, "read", "ask"].sort()).toEqual([...TOOL_GROUPS].sort());
  });

  test("a mcp name keeps the mcp group", () => {
    expect(parseTools("Read, mcp__github__search").tools!.deny).not.toContain("mcp");
  });

  test("unknown names are returned; a list with no known name restricts nothing", () => {
    const parsed = parseTools("Read, Frob, Zap");
    expect(parsed.unknown).toEqual(["Frob", "Zap"]);
    expect(parsed.tools?.deny).toEqual(["edit", "bash", "web", "task", "mcp"]);

    const none = parseTools("Frob");
    expect(none.tools).toBeUndefined();
    expect(none.unknown).toEqual(["Frob"]);
  });
});

describe("parseTools, limits", () => {
  test("ask is never denied, even when it is set to false", () => {
    expect(parseTools("", ["ask: false", "bash: false"]).tools?.deny).toEqual(["bash"]);
    expect(parseTools("", ["askuserquestion: false"]).tools).toBeUndefined();
  });

  test("an agent that would be left with nothing but ask keeps read", () => {
    const list = parseTools("AskUserQuestion").tools!;
    expect(list.deny).toEqual(["edit", "bash", "web", "task", "mcp"]);

    const map = parseTools("", ["read: false", "edit: false", "bash: false", "web: false", "task: false", "mcp: false"]).tools!;
    expect(map.deny).toEqual(["edit", "bash", "web", "task", "mcp"]);
  });

  test("an empty field is reported as empty", () => {
    expect(parseTools("").empty).toBe(true);
    expect(parseTools(null).empty).toBe(true);
    expect(parseTools(undefined).empty).toBe(true);
    expect(parseTools("", ["bash: false"]).empty).toBe(false);
  });

  test("unknown names are capped and shortened", () => {
    const names = Array.from({ length: 20 }, (_, i) => `x${i}${"y".repeat(100)}`);
    const parsed = parseTools(names.join(", "));
    expect(parsed.unknown.length).toBeLessThanOrEqual(8);
    expect(parsed.unknown.every((name) => name.length <= 40)).toBe(true);
  });
});

describe("engine mappings", () => {
  test("Claude: the tool names of each denied group", () => {
    expect(claudeDeniedTools(["bash"])).toEqual(expect.arrayContaining(["Bash", "BashOutput", "KillShell"]));
    expect(claudeDeniedTools(["edit"])).toEqual(expect.arrayContaining(["Edit", "Write", "MultiEdit", "NotebookEdit"]));
    expect(claudeDeniedTools(["read"])).toEqual(expect.arrayContaining(["Read", "Grep", "Glob"]));
    expect(claudeDeniedTools(["web"])).toEqual(["WebFetch", "WebSearch"]);
    expect(claudeDeniedTools(["task"])).toEqual(["Task", "Agent", "Workflow", "TaskOutput", "TaskStop"]);
    expect(claudeDeniedTools(["mcp"])).toEqual(["mcp__*", "ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool"]);
    // A name in two groups is sent once.
    expect(claudeDeniedTools(["bash", "task"]).filter((name) => name === "TaskStop")).toHaveLength(1);
    expect(claudeDeniedTools([])).toEqual([]);
  });

  test("Claude: a call to a denied tool is recognised, MCP by prefix", () => {
    expect(isClaudeToolDenied("Bash", ["bash"])).toBe(true);
    expect(isClaudeToolDenied("Read", ["bash"])).toBe(false);
    expect(isClaudeToolDenied("mcp__github__search", ["mcp"])).toBe(true);
    expect(isClaudeToolDenied("mcp__github__search", ["bash"])).toBe(false);
    expect(isClaudeToolDenied("AskUserQuestion", ["bash", "mcp"])).toBe(false);
  });

  test("pi: its own tools, Task, and MCP tools by prefix", () => {
    expect(isPiToolDenied("bash", ["bash"])).toBe(true);
    expect(isPiToolDenied("powershell", ["bash"])).toBe(true);
    expect(isPiToolDenied("write", ["edit"])).toBe(true);
    expect(isPiToolDenied("edit", ["edit"])).toBe(true);
    expect(isPiToolDenied("grep", ["read"])).toBe(true);
    expect(isPiToolDenied("ls", ["read"])).toBe(true);
    expect(isPiToolDenied("Task", ["task"])).toBe(true);
    expect(isPiToolDenied("mcp__github__search", ["mcp"])).toBe(true);
    expect(isPiToolDenied("read", ["bash"])).toBe(false);
    expect(isPiToolDenied("AskUserQuestion", ["bash", "mcp", "task"])).toBe(false);
    expect(isPiToolDenied("unrelated_ext_tool", ["bash", "mcp"])).toBe(false);
  });

  test("pi has no web tools of its own, so a web restriction cannot be applied there", () => {
    expect(unsupportedGroups(["bash", "web"], "pi")).toEqual(["web"]);
    expect(unsupportedGroups(["bash", "web"], "claude")).toEqual([]);
    expect(unsupportedGroups(["bash"], "pi")).toEqual([]);
  });

  test("the reason a denied call is blocked with", () => {
    expect(notAvailableReason("bash")).toBe("bash is not available to this agent");
  });
});

describe("groups cover every tool of the group [S15 regression]", () => {
  test("Claude: the mcp group takes the MCP resource tools too (they read a server's data without asking)", () => {
    for (const name of ["ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool"]) {
      expect(claudeDeniedTools(["mcp"])).toContain(name);
      expect(isClaudeToolDenied(name, ["mcp"])).toBe(true);
    }
  });

  test("Claude: the task group takes Workflow (it starts subagents)", () => {
    expect(claudeDeniedTools(["task"])).toContain("Workflow");
    expect(isClaudeToolDenied("Workflow", ["task"])).toBe(true);
  });

  test("Claude: TaskOutput and TaskStop follow the bash and task groups", () => {
    for (const group of ["bash", "task"] as const) {
      expect(claudeDeniedTools([group])).toEqual(expect.arrayContaining(["TaskOutput", "TaskStop"]));
      expect(isClaudeToolDenied("TaskStop", [group])).toBe(true);
    }
    expect(isClaudeToolDenied("TaskOutput", ["edit", "mcp"])).toBe(false);
  });

  test("pi: the mcp group takes pi's MCP resource tools", () => {
    for (const name of ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]) expect(isPiToolDenied(name, ["mcp"])).toBe(true);
    expect(isPiToolDenied("read_mcp_resource", ["bash"])).toBe(false);
  });

  test("pi: an extension tool whose name is a case variant or synonym of a denied group is denied too", () => {
    for (const name of ["Bash", "BASH", "shell", "PowerShell"]) expect(isPiToolDenied(name, ["bash"])).toBe(true);
    for (const name of ["Write", "MultiEdit"]) expect(isPiToolDenied(name, ["edit"])).toBe(true);
    for (const name of ["Read", "GREP", "Glob"]) expect(isPiToolDenied(name, ["read"])).toBe(true);
    expect(isPiToolDenied("Bash", ["edit"])).toBe(false);
    expect(isPiToolDenied("AskUserQuestion", ["bash", "mcp", "task", "read", "edit"])).toBe(false);
  });
});

describe("parseTools, entries that are not applied are noted [S15 regression]", () => {
  test("`ask: false` is kept and says so", () => {
    const parsed = parseTools(null, ["ask: false"]);
    expect(parsed.tools).toBeUndefined();
    expect(parsed.notes).toEqual(["ask: the question tool is always kept"]);
  });

  test("`AskUserQuestion: false` next to a real denial notes the entry as written", () => {
    const parsed = parseTools(null, ["AskUserQuestion: false", "bash: false"]);
    expect(parsed.tools?.deny).toEqual(["bash"]);
    expect(parsed.notes).toEqual(["AskUserQuestion: the question tool is always kept"]);
  });

  test("`read: false` with every other group false keeps read and says so", () => {
    const parsed = parseTools(null, ["read: false", "edit: false", "bash: false", "web: false", "task: false", "mcp: false"]);
    expect(parsed.tools?.deny).not.toContain("read");
    expect(parsed.notes).toEqual(["read: read tools are kept so the agent can work"]);
  });

  test("a clean field has no notes", () => {
    expect(parseTools(null, ["bash: false", "ask: true"]).notes).toEqual([]);
    expect(parseTools("Read, Grep").notes).toEqual([]);
  });
});

describe("untrusted text is read in linear time", () => {
  const within = (run: () => void, ms = 100) => {
    const start = performance.now();
    run();
    expect(performance.now() - start).toBeLessThan(ms);
  };

  test("a long run of spaces before a value or a `#`", () => {
    within(() => parseTools("", [`bash:${" ".repeat(250_000)}false`]));
    within(() => parseTools("", [`bash: false${" ".repeat(250_000)}x`]));
    within(() => parseTools(`{ bash:${" ".repeat(250_000)}false }`));
  });

  test("a long name with many open parentheses", () => {
    within(() => groupOf("(".repeat(250_000)));
    within(() => parseTools("", [`${"(".repeat(250_000)}: false`]));
  });
});

describe("groupOf and a permission scope", () => {
  test("only a scope that closes at the end of the name is dropped", () => {
    expect(groupOf("Bash(git:*)  ")).toBe("bash");
    expect(groupOf("Bash(git:*) x")).toBeUndefined();
    expect(groupOf("Bash(a)(b)")).toBe("bash");
  });
});

describe("describeTools", () => {
  test("a few lost groups are listed as what the agent lacks, many as what it keeps", () => {
    expect(describeTools(parseTools("", ["bash: false", "webfetch: false"]).tools)).toBe("no bash, web");
    expect(describeTools(parseTools("Read").tools)).toBe("tools: read, ask");
    expect(describeTools(parseTools("Read, Bash").tools)).toBe("tools: read, bash, ask");
    expect(describeTools(parseTools("Read, Bash, Edit").tools)).toBe("no web, task, mcp");
  });

  test("an agent that restricts nothing has no description", () => {
    expect(describeTools(undefined)).toBeUndefined();
    expect(describeTools({ deny: [] })).toBeUndefined();
  });
});
