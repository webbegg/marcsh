/**
 * How the transcript draws a tool call: what kind of call it is (Claude's tool names and pi's map onto one set), whether it is a
 * one-line row or a block, its glyph, and the words of its title. Pure: no React, no I/O. The words are raw (from the model or
 * the tool); the components escape them before they are drawn.
 */
import type { MessagePart } from "./chat-types";
import { TODO_GLYPH, TODO_STATUSES, type TodoStatus } from "./todo";

type ToolPart = Extract<MessagePart, { type: "tool" }>;

export type ToolKind =
  | "read"
  | "grep"
  | "glob"
  | "list"
  | "edit"
  | "write"
  | "bash"
  | "webfetch"
  | "websearch"
  | "task"
  | "todo"
  | "question"
  | "skill"
  | "plan"
  | "generic";

const KINDS: Record<string, ToolKind> = {
  Read: "read",
  read: "read",
  NotebookRead: "read",
  Grep: "grep",
  grep: "grep",
  Glob: "glob",
  find: "glob",
  LS: "list",
  ls: "list",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  edit: "edit",
  Write: "write",
  write: "write",
  Bash: "bash",
  bash: "bash",
  PowerShell: "bash",
  bg_start: "bash",
  Agent: "task",
  Task: "task",
  TodoWrite: "todo",
  todo: "todo",
  WebFetch: "webfetch",
  WebSearch: "websearch",
  AskUserQuestion: "question",
  Skill: "skill",
  ExitPlanMode: "plan",
};

export const toolKind = (name: string): ToolKind => KINDS[name] ?? "generic";

/** A block is a panel with a body (output, diff, list); an inline call is one muted row. */
export type ToolStyle = "inline" | "block";

const BLOCKS = new Set<ToolKind>(["bash", "edit", "write", "task", "todo", "plan"]);
export const toolStyle = (kind: ToolKind): ToolStyle => (BLOCKS.has(kind) ? "block" : "inline");

/** One column each, so a row's title always starts in the same place. */
export const TOOL_ICON: Record<ToolKind, string> = {
  read: "→",
  grep: "✱",
  glob: "✱",
  list: "→",
  edit: "←",
  write: "←",
  bash: "$",
  webfetch: "%",
  websearch: "◈",
  task: "»",
  todo: "≡",
  question: "?",
  skill: "→",
  plan: "▣",
  generic: "⚙",
};

/** The words of a call's title: a verb, what it acts on, and, once known, a short result (`3 files`) and a badge (`background`). */
export type ToolTitle = { verb: string; subject: string; suffix?: string; badge?: string };

/** A path inside `cwd` relative to it (`.` for `cwd` itself); any other path as it is. */
export function displayPath(path: string, cwd?: string): string {
  if (!cwd || !path.startsWith("/")) return path;
  const base = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  if (path === base) return ".";
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const quoted = (value: string | undefined) => (value === undefined ? "" : `"${value}"`);
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

const MAX_SUMMARY_LENGTH = 80;
const PREFERRED_INPUT_KEYS = ["command", "file_path", "path", "pattern", "url", "query", "description", "id", "name", "title"];

/** The input's most telling string value, cut to 80 columns: the first preferred key that holds one, else the first string. */
export function summarizeToolInput(input: Record<string, unknown>): string {
  const preferred = PREFERRED_INPUT_KEYS.map((key) => input[key]).find((v) => typeof v === "string");
  const summary = preferred ?? Object.values(input).find((v) => typeof v === "string") ?? "";
  return typeof summary === "string" && summary.length > MAX_SUMMARY_LENGTH ? `${summary.slice(0, MAX_SUMMARY_LENGTH - 1)}…` : String(summary);
}

/** `fooBar` as `Foo Bar`, for a tool the transcript does not know. */
export function formatToolName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

const pathOf = (input: Record<string, unknown>) => str(input.file_path) ?? str(input.path) ?? str(input.notebook_path);

/** `a.ts:10-59` for a read with an offset and a limit, `a.ts:10+` with an offset only. */
function readRange(input: Record<string, unknown>): string {
  const offset = num(input.offset);
  const limit = num(input.limit);
  if (offset === undefined) return limit === undefined ? "" : `:1-${limit}`;
  return limit === undefined ? `:${offset}+` : `:${offset}-${offset + limit - 1}`;
}

const NOTHING_FOUND = /^no (files|matches|results)\b/i;
const FOUND = /^Found (\d+) (\w+)/;

/** What a finished search found, from its output: `3 files`, `12 matches`, `no results` (`2+` when the stored output was cut). */
export function resultCount(kind: ToolKind, part: ToolPart): string | undefined {
  if (part.state !== "done") return undefined;
  const output = part.output?.trim() ?? "";
  if (output === "" || NOTHING_FOUND.test(output)) return "no results";
  const found = FOUND.exec(output);
  if (found) return `${found[1]} ${found[2]}`;
  const lines = output.split("\n").filter((line) => line.trim() !== "").length;
  const more = part.outputTruncated ? "+" : "";
  const [one, many] = kind === "grep" ? ["match", "matches"] : kind === "list" ? ["entry", "entries"] : ["file", "files"];
  return `${lines}${more} ${lines === 1 && !more ? one : many}`;
}

/** The server and tool of an MCP tool's name (`mcp__server__tool`). */
const MCP_NAME = /^mcp__(.+?)__(.+)$/;

export function toolTitle(part: ToolPart, cwd?: string): ToolTitle {
  const { input } = part;
  const kind = toolKind(part.toolName);
  const path = (value: string | undefined) => (value === undefined ? "" : displayPath(value, cwd));
  const where = str(input.path) ? ` in ${path(str(input.path))}` : "";
  const background = input.run_in_background === true || input.background === true || part.toolName === "bg_start";
  const withBadge = (title: ToolTitle): ToolTitle => (background ? { ...title, badge: "background" } : title);

  switch (kind) {
    case "read":
      return { verb: "Read", subject: `${path(pathOf(input))}${readRange(input)}` };
    case "grep":
    case "glob": {
      const suffix = resultCount(kind, part);
      const title = { verb: kind === "grep" ? "Grep" : "Glob", subject: `${quoted(str(input.pattern))}${where}` };
      return suffix === undefined ? title : { ...title, suffix };
    }
    case "list": {
      const suffix = resultCount(kind, part);
      const title = { verb: "List", subject: path(str(input.path)) || "." };
      return suffix === undefined ? title : { ...title, suffix };
    }
    case "edit":
      return { verb: "Edit", subject: path(pathOf(input)) };
    case "write":
      return { verb: "Write", subject: path(pathOf(input)) };
    case "bash":
      return withBadge({ verb: "Shell", subject: str(input.command) ?? "" });
    case "webfetch":
      return { verb: "Fetch", subject: str(input.url) ?? "" };
    case "websearch":
      return { verb: "Search", subject: quoted(str(input.query)) };
    case "task":
      // Named for the subagent; without one, for the tool (Claude's `Agent`, pi's `Task`).
      return withBadge({ verb: str(input.subagent_type) ?? str(input.agent) ?? part.toolName, subject: str(input.description) ?? "" });
    case "todo":
      return { verb: "Todos", subject: "" };
    case "question": {
      const count = Array.isArray(input.questions) ? input.questions.length : 0;
      return { verb: "Asked", subject: count > 0 ? plural(count, "question") : "" };
    }
    case "skill":
      return { verb: "Skill", subject: str(input.skill) ?? str(input.name) ?? str(input.command) ?? "" };
    case "plan":
      return { verb: "Plan", subject: "" };
    default: {
      const mcp = MCP_NAME.exec(part.toolName);
      return { verb: mcp ? `${mcp[1]} › ${mcp[2]}` : part.toolName, subject: summarizeToolInput(input) };
    }
  }
}

/**
 * The word for an error that is the user's refusal (`denied` for an approval, `declined` for a question), which the transcript
 * does not show as a failure; undefined for any other error.
 */
export function refusalOf(errorText: string | undefined): "denied" | "declined" | undefined {
  if (errorText === undefined) return undefined;
  if (/\bdenied this tool call\b/i.test(errorText)) return "denied";
  if (/\bdeclined to answer\b/i.test(errorText)) return "declined";
  return undefined;
}

export const isDenied = (errorText: string | undefined): boolean => refusalOf(errorText) !== undefined;

/** Lines a unified diff adds and removes (its `+++`/`---` file headers left out). */
export function patchStats(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

export type TodoItem = { text: string; status: TodoStatus };

const CLAUDE_TODO_STATUS: Record<string, TodoStatus> = { pending: "pending", in_progress: "in_progress", completed: "done" };
const GLYPH_STATUS = new Map(Object.entries(TODO_GLYPH).map(([status, glyph]) => [glyph, status as TodoStatus]));
const isStatus = (value: string): value is TodoStatus => (TODO_STATUSES as readonly string[]).includes(value);

/** One line of pi's `renderTodos`: glyph, id, text (and note), `[status]`. */
const PI_TODO_LINE = /^(\S) (\S+) (.*) \[(\w+)\]$/;

/**
 * The list a todo call left: Claude's TodoWrite carries it in its input, pi's `todo` prints it as its result (see `renderTodos`).
 * Undefined while that is not known, or when it is not shaped as expected: the call then shows as any other.
 */
export function todoItems(part: ToolPart): TodoItem[] | undefined {
  if (part.toolName === "TodoWrite") {
    const todos = part.input.todos;
    if (!Array.isArray(todos)) return undefined;
    const items: TodoItem[] = [];
    for (const todo of todos as { content?: unknown; status?: unknown }[]) {
      const status = typeof todo?.status === "string" ? CLAUDE_TODO_STATUS[todo.status] : undefined;
      if (typeof todo?.content !== "string" || !status) return undefined;
      items.push({ text: todo.content, status });
    }
    return items;
  }
  if (part.state !== "done" || part.outputTruncated) return undefined;
  const output = part.output?.trim() ?? "";
  if (output === "" || output === "No todos") return [];
  const items: TodoItem[] = [];
  for (const line of output.split("\n")) {
    const match = PI_TODO_LINE.exec(line);
    if (!match || !isStatus(match[4]!) || GLYPH_STATUS.get(match[1]!) !== match[4]) return undefined;
    items.push({ text: match[3]!, status: match[4] });
  }
  return items;
}
