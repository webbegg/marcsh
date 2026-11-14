/**
 * An agent's `tools` field: the tool groups the engine takes away for its turns. It only narrows (plan mode and approvals still apply),
 * and a tool in no group (Claude's Skill, a pi extension's own tools) is left alone, in the list form too.
 */

import { CLAUDE_MCP_PREFIX, CLAUDE_MCP_RESOURCE_TOOLS, FIELD_NAMES, PI_TOOL_GROUPS, TOOL_GROUPS, claudeGroupTools, type Group } from "./tool-names";

/** The groups an agent does not get. Never `ask` (marcsh asks its questions through it), and `read` stays when everything else would go. */
export type AgentTools = {
  deny: Group[];
  /** The denied groups that a map entry named itself (`web: false`), not through `*` or a list; only set when there are some. */
  named?: Group[];
};

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
const MAX_NOTES = 8;
const MAX_NAME = 40;

/** The name without a closing permission scope: `Bash(git:*)` is `Bash`. Scans, so a long run of `(` costs nothing. */
function withoutScope(name: string): string {
  const text = name.trimEnd();
  const open = text.indexOf("(");
  return text.endsWith(")") && open >= 0 && open < text.length - 1 ? text.slice(0, open) : name;
}

/** The group of a tool name, ignoring case and a permission scope (`Bash(git:*)`); undefined when it is none of them. */
export function groupOf(name: string): Group | undefined {
  const key = withoutScope(name).trim().toLowerCase();
  if (!key) return undefined;
  // `mcp`, `mcp__server__tool`, `mcp_server_tool`, and OpenCode's `server_*` wildcards.
  if (key === "mcp" || key.startsWith("mcp__") || key.startsWith("mcp_") || key.endsWith("_*")) return "mcp";
  return (Object.keys(FIELD_NAMES) as (keyof typeof FIELD_NAMES)[]).find((group) => FIELD_NAMES[group].includes(key));
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

/** The text before a `#` that follows whitespace (a YAML comment), without trailing whitespace. A scan: a `\s+#.*` regex backtracks quadratically. */
function withoutComment(text: string): string {
  for (let i = 1; i < text.length; i++) if (text[i] === "#" && /\s/.test(text[i - 1]!)) return text.slice(0, i).trimEnd();
  return text;
}

type Entries = { map: [string, string][]; list: string[] };

/** The `key: value` and list entries of the field: its line value (a flow map, a flow list or a plain list) and its indented lines. */
function entriesOf(value: string | null | undefined, nested: readonly string[]): Entries {
  const entries: Entries = { map: [], list: [] };
  const pair = (text: string) => {
    const colon = text.indexOf(":");
    if (colon <= 0) return false;
    entries.map.push([unquote(text.slice(0, colon)), withoutComment(text.slice(colon + 1)).trim()]);
    return true;
  };

  const line = value?.trim() ?? "";
  if (/^\{.*\}$/.test(line)) {
    for (const part of line.slice(1, -1).split(",")) pair(part.trim());
  } else if (line) {
    entries.list.push(...splitNames(line.replace(/^\[(.*)\]$/, "$1")));
  }
  for (const raw of nested) {
    const text = withoutComment(raw.trim());
    if (text.startsWith("- ")) entries.list.push(...splitNames(text.slice(2)));
    else pair(text);
  }
  return entries;
}

/** A short line for a review: what the agent lacks when that is a few groups, what it keeps when that is few. Undefined when it restricts nothing. */
export function describeTools(tools: AgentTools | undefined): string | undefined {
  if (!tools || tools.deny.length === 0) return undefined;
  if (tools.deny.length < 4) return `no ${tools.deny.join(", ")}`;
  return `tools: ${TOOL_GROUPS.filter((group) => !tools.deny.includes(group)).join(", ")}`;
}

const ordered = (groups: Set<Group>) => TOOL_GROUPS.filter((group) => groups.has(group));

/**
 * Reads the `tools` field, in either form:
 * - OpenCode map (`bash: false`, or `{ bash: false }`): a group is denied when any name in it is false. `*` sets every group first, wherever
 *   it is written (`"*": false, read: true` leaves only read; `"*": true` with some false denies just those).
 * - Claude Code list (`Read, Grep`, `[Read, Grep]`, or `- Read` lines): only the named groups are kept.
 * If both forms appear the map wins and the list names are unknown.
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
    if (notes.length < MAX_NOTES && !notes.includes(line)) notes.push(line);
  };

  const deny = new Set<Group>();
  const named = new Set<Group>();
  // The entry, as written, that first denied each group: named when the group is kept anyway.
  const deniedBy = new Map<Group, string>();
  let known = 0;
  if (map.length > 0) {
    let all: boolean | undefined;
    // A group's own entries: false when any is false, else true.
    const own = new Map<Group, boolean>();
    for (const [name, setting] of map) {
      const group = name === "*" ? "*" : groupOf(name);
      const flag = setting.toLowerCase();
      if (!group || (flag !== "true" && flag !== "false")) {
        note(name);
        continue;
      }
      known++;
      if (group === "*") all = flag === "true";
      else if (flag === "false") {
        own.set(group, false);
        named.add(group);
        if (!deniedBy.has(group)) deniedBy.set(group, shown(name));
      } else if (!own.has(group)) own.set(group, true);
    }
    for (const group of TOOL_GROUPS) {
      const denied = own.has(group) ? own.get(group) === false : all === false;
      if (!denied) continue;
      deny.add(group);
      if (!deniedBy.has(group) && group !== "ask") deniedBy.set(group, "*");
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
  const namedDenials = ordered(named).filter((group) => deny.has(group));
  const tools = known > 0 && deny.size > 0 ? { deny: ordered(deny), ...(namedDenials.length > 0 ? { named: namedDenials } : {}) } : undefined;
  return { tools, unknown, empty: map.length + list.length === 0, notes };
}

// ---- Claude ----

/** What goes into the SDK's `disallowedTools` for the denied groups; `canUseTool` refuses the same calls too ({@link isClaudeToolDenied}) in case a rule is not honoured. */
export function claudeDeniedTools(deny: readonly Group[]): string[] {
  const names = deny.flatMap((group) => (group === "mcp" ? [`${CLAUDE_MCP_PREFIX}*`, ...CLAUDE_MCP_RESOURCE_TOOLS] : claudeGroupTools(group)));
  return [...new Set(names)];
}

/** Whether a Claude tool call is one of the denied groups'. */
export function isClaudeToolDenied(toolName: string, deny: readonly Group[]): boolean {
  if (deny.includes("mcp") && toolName.startsWith(CLAUDE_MCP_PREFIX)) return true;
  return claudeDeniedTools(deny).includes(toolName);
}

// ---- pi ----

// pi tools are grouped by the same case-insensitive names as the field (`groupOf`), so an extension's `Bash` or `shell` lands in its group; pi has no web tools of its own.
const PI_MCP_RESOURCE_TOOLS = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

/** Whether a pi tool, by name, belongs to a denied group. An extension tool with a built-in's name is denied too: narrowing is the safe side. */
export function isPiToolDenied(toolName: string, deny: readonly Group[]): boolean {
  if (deny.includes("mcp") && PI_MCP_RESOURCE_TOOLS.includes(toolName.toLowerCase())) return true;
  const own = Object.hasOwn(PI_TOOL_GROUPS, toolName) ? PI_TOOL_GROUPS[toolName] : undefined;
  if (own) return own.some((group) => deny.includes(group));
  const group = groupOf(toolName);
  return group !== undefined && group !== "ask" && deny.includes(group);
}

/** The denied groups an engine has no way to apply. Selecting the agent warns about them. */
export function unsupportedGroups(deny: readonly Group[], engineId: string): Group[] {
  return engineId === "pi" ? deny.filter((group) => group === "web") : [];
}

/** What the model is told when it calls a tool its agent does not get. */
export const notAvailableReason = (toolName: string) => `${toolName} is not available to this agent`;
