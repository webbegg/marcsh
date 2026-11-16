import { describe, expect, test } from "bun:test";
import { applyTodo, renderTodos, restoreTodos, type Todo } from "./todo";

// S2/T7: the pure logic of the `todo` tool.

const list: Todo[] = [
  { id: "T1", text: "scaffold", status: "done" },
  { id: "T2", text: "write the tool", status: "in_progress" },
  { id: "T3", text: "docs", status: "pending" },
];

describe("applyTodo set", () => {
  test("replaces the list; a missing status is pending and the input is not kept by reference", () => {
    const input = [{ id: "A", text: "first" }, { id: "B", text: "second", status: "done" as const }];
    const next = applyTodo(list, { action: "set", todos: input });
    expect(next).toEqual([
      { id: "A", text: "first", status: "pending" },
      { id: "B", text: "second", status: "done" },
    ]);
    expect(next[0]).not.toBe(input[0] as unknown);
  });

  test("a set without todos empties the list", () => {
    expect(applyTodo(list, { action: "set" })).toEqual([]);
  });

  test("blocked and dropped items need a note", () => {
    expect(() => applyTodo([], { action: "set", todos: [{ id: "A", text: "x", status: "blocked" }] })).toThrow("A is blocked; add a note saying what it waits for");
    expect(() => applyTodo([], { action: "set", todos: [{ id: "A", text: "x", status: "dropped" }] })).toThrow("A is dropped; add a note saying why");
    expect(applyTodo([], { action: "set", todos: [{ id: "A", text: "x", status: "dropped", note: "out of scope" }] })[0]!.note).toBe("out of scope");
  });

  test("a duplicate id, an empty id or text, and an unknown status are errors", () => {
    expect(() => applyTodo([], { action: "set", todos: [{ id: "A", text: "x" }, { id: "A", text: "y" }] })).toThrow("Duplicate todo id A");
    expect(() => applyTodo([], { action: "set", todos: [{ id: " ", text: "x" }] })).toThrow("needs an id");
    expect(() => applyTodo([], { action: "set", todos: [{ id: "A", text: "" }] })).toThrow("needs text");
    expect(() => applyTodo([], { action: "set", todos: [{ id: "A", text: "x", status: "finished" as never }] })).toThrow("status must be one of");
    expect(() => applyTodo([], { action: "set", todos: "nope" as never })).toThrow("todos must be a list");
  });

  test("an invalid set leaves the current list untouched", () => {
    const before = structuredClone(list);
    expect(() => applyTodo(list, { action: "set", todos: [{ id: "A", text: "ok" }, { id: "B", text: "" }] })).toThrow();
    expect(list).toEqual(before);
  });
});

describe("applyTodo update", () => {
  test("changes the status of one item and returns a new list", () => {
    const before = structuredClone(list);
    const next = applyTodo(list, { action: "update", id: "T3", status: "in_progress" });
    expect(next.map((t) => t.status)).toEqual(["done", "in_progress", "in_progress"]);
    expect(list).toEqual(before);
  });

  test("blocked and dropped need a note, given now or already there; an invalid update changes nothing", () => {
    const before = structuredClone(list);
    expect(() => applyTodo(list, { action: "update", id: "T3", status: "blocked" })).toThrow("T3 is blocked; add a note saying what it waits for");
    expect(list).toEqual(before);
    const next = applyTodo(list, { action: "update", id: "T3", status: "blocked", note: "waits for T2" });
    expect(next[2]).toEqual({ id: "T3", text: "docs", status: "blocked", note: "waits for T2" });
    // The note stays when the item comes back; an empty note clears it.
    const back = applyTodo(next, { action: "update", id: "T3", status: "pending" });
    expect(back[2]!.note).toBe("waits for T2");
    expect(applyTodo(back, { action: "update", id: "T3", note: "" })[2]).toEqual({ id: "T3", text: "docs", status: "pending" });
    // Clearing the note of a blocked item is refused.
    expect(() => applyTodo(next, { action: "update", id: "T3", note: "" })).toThrow("T3 is blocked");
  });

  test("an unknown id, a missing id, nothing to change and an unknown status are errors", () => {
    expect(() => applyTodo(list, { action: "update", id: "T9", status: "done" })).toThrow("Todo T9 not found");
    expect(() => applyTodo(list, { action: "update", status: "done" })).toThrow("update needs the id");
    expect(() => applyTodo(list, { action: "update", id: "T1" })).toThrow("update needs a status or a note");
    expect(() => applyTodo(list, { action: "update", id: "T1", status: "finished" as never })).toThrow("status must be one of");
  });
});

describe("applyTodo list, clear and unknown actions", () => {
  test("list returns the list as it is; clear empties it", () => {
    expect(applyTodo(list, { action: "list" })).toEqual(list);
    expect(applyTodo(list, { action: "clear" })).toEqual([]);
  });

  test("an unknown action is an error naming the valid ones", () => {
    expect(() => applyTodo(list, { action: "remove" as never })).toThrow("action must be one of set, update, list, clear");
    expect(() => applyTodo(list, undefined as never)).toThrow("action must be one of set, update, list, clear");
  });
});

describe("renderTodos", () => {
  test("a glyph, the id, the text, the note and a [status] suffix per item", () => {
    const items: Todo[] = [
      { id: "T1", text: "a", status: "pending" },
      { id: "T2", text: "b", status: "in_progress" },
      { id: "T3", text: "c", status: "done" },
      { id: "T4", text: "d", status: "blocked", note: "waits" },
      { id: "T5", text: "e", status: "dropped", note: "no" },
    ];
    expect(renderTodos(items)).toBe(
      ["○ T1 a [pending]", "◐ T2 b [in_progress]", "✓ T3 c [done]", "⊘ T4 d — waits [blocked]", "✕ T5 e — no [dropped]"].join("\n"),
    );
  });

  test("an empty list says so", () => {
    expect(renderTodos([])).toBe("No todos");
  });
});

describe("restoreTodos", () => {
  const result = (todos: unknown, toolName = "todo") => ({ type: "message", message: { role: "toolResult", toolName, details: { todos } } });

  test("the last todo result on the branch wins", () => {
    const entries = [result([{ id: "A", text: "x", status: "pending" }]), { type: "custom", customType: "other" }, result(list)];
    expect(restoreTodos(entries)).toEqual(list);
  });

  test("an empty list (a clear) is a list too", () => {
    expect(restoreTodos([result(list), result([])])).toEqual([]);
  });

  test("other tools, failed results and malformed details are skipped", () => {
    const failed = { type: "message", message: { role: "toolResult", toolName: "todo", isError: true, details: undefined } };
    const entries = [result(list), result(list.slice(0, 1), "bash"), failed, result("junk"), result([{ id: "A", text: "x", status: "finished" }]), { type: "message", message: { role: "user" } }, null];
    expect(restoreTodos(entries)).toEqual(list);
  });

  test("nothing recorded is an empty list, and the result is a copy", () => {
    expect(restoreTodos([])).toEqual([]);
    const restored = restoreTodos([result(list)]);
    expect(restored[0]).not.toBe(list[0]!);
  });
});
