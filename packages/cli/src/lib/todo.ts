/**
 * The `todo` tool's list: the visible plan of a larger piece of work, kept by the model (pi's `todo` tool; Claude has its own TodoWrite).
 * Pure: no state and no I/O. `applyTodo` returns the next list or throws an `Error` whose text goes to the model as the tool error;
 * it validates the whole input first and never changes the list it is given.
 */

export const TODO_STATUSES = ["pending", "in_progress", "done", "blocked", "dropped"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export const TODO_ACTIONS = ["set", "update", "list", "clear"] as const;
export type TodoAction = (typeof TODO_ACTIONS)[number];

export type Todo = {
  id: string;
  text: string;
  status: TodoStatus;
  /** Why it is blocked or dropped (required for those two). */
  note?: string;
};

export type TodoInput = {
  action: TodoAction;
  /** `set`: the whole new list. */
  todos?: { id: string; text: string; status?: TodoStatus; note?: string }[];
  /** `update`: the item to change, and what to change. */
  id?: string;
  status?: TodoStatus;
  note?: string;
};

export const TODO_GLYPH: Record<TodoStatus, string> = { pending: "○", in_progress: "◐", done: "✓", blocked: "⊘", dropped: "✕" };

const isStatus = (value: unknown): value is TodoStatus => (TODO_STATUSES as readonly unknown[]).includes(value);
const STATUS_ERROR = `status must be one of ${TODO_STATUSES.join(", ")}`;

/** The error for a blocked or dropped item without a note; undefined when the item is fine. */
function missingNote(todo: Todo): string | undefined {
  if ((todo.status === "blocked" || todo.status === "dropped") && !todo.note) {
    return `${todo.id} is ${todo.status}; add a note saying ${todo.status === "blocked" ? "what it waits for" : "why"}`;
  }
  return undefined;
}

function itemFrom(raw: unknown): Todo {
  const item = (raw ?? {}) as Record<string, unknown>;
  if (typeof item.id !== "string" || item.id.trim() === "") throw new Error("Every todo needs an id");
  const id = item.id;
  if (typeof item.text !== "string" || item.text.trim() === "") throw new Error(`Todo ${id} needs text`);
  if (item.status !== undefined && !isStatus(item.status)) throw new Error(`Todo ${id}: ${STATUS_ERROR}`);
  if (item.note !== undefined && typeof item.note !== "string") throw new Error(`Todo ${id}: note must be text`);
  const todo: Todo = { id, text: item.text, status: item.status ?? "pending", ...(item.note ? { note: item.note } : {}) };
  const error = missingNote(todo);
  if (error) throw new Error(error);
  return todo;
}

function setList(raw: unknown): Todo[] {
  if (raw !== undefined && !Array.isArray(raw)) throw new Error("todos must be a list of {id, text, status?, note?}");
  const seen = new Set<string>();
  return (raw ?? []).map((entry: unknown) => {
    const todo = itemFrom(entry);
    if (seen.has(todo.id)) throw new Error(`Duplicate todo id ${todo.id}`);
    seen.add(todo.id);
    return todo;
  });
}

function updateList(current: readonly Todo[], input: TodoInput): Todo[] {
  if (typeof input.id !== "string" || input.id === "") throw new Error("update needs the id of the todo to change");
  const at = current.findIndex((todo) => todo.id === input.id);
  if (at < 0) throw new Error(`Todo ${input.id} not found`);
  if (input.status === undefined && input.note === undefined) throw new Error("update needs a status or a note");
  if (input.status !== undefined && !isStatus(input.status)) throw new Error(STATUS_ERROR);
  if (input.note !== undefined && typeof input.note !== "string") throw new Error("note must be text");

  const { note: _kept, ...rest } = current[at]!;
  const note = input.note === undefined ? current[at]!.note : input.note || undefined;
  const changed: Todo = { ...rest, status: input.status ?? current[at]!.status, ...(note ? { note } : {}) };
  const error = missingNote(changed);
  if (error) throw new Error(error);
  return current.map((todo, index) => (index === at ? changed : { ...todo }));
}

/** The list after `input`; throws an `Error` for input that is not valid, and `current` is never changed. */
export function applyTodo(current: readonly Todo[], input: TodoInput): Todo[] {
  switch (input?.action) {
    case "set":
      return setList(input.todos);
    case "update":
      return updateList(current, input);
    case "list":
      return current.map((todo) => ({ ...todo }));
    case "clear":
      return [];
    default:
      throw new Error(`action must be one of ${TODO_ACTIONS.join(", ")}`);
  }
}

/** One line per item: glyph, id, text, the note and the `[status]`. */
export function renderTodos(todos: readonly Todo[]): string {
  if (todos.length === 0) return "No todos";
  return todos.map((todo) => `${TODO_GLYPH[todo.status]} ${todo.id} ${todo.text}${todo.note ? ` — ${todo.note}` : ""} [${todo.status}]`).join("\n");
}

/** A stored list that is valid as a whole, as a copy; undefined for anything else. */
function validList(raw: unknown): Todo[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  try {
    const todos = setList(raw);
    return todos;
  } catch {
    return undefined;
  }
}

/**
 * The list the session's branch last recorded: the details of the newest successful `todo` tool result.
 * Entries that are not one, results of other tools, failed calls and lists that are not valid are skipped.
 */
export function restoreTodos(branchEntries: readonly unknown[]): Todo[] {
  for (let at = branchEntries.length - 1; at >= 0; at--) {
    const entry = branchEntries[at] as { type?: unknown; message?: { role?: unknown; toolName?: unknown; isError?: unknown; details?: { todos?: unknown } } } | null;
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "toolResult" || message.toolName !== "todo" || message.isError) continue;
    const todos = validList(message.details?.todos);
    if (todos) return todos;
  }
  return [];
}
