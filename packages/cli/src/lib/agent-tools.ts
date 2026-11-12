/**
 * An agent's `tools` field: which of marcsh's tool groups the engine takes away for that agent's turns.
 *
 * Only narrowing is possible. The field can remove tools, never add them: a read-only agent that lists `bash: true` still cannot run
 * bash (plan mode wins), and every tool that is left still asks before it runs. Tool names differ between the engines, so the field
 * is read as groups, each one a set of names on each engine.
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
  const note = (name: string) => {
    const shown = name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1)}…` : name;
    if (unknown.length < MAX_UNKNOWN && !unknown.includes(shown)) unknown.push(shown);
  };

  const deny = new Set<Group>();
  let known = 0;
  if (map.length > 0) {
    for (const [name, setting] of map) {
      const group = groupOf(name);
      const flag = setting.toLowerCase();
      if (!group || (flag !== "true" && flag !== "false")) note(name);
      else {
        known++;
        if (flag === "false") deny.add(group);
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

  // Never deny the question tool; and never leave an agent with nothing to read with.
  deny.delete("ask");
  if (TOOL_GROUPS.every((group) => group === "read" || group === "ask" || deny.has(group))) deny.delete("read");
  return { tools: known > 0 && deny.size > 0 ? { deny: ordered(deny) } : undefined, unknown, empty: map.length + list.length === 0 };
}

// ---- Claude ----

const CLAUDE_NAMES: Record<Exclude<Group, "ask" | "mcp">, readonly string[]> = {
  read: ["Read", "Grep", "Glob", "NotebookRead", "LS"],
  edit: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
  bash: ["Bash", "BashOutput", "KillShell", "KillBash", "PowerShell"],
  web: ["WebFetch", "WebSearch"],
  task: ["Task", "Agent"],
};

const CLAUDE_MCP_PREFIX = "mcp__";

/**
 * What goes into the SDK's `disallowedTools` for the denied groups. The SDK's own docs describe `mcp__*` (and `mcp__server`) as removing
 * every MCP tool for an agent definition; the same permission rule syntax is used for the session option, and the Claude engine
 * also refuses such a call in `canUseTool` (see {@link isClaudeToolDenied}) in case the rule is not honoured there.
 */
export function claudeDeniedTools(deny: readonly Group[]): string[] {
  return deny.flatMap((group) => (group === "mcp" ? [`${CLAUDE_MCP_PREFIX}*`] : group === "ask" ? [] : CLAUDE_NAMES[group]));
}

/** Whether a Claude tool call is one of the denied groups'. */
export function isClaudeToolDenied(toolName: string, deny: readonly Group[]): boolean {
  if (deny.includes("mcp") && toolName.startsWith(CLAUDE_MCP_PREFIX)) return true;
  return claudeDeniedTools(deny).includes(toolName);
}

// ---- pi ----

// pi's own tool names, and marcsh's `Task` (TASK_TOOL in engine/pi-subagent.ts; this module stays free of engine imports).
// pi has no web tools of its own, so `web` names nothing there; MCP tools are the `mcp__server__tool` ones of marcsh's MCP extension.
const PI_NAMES: Record<Exclude<Group, "ask" | "mcp">, readonly string[]> = {
  read: ["read", "grep", "find", "ls"],
  edit: ["edit", "write"],
  bash: ["bash", "powershell"],
  web: [],
  task: ["Task"],
};

/** Whether a pi tool, by name, belongs to a denied group. An extension tool with a built-in's name is denied too: narrowing is the safe side. */
export function isPiToolDenied(toolName: string, deny: readonly Group[]): boolean {
  if (deny.includes("mcp") && toolName.startsWith(CLAUDE_MCP_PREFIX)) return true;
  return deny.some((group) => group !== "mcp" && group !== "ask" && PI_NAMES[group].includes(toolName));
}

/** The denied groups an engine has no way to apply. Selecting the agent warns about them. */
export function unsupportedGroups(deny: readonly Group[], engineId: string): Group[] {
  return engineId === "pi" ? deny.filter((group) => group === "web") : [];
}

/** What the model is told when it calls a tool its agent does not get. */
export const notAvailableReason = (toolName: string) => `${toolName} is not available to this agent`;
