import { describe, expect, test } from "bun:test";
import { defaultExportPath, renderTranscript } from "./transcript";
import type { ChatMessage } from "./chat-types";
import type { StoredSession } from "./storage";

const messages: ChatMessage[] = [
  { id: "m1", role: "user", parts: [{ type: "text", text: "Fix the bug" }], metadata: { mode: "BUILD" } },
  {
    id: "m2",
    role: "assistant",
    parts: [
      { type: "reasoning", text: "secret thoughts" },
      { type: "text", text: "Looking at it." },
      { type: "tool", toolCallId: "t1", toolName: "bash", input: { command: "ls -la" }, state: "done" },
      { type: "tool", toolCallId: "t2", toolName: "edit", input: { path: "a.ts", content: "x".repeat(500) }, state: "error", errorText: "no such file" },
      { type: "task", taskId: "k1", description: "Explore", status: "completed", summary: "found it" },
      { type: "text", text: "Done." },
    ],
    metadata: { mode: "BUILD", agent: "builder", model: "sonnet", costUsd: 0.01 },
  },
  { id: "m3", role: "assistant", parts: [{ type: "text", text: "Plain" }], metadata: { mode: "PLAN" } },
];

const session: StoredSession = {
  id: "0123456789abcdef-aaaa",
  title: "Bug hunt",
  cwd: "/work/app",
  engine: "pi",
  engineSessionRef: "secret-ref",
  messages,
  createdAt: new Date("2030-03-04T10:00:00Z"),
  updatedAt: new Date("2030-03-05T10:00:00Z"),
};

describe("renderTranscript md", () => {
  const md = renderTranscript(session, "md");

  test("starts with the title, date, engine and model", () => {
    const head = md.split("\n## ")[0]!;
    expect(head).toContain("# Bug hunt");
    expect(head).toContain("2030-03-04");
    expect(head).toContain("pi");
    expect(head).toContain("sonnet");
  });

  test("labels messages You and the agent, falling back to Assistant", () => {
    expect(md.match(/^## .*$/gm)).toEqual(["## You", "## builder", "## Assistant"]);
  });

  test("keeps text parts in order and omits reasoning", () => {
    expect(md).toContain("Fix the bug");
    expect(md.indexOf("Looking at it.")).toBeLessThan(md.indexOf("Done."));
    expect(md).not.toContain("secret thoughts");
  });

  test("summarizes tool calls with name and short input", () => {
    expect(md).toContain("`bash`");
    expect(md).toContain("ls -la");
    expect(md).toContain("`edit`");
    expect(md).toContain("no such file");
    expect(md).not.toContain("x".repeat(200));
  });

  test("shows tasks and never the engine resume ref", () => {
    expect(md).toContain("Explore");
    expect(md).toContain("found it");
    expect(md).not.toContain("secret-ref");
  });

  test("strips terminal control sequences from text", () => {
    const dirty: StoredSession = {
      ...session,
      title: "T\x1b[31mitle\x1b[0m",
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "a\x1b[2Jb\x1b]0;owned\x07c\x07d" }] }],
    };

    const out = renderTranscript(dirty, "md");

    expect(out).toContain("# Title");
    expect(out).toContain("abc");
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("\x07");
    expect(out).not.toContain("owned");
  });

  test("renders a session with no messages", () => {
    const out = renderTranscript({ ...session, messages: [] }, "md");

    expect(out).toContain("# Bug hunt");
    expect(out).not.toContain("## ");
  });
});

describe("renderTranscript json", () => {
  const parsed = JSON.parse(renderTranscript(session, "json"));

  test("is versioned with session and messages", () => {
    expect(parsed.version).toBe(1);
    expect(parsed.session).toEqual({
      id: session.id,
      title: "Bug hunt",
      cwd: "/work/app",
      engine: "pi",
      model: "sonnet",
      createdAt: "2030-03-04T10:00:00.000Z",
      updatedAt: "2030-03-05T10:00:00.000Z",
    });
    expect(Object.keys(parsed)).toEqual(["version", "session", "messages"]);
  });

  test("maps messages and parts to a stable shape, without reasoning or the resume ref", () => {
    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages[0]).toEqual({ id: "m1", role: "user", parts: [{ type: "text", text: "Fix the bug" }] });
    expect(parsed.messages[1].agent).toBe("builder");
    expect(parsed.messages[1].model).toBe("sonnet");
    expect(parsed.messages[1].parts.map((p: { type: string }) => p.type)).toEqual(["text", "tool", "tool", "task", "text"]);
    expect(parsed.messages[1].parts[1]).toEqual({ type: "tool", name: "bash", input: { command: "ls -la" }, state: "done" });
    expect(parsed.messages[1].parts[2].error).toBe("no such file");
    expect(JSON.stringify(parsed)).not.toContain("secret");
  });

  test("strips terminal control sequences from text", () => {
    const out = renderTranscript(
      { ...session, messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "a\x1b[31mb" }] }] },
      "json",
    );

    expect(JSON.parse(out).messages[0].parts[0].text).toBe("ab");
  });
});

describe("defaultExportPath", () => {
  test("is marcsh-<short id>-<date>.<ext>", () => {
    const now = new Date(2030, 0, 5, 12);

    expect(defaultExportPath(session, "md", now)).toBe("marcsh-01234567-2030-01-05.md");
    expect(defaultExportPath(session, "json", now)).toBe("marcsh-01234567-2030-01-05.json");
  });
});
