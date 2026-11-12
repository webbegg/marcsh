/**
 * An agent's `tools` field: which of marcsh's tool groups the engine takes away for that agent's turns.
 *
 * Only narrowing is possible. The field can remove tools, never add them: a read-only agent that lists `bash: true` still cannot run
 * bash (plan mode wins), and every tool that is left still asks before it runs. Tool names differ between the engines, so the field
 * is read as groups, each one a set of names on each engine.
 *
 * The groups are the only thing the field can take away. A tool that belongs to none of them (Claude's EnterWorktree, CronCreate,
 * SendMessage or Skill; a pi user extension's own tools) is left as it is, in the map form and in the list form alike: the list
 * `Read, Grep` means "of the seven groups, only read", not "nothing else exists".
 */

export const TOOL_GROUPS = ["read", "edit", "bash", "web", "task", "ask", "mcp"] as const;
export type Group = (typeof TOOL_GROUPS)[number];

/**
 * The groups an agent does not get. `ask` is never in it: marcsh asks the user its questions through that tool on both engines, so
 * an agent without it could not ask. `read` stays too when everything else would go: an agent with no tools at all is not useful.
 */
export type AgentTools = { deny: Group[] };

export type ParsedTools = {
  /** Undefined: no restriction (nothing was denied, or no name could be read). */
  tools?: AgentTools;
  /** Names that match no group, as written; shown in the warning. At most {@link MAX_UNKNOWN}, each at most {@link MAX_NAME} characters. */
  unknown: string[];
  /** The field held no name at all: it is reported as ignored. */
  empty: boolean;
  /** Entries written but not applied because a group is always kept (see {@link AgentTools}); one line each, shown in the warning. */
  notes: string[];
};

const MAX_UNKNOWN = 8;
const MAX_NAME = 40;

// Lower case. Claude Code's names, OpenCode's names, a few common spellings, and the group names themselves.
const NAMES: Record<Exclude<Group, "mcp">, readonly string[]> = {
  read: ["read", "grep", "glob", "find", "ls", "list", "notebookread"],
  edit: ["edit", "write", "patch", "multiedit", "notebookedit"],
  bash: ["bash", "shell", "powershell"],
  web: ["web", "webfetch", "websearch", "fetch"],
  task: ["task", "agent", "subagent"],
  ask: ["ask", "askuserquestion", "question", "ask_user"],
};

/** The group of a tool name, ignoring case and a permission scope (`Bash(git:*)`); undefined when it is none of them. */
export function groupOf(name: string): Group | undefined {
  const key = name.replace(/\(.*\)\s*$/, "").trim().toLowerCase();
  if (!key) return undefined;
  // `mcp`, `mcp__server__tool`, `mcp_server_tool`, and OpenCode's `server_*` wildcards.
  if (key === "mcp" || key.startsWith("mcp__") || key.startsWith("mcp_") || key.endsWith("_*")) return "mcp";
  return (Object.keys(NAMES) as (keyof typeof NAMES)[]).find((group) => NAMES[group].includes(key));
}

const unquote = (text: string) => text.trim().replace(/^(["'])(.*)\1$/, "$2").trim();

/** Splits at commas and spaces that are outside parentheses, so `Bash(git add:*, git commit:*)` stays one name. */
function splitNames(text: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (char === "," || /\s/.test(char))) {
      if (current) names.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) names.push(current);
  return names.map(unquote).filter(Boolean);
}

type Entries = { map: [string, string][]; list: string[] };

/** The `key: value` and list entries of the field: its line value (a flow map, a flow list or a plain list) and its indented lines. */
function entriesOf(value: string | null | undefined, nested: readonly string[]): Entries {
  const entries: Entries = { map: [], list: [] };
  const pair = (text: string) => {
    const colon = text.indexOf(":");
    if (colon <= 0) return false;
    entries.map.push([unquote(text.slice(0, colon)), text.slice(colon + 1).replace(/\s+#.*$/, "").trim()]);
    return true;
  };

  const line = value?.trim() ?? "";
  if (/^\{.*\}$/.test(line)) {
    for (const part of line.slice(1, -1).split(",")) pair(part.trim());
  } else if (line) {
    entries.list.push(...splitNames(line.replace(/^\[(.*)\]$/, "$1")));
  }
  for (const raw of nested) {
    const text = raw.trim().replace(/\s+#.*$/, "");
    if (text.startsWith("- ")) entries.list.push(...splitNames(text.slice(2)));
    else pair(text);
  }
  return entries;
}

const ordered = (groups: Set<Group>) => TOOL_GROUPS.filter((group) => groups.has(group));

/**
 * Reads the `tools` field, in either form:
 * - OpenCode map (`bash: false` lines, or `{ bash: false }`): a group is denied when any name in it is false; true changes nothing.
 * - Claude Code list (`Read, Grep`, `[Read, Grep]`, or `- Read` lines): only the named groups are kept.
 * Names are grouped coarsely (`mcp__server__tool` is the whole mcp group). If both forms appear the map wins and the list names are unknown.
 */
export function parseTools(value: string | null | undefined, nested: readonly string[] = []): ParsedTools {
  const { map, list } = entriesOf(value, nested);
  const unknown: string[] = [];
  const notes: string[] = [];
  const shown = (name: string) => (name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1)}…` : name);
  const note = (name: string) => {
    if (unknown.length < MAX_UNKNOWN && !unknown.includes(shown(name))) unknown.push(shown(name));
  };
  const keptNote = (line: string) => {
    if (notes.length < MAX_UNKNOWN && !notes.includes(line)) notes.push(line);
  };

  const deny = new Set<Group>();
  // The entry, as written, that first denied each group: named when the group is kept anyway.
  const deniedBy = new Map<Group, string>();
  let known = 0;
  if (map.length > 0) {
    for (const [name, setting] of map) {
      const group = groupOf(name);
      const flag = setting.toLowerCase();
      if (!group || (flag !== "true" && flag !== "false")) note(name);
      else {
        known++;
        if (flag === "false") {
          deny.add(group);
          if (!deniedBy.has(group)) deniedBy.set(group, shown(name));
        }
      }
    }
    for (const name of list) note(name);
  } else {
    const kept = new Set<Group>();
    for (const name of list) {
      const group = groupOf(name);
      if (group) kept.add(group);
      else note(name);
    }
    known = kept.size;
    if (known > 0) for (const group of TOOL_GROUPS) if (!kept.has(group)) deny.add(group);
  }

  // Never deny the question tool; and never leave an agent with nothing to read with. An entry that asked for either is said so.
  if (deny.delete("ask") && deniedBy.has("ask")) keptNote(`${deniedBy.get("ask")}: the question tool is always kept`);
  if (deny.has("read") && TOOL_GROUPS.every((group) => group === "read" || group === "ask" || deny.has(group))) {
    deny.delete("read");
    keptNote(`${deniedBy.get("read") ?? "read"}: read tools are kept so the agent can work`);
  }
  return { tools: known > 0 && deny.size > 0 ? { deny: ordered(deny) } : undefined, unknown, empty: map.length + list.length === 0, notes };
}

// ---- Claude ----

// `TaskOutput` and `TaskStop` read and stop background shells and subagents alike, so they follow both groups. `Workflow` starts subagents.
const CLAUDE_NAMES: Record<Exclude<Group, "ask" | "mcp">, readonly string[]> = {
  read: ["Read", "Grep", "Glob", "NotebookRead", "LS"],
  edit: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
  bash: ["Bash", "BashOutput", "KillShell", "KillBash", "PowerShell", "TaskOutput", "TaskStop"],
  web: ["WebFetch", "WebSearch"],
  task: ["Task", "Agent", "Workflow", "TaskOutput", "TaskStop"],
};

const CLAUDE_MCP_PREFIX = "mcp__";

// The SDK's tools that read a connected server's resources: they run without asking, so the mcp group has to take them too.
const CLAUDE_MCP_RESOURCE_TOOLS = ["ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool"];

/**
 * What goes into the SDK's `disallowedTools` for the denied groups. The SDK's own docs describe `mcp__*` (and `mcp__server`) as removing
 * every MCP tool for an agent definition; the same permission rule syntax is used for the session option, and the Claude engine
 * also refuses such a call in `canUseTool` (see {@link isClaudeToolDenied}) in case the rule is not honoured there.
 */
export function claudeDeniedTools(deny: readonly Group[]): string[] {
  const names = deny.flatMap((group) => (group === "mcp" ? [`${CLAUDE_MCP_PREFIX}*`, ...CLAUDE_MCP_RESOURCE_TOOLS] : group === "ask" ? [] : CLAUDE_NAMES[group]));
  return [...new Set(names)];
}

/** Whether a Claude tool call is one of the denied groups'. */
export function isClaudeToolDenied(toolName: string, deny: readonly Group[]): boolean {
  if (deny.includes("mcp") && toolName.startsWith(CLAUDE_MCP_PREFIX)) return true;
  return claudeDeniedTools(deny).includes(toolName);
}

// ---- pi ----

// pi's tools are read through the same case-insensitive names the field is parsed with (`groupOf`), so pi's own (`read`, `bash`,
// `grep`, `find`, `ls`, `edit`, `write`), marcsh's `Task` (TASK_TOOL in engine/pi-subagent.ts; this module stays free of engine imports)
// and an extension's `Bash`, `BASH` or `shell` all land in their group. pi has no web tools of its own, so `web` finds none there
// unless an extension is named like one. MCP tools are the `mcp__server__tool` ones of marcsh's MCP extension, plus pi's resource tools.
const PI_MCP_RESOURCE_TOOLS = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

/** Whether a pi tool, by name, belongs to a denied group. An extension tool with a built-in's name is denied too: narrowing is the safe side. */
export function isPiToolDenied(toolName: string, deny: readonly Group[]): boolean {
  if (deny.includes("mcp") && PI_MCP_RESOURCE_TOOLS.includes(toolName.toLowerCase())) return true;
  const group = groupOf(toolName);
  return group !== undefined && group !== "ask" && deny.includes(group);
}

/** The denied groups an engine has no way to apply. Selecting the agent warns about them. */
export function unsupportedGroups(deny: readonly Group[], engineId: string): Group[] {
  return engineId === "pi" ? deny.filter((group) => group === "web") : [];
}

/** What the model is told when it calls a tool its agent does not get. */
export const notAvailableReason = (toolName: string) => `${toolName} is not available to this agent`;
