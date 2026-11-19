import { describe, expect, test } from "bun:test";
import {
  displayPath,
  refusalOf,
  patchStats,
  resultCount,
  todoItems,
  toolKind,
  toolStyle,
  toolTitle,
} from "./tool-display";
import type { MessagePart } from "./chat-types";

type ToolPart = Extract<MessagePart, { type: "tool" }>;
const part = (toolName: string, input: Record<string, unknown>, extra: Partial<ToolPart> = {}): ToolPart =>
  ({ type: "tool", toolCallId: "t1", toolName, input, state: "done", ...extra }) as ToolPart;

describe("toolKind", () => {
  test("knows Claude's tools and pi's by their own names", () => {
    expect([toolKind("Read"), toolKind("read")]).toEqual(["read", "read"]);
    expect([toolKind("Grep"), toolKind("grep")]).toEqual(["grep", "grep"]);
    expect([toolKind("Glob"), toolKind("find")]).toEqual(["glob", "glob"]);
    expect([toolKind("LS"), toolKind("ls")]).toEqual(["list", "list"]);
    expect([toolKind("Edit"), toolKind("MultiEdit"), toolKind("NotebookEdit"), toolKind("edit")]).toEqual(["edit", "edit", "edit", "edit"]);
    expect([toolKind("Write"), toolKind("write")]).toEqual(["write", "write"]);
    expect([toolKind("Bash"), toolKind("bash"), toolKind("PowerShell"), toolKind("bg_start")]).toEqual(["bash", "bash", "bash", "bash"]);
    expect([toolKind("Agent"), toolKind("Task")]).toEqual(["task", "task"]);
    expect([toolKind("TodoWrite"), toolKind("todo")]).toEqual(["todo", "todo"]);
    expect([toolKind("WebFetch"), toolKind("WebSearch")]).toEqual(["webfetch", "websearch"]);
    expect([toolKind("AskUserQuestion"), toolKind("Skill"), toolKind("ExitPlanMode")]).toEqual(["question", "skill", "plan"]);
  });

  test("anything else, MCP tools included, is generic", () => {
    expect(toolKind("mcp__github__create_issue")).toBe("generic");
    expect(toolKind("bg_status")).toBe("generic");
    expect(toolKind("echo")).toBe("generic");
  });
});

describe("toolStyle", () => {
  test("puts changes, commands, subagents, todos and plans in a block; lookups stay on one line", () => {
    for (const kind of ["bash", "edit", "write", "task", "todo", "plan"] as const) expect(toolStyle(kind)).toBe("block");
    for (const kind of ["read", "grep", "glob", "list", "webfetch", "websearch", "question", "skill", "generic"] as const) expect(toolStyle(kind)).toBe("inline");
  });
});

describe("displayPath", () => {
  test("is relative under the project and absolute elsewhere", () => {
    expect(displayPath("/work/app/src/a.ts", "/work/app")).toBe("src/a.ts");
    expect(displayPath("/work/app", "/work/app")).toBe(".");
    expect(displayPath("/work/other/b.ts", "/work/app")).toBe("/work/other/b.ts");
    expect(displayPath("/work/application/c.ts", "/work/app")).toBe("/work/application/c.ts");
    expect(displayPath("src/a.ts", "/work/app")).toBe("src/a.ts");
    expect(displayPath("/x/y.ts")).toBe("/x/y.ts");
  });
});

describe("toolTitle", () => {
  const cwd = "/p";

  test("a read names the file and the lines asked for", () => {
    expect(toolTitle(part("Read", { file_path: "/p/src/a.ts" }), cwd)).toEqual({ verb: "Read", subject: "src/a.ts" });
    expect(toolTitle(part("Read", { file_path: "/p/a.ts", offset: 10, limit: 50 }), cwd).subject).toBe("a.ts:10-59");
    expect(toolTitle(part("read", { path: "a.ts", offset: 5 }), cwd).subject).toBe("a.ts:5+");
  });

  test("a read range the model got wrong is left out instead of printed as asked", () => {
    expect(toolTitle(part("Read", { file_path: "/p/a.ts", offset: 10, limit: 0 }), cwd).subject).toBe("a.ts:10+");
    expect(toolTitle(part("Read", { file_path: "/p/a.ts", offset: 0, limit: 5 }), cwd).subject).toBe("a.ts:1-5");
    expect(toolTitle(part("Read", { file_path: "/p/a.ts", offset: -3 }), cwd).subject).toBe("a.ts");
  });

  test("a search quotes its pattern and says where", () => {
    expect(toolTitle(part("Grep", { pattern: "foo", path: "/p/src" }), cwd).subject).toBe('"foo" in src');
    expect(toolTitle(part("Glob", { pattern: "**/*.ts" }), cwd).subject).toBe('"**/*.ts"');
    expect(toolTitle(part("find", { pattern: "*.md", path: "docs" }), cwd)).toMatchObject({ verb: "Glob", subject: '"*.md" in docs' });
  });

  test("a search that finished counts what it found", () => {
    expect(toolTitle(part("Grep", { pattern: "x" }, { output: "Found 3 files\na\nb\nc" }), cwd).suffix).toBe("3 files");
    expect(toolTitle(part("Glob", { pattern: "x" }, { output: "a.ts\nb.ts" }), cwd).suffix).toBe("2 files");
    expect(toolTitle(part("grep", { pattern: "x" }, { output: "a:1:x" }), cwd).suffix).toBe("1 match");
    expect(toolTitle(part("Glob", { pattern: "x" }, { output: "No files found" }), cwd).suffix).toBe("no results");
    // No stored output (a call saved before output was kept) says nothing, rather than claiming nothing was found.
    expect(toolTitle(part("Grep", { pattern: "x" }), cwd).suffix).toBeUndefined();
    expect(toolTitle(part("Glob", { pattern: "x" }, { output: "  \n" }), cwd).suffix).toBeUndefined();
    expect(toolTitle(part("Grep", { pattern: "x" }, { state: "running" }), cwd).suffix).toBeUndefined();
    expect(toolTitle(part("Grep", { pattern: "x" }, { output: "a\nb", outputTruncated: true }), cwd).suffix).toBe("2+ matches");
  });

  test("commands, edits and the rest", () => {
    expect(toolTitle(part("Bash", { command: "npm test", description: "Run tests" }), cwd)).toEqual({ verb: "Shell", subject: "npm test" });
    expect(toolTitle(part("Bash", { command: "cat <<EOF > a.txt\nline\nEOF" }), cwd).subject).toBe("cat <<EOF > a.txt …");
    expect(toolTitle(part("Bash", { command: `echo ${"x".repeat(300)}` }), cwd).subject).toHaveLength(160);
    expect(toolTitle(part("bg_start", { command: "bun dev" }), cwd)).toMatchObject({ subject: "bun dev", badge: "background" });
    expect(toolTitle(part("Bash", { command: "sleep 9", run_in_background: true }), cwd).badge).toBe("background");
    expect(toolTitle(part("Edit", { file_path: "/p/a.ts" }), cwd)).toEqual({ verb: "Edit", subject: "a.ts" });
    expect(toolTitle(part("write", { path: "/p/b.ts" }), cwd)).toEqual({ verb: "Write", subject: "b.ts" });
    expect(toolTitle(part("WebFetch", { url: "https://x.dev" }), cwd)).toEqual({ verb: "Fetch", subject: "https://x.dev" });
    expect(toolTitle(part("WebSearch", { query: "opentui" }), cwd)).toEqual({ verb: "Search", subject: '"opentui"' });
    expect(toolTitle(part("Agent", { description: "Find bugs", subagent_type: "reviewer" }), cwd)).toEqual({ verb: "reviewer", subject: "Find bugs" });
    expect(toolTitle(part("Task", { description: "Look", agent: "explore", background: true }), cwd)).toEqual({ verb: "explore", subject: "Look", badge: "background" });
    expect(toolTitle(part("Task", { description: "Look" }), cwd)).toEqual({ verb: "Task", subject: "Look" });
    expect(toolTitle(part("AskUserQuestion", { questions: [{}, {}] }), cwd)).toEqual({ verb: "Asked", subject: "2 questions" });
    expect(toolTitle(part("Skill", { skill: "pdf" }), cwd)).toEqual({ verb: "Skill", subject: "pdf" });
  });

  test("an MCP tool names its server and tool; another tool keeps its name and a summary of its input", () => {
    expect(toolTitle(part("mcp__github__create_issue", { title: "Bug" }), cwd)).toEqual({ verb: "github › create_issue", subject: "Bug" });
    expect(toolTitle(part("bg_status", { id: "bg-1" }), cwd)).toEqual({ verb: "bg_status", subject: "bg-1" });
  });
});

describe("refusalOf", () => {
  test("tells a refusal from a failure, and an approval's from a question's", () => {
    expect(refusalOf("The user denied this tool call.")).toBe("denied");
    expect(refusalOf("The user declined to answer.")).toBe("declined");
    expect(refusalOf("exit code 1")).toBeUndefined();
    expect(refusalOf(undefined)).toBeUndefined();
  });
});

describe("patchStats", () => {
  test("counts added and removed lines, not the headers", () => {
    expect(patchStats("--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d")).toEqual({ added: 2, removed: 1 });
    expect(patchStats("")).toEqual({ added: 0, removed: 0 });
  });

  test("counts a changed line that itself starts with -- or ++", () => {
    expect(patchStats("@@ -1 +1 @@\n--- a comment\n+++x")).toEqual({ added: 1, removed: 1 });
    expect(patchStats("--- a/x\n+++ b/x\n@@ -1 +1 @@\n---- rule")).toEqual({ added: 0, removed: 1 });
  });
});

describe("todoItems", () => {
  test("reads Claude's TodoWrite list from its input", () => {
    const items = todoItems(part("TodoWrite", { todos: [
      { content: "one", status: "completed", activeForm: "Doing one" },
      { content: "two", status: "in_progress", activeForm: "Doing two" },
      { content: "three", status: "pending" },
    ] }));
    expect(items).toEqual([
      { text: "one", status: "done" },
      { text: "two", status: "in_progress" },
      { text: "three", status: "pending" },
    ]);
  });

  test("reads pi's todo list from the result it printed", () => {
    const output = "✓ a Write the test [done]\n◐ b Make it pass — almost [in_progress]\n⊘ c Ship [blocked]";
    expect(todoItems(part("todo", { action: "list" }, { output }))).toEqual([
      { text: "Write the test", status: "done" },
      { text: "Make it pass — almost", status: "in_progress" },
      { text: "Ship", status: "blocked" },
    ]);
    expect(todoItems(part("todo", { action: "clear" }, { output: "No todos" }))).toEqual([]);
  });

  test("is undefined when the list cannot be read", () => {
    expect(todoItems(part("TodoWrite", { todos: "nope" }))).toBeUndefined();
    expect(todoItems(part("todo", { action: "set" }, { state: "running" }))).toBeUndefined();
    expect(todoItems(part("todo", { action: "set" }, { output: "something else" }))).toBeUndefined();
  });
});
