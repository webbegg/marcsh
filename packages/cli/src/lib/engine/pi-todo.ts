import type { InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { applyTodo, renderTodos, restoreTodos, TODO_ACTIONS, TODO_STATUSES, type Todo, type TodoInput } from "../todo";
import type { ToolSource } from "./pi-permissions";

export const TODO_TOOL = "todo";
const TODO_EXTENSION = "marcsh-todo";
/** Where pi says a tool comes from when an inline extension named `marcsh-todo` registered it. */
const TODO_SOURCE = `<inline:${TODO_EXTENSION}>`;

/**
 * Whether pi's tool is marcsh's own `todo`. The name alone proves nothing: an extension can register a tool with it, and pi keeps the
 * first registration (user extensions load before marcsh's). The tool must come from marcsh's own extension.
 */
export function isMarcshTodo(tool: ToolSource): boolean {
  return tool.name === TODO_TOOL && tool.sourceInfo.path === TODO_SOURCE;
}

const todoItem = {
  type: "object",
  properties: {
    id: { type: "string", description: "A short id for the task, such as T1." },
    text: { type: "string", description: "What the task is." },
    status: { type: "string", enum: [...TODO_STATUSES], description: "Default: pending." },
    note: { type: "string", description: "Why it is blocked (what it waits for) or dropped. Required for those two." },
  },
  required: ["id", "text"],
};

// Plain JSON Schema, as the other marcsh tools: pi validates tool arguments against any JSON Schema.
const parameters = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...TODO_ACTIONS], description: "set replaces the whole list; update changes one item; list shows it; clear empties it." },
    todos: { type: "array", items: todoItem, description: "set: the whole new list." },
    id: { type: "string", description: "update: the id of the item to change." },
    status: { type: "string", enum: [...TODO_STATUSES], description: "update: the new status." },
    note: { type: "string", description: "update: the new note (empty text removes it). blocked and dropped need one." },
  },
  required: ["action"],
} as unknown as ToolDefinition["parameters"];

export function createTodoTool(): ToolDefinition {
  // The list lives in memory for as long as this tool does (one turn's session). The first call reads it back from the session's branch,
  // so a resumed conversation continues the list its last todo result recorded. Compaction can drop that result from the model's context,
  // and marcsh does not put the list back by itself: the model can ask for it with `list`.
  let todos: Todo[] | undefined;
  return {
    name: TODO_TOOL,
    label: "Todo",
    description:
      "Keep a task list for larger work: set the whole list at the start (each item has an id, text and status), then update items as " +
      "you start and finish them. Statuses: pending, in_progress, done, blocked, dropped; blocked and dropped need a note. " +
      "Use list to see the current list again. It changes no files and needs no approval.",
    parameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      todos ??= restoreTodos(ctx.sessionManager.getBranch());
      const next = applyTodo(todos, params as TodoInput);
      todos = next;
      return { content: [{ type: "text", text: renderTodos(next) }], details: { todos: next } };
    },
  };
}

/**
 * The named inline extension that offers the tool, so pi's tool list says it is marcsh's. Registered on the main session only
 * (a Task child has no list of its own), and not described in the system prompt.
 */
export function createTodoExtension(): InlineExtension {
  return {
    name: TODO_EXTENSION,
    hidden: true,
    factory: (pi) => {
      pi.registerTool(createTodoTool());
    },
  };
}
