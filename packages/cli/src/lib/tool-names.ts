/**
 * What marcsh knows about Claude's tools and pi's, in one table: which tool groups an agent's `tools` field can take away, what the field
 * calls them, and what Claude's hooks call a pi tool. Every mapping below is derived from {@link CLAUDE_TOOLS}.
 */

export const TOOL_GROUPS = ["read", "edit", "bash", "web", "task", "ask", "mcp"] as const;
export type Group = (typeof TOOL_GROUPS)[number];

type ClaudeTool = {
  /** The name Claude uses now. */
  name: string;
  /** Names Claude used before and still accepts in a matcher or a rule. */
  older?: string[];
  /** The groups whose denial takes the tool away. `TaskOutput` and `TaskStop` act on background shells and subagents alike; `Workflow` starts subagents. */
  groups: Group[];
  /** The pi tool it corresponds to, when there is one. */
  pi?: string;
  /** The `tools` field accepts its name (and its pi name), in any case. */
  field?: true;
};

// Order is the order of the names handed to the SDK's `disallowedTools`.
export const CLAUDE_TOOLS: readonly ClaudeTool[] = [
  { name: "Read", groups: ["read"], pi: "read", field: true },
  { name: "Grep", groups: ["read"], pi: "grep", field: true },
  { name: "Glob", groups: ["read"], pi: "find", field: true },
  { name: "NotebookRead", groups: ["read"], field: true },
  { name: "LS", groups: ["read"], pi: "ls", field: true },
  { name: "Edit", groups: ["edit"], pi: "edit", field: true },
  { name: "Write", groups: ["edit"], pi: "write", field: true },
  { name: "MultiEdit", groups: ["edit"], field: true },
  { name: "NotebookEdit", groups: ["edit"], field: true },
  { name: "Bash", groups: ["bash"], pi: "bash", field: true },
  { name: "BashOutput", groups: ["bash"] },
  { name: "KillShell", groups: ["bash"] },
  { name: "KillBash", groups: ["bash"] },
  { name: "PowerShell", groups: ["bash"], field: true },
  { name: "Agent", older: ["Task"], groups: ["task"], pi: "Task", field: true },
  { name: "Workflow", groups: ["task"] },
  { name: "TaskOutput", groups: ["bash", "task"] },
  { name: "TaskStop", groups: ["bash", "task"] },
  { name: "WebFetch", groups: ["web"], field: true },
  { name: "WebSearch", groups: ["web"], field: true },
];

// Spellings the field takes that are no tool's name: OpenCode's, a few common ones, and the group names themselves.
const FIELD_ALIASES: Record<Exclude<Group, "mcp">, readonly string[]> = {
  read: ["list"],
  edit: ["patch"],
  bash: ["shell"],
  web: ["web", "fetch"],
  task: ["subagent"],
  ask: ["ask", "askuserquestion", "question", "ask_user"],
};

const claudeNamesOf = (tool: ClaudeTool) => [...(tool.older ?? []), tool.name];

/** The Claude tools a denied group takes away (empty for `ask`, which is never denied, and `mcp`, which is matched by prefix). */
export const claudeGroupTools = (group: Group): string[] => CLAUDE_TOOLS.filter((tool) => tool.groups.includes(group)).flatMap(claudeNamesOf);

/** Lower-case names the `tools` field takes for each group (`mcp` is matched by pattern, see `groupOf`). */
export const FIELD_NAMES = Object.fromEntries(
  (Object.keys(FIELD_ALIASES) as (keyof typeof FIELD_ALIASES)[]).map((group): [keyof typeof FIELD_ALIASES, readonly string[]] => {
    const named = CLAUDE_TOOLS.filter((tool) => tool.field && tool.groups.includes(group)).flatMap((tool) => [...claudeNamesOf(tool), ...(tool.pi ? [tool.pi] : [])]);
    return [group, [...new Set([...named.map((name) => name.toLowerCase()), ...FIELD_ALIASES[group]])]];
  }),
) as Record<keyof typeof FIELD_ALIASES, readonly string[]>;

export const CLAUDE_MCP_PREFIX = "mcp__";

// The SDK's tools that read a connected server's resources: they run without asking, so the mcp group has to take them too.
export const CLAUDE_MCP_RESOURCE_TOOLS = ["ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool"];

/** The name Claude's hooks and matchers use for a pi tool now (`Task` is `Agent`): `AskUserQuestion` and `mcp__server__tool` already are; unknown tools keep their name. */
export const claudeToolName = (piName: string) => CLAUDE_TOOLS.find((tool) => tool.pi === piName)?.name ?? piName;

/** Every name a matcher may use for a pi tool: the current Claude name first, then the older ones. */
export const claudeToolNames = (piName: string) => {
  const name = claudeToolName(piName);
  return [name, ...(CLAUDE_TOOLS.find((tool) => tool.name === name)?.older ?? [])];
};
