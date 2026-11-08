import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDbPath, openStorage } from "./storage";
import type { ChatMessage } from "./chat-types";

const userMessage: ChatMessage = {
  id: "m1",
  role: "user",
  parts: [{ type: "text", text: "hello" }],
  metadata: { mode: "BUILD" },
};

afterEach(() => {
  setSystemTime();
});

describe("storage", () => {
  test("creates a session with no messages and no Claude session yet", () => {
    const storage = openStorage(":memory:");

    const session = storage.createSession({ title: "First", cwd: "/work" });

    expect(session.title).toBe("First");
    expect(session.cwd).toBe("/work");
    expect(session.claudeSessionId).toBeNull();
    expect(session.messages).toEqual([]);
    expect(storage.getSession(session.id)).toEqual(session);
  });

  test("returns null for an unknown session", () => {
    const storage = openStorage(":memory:");

    expect(storage.getSession("missing")).toBeNull();
  });

  test("saves messages and the Claude session id", () => {
    const storage = openStorage(":memory:");
    const session = storage.createSession({ title: "Chat", cwd: "/work" });

    setSystemTime(new Date("2030-01-01T00:00:00Z"));
    storage.saveMessages(session.id, [userMessage], "claude-123");

    const saved = storage.getSession(session.id);
    expect(saved?.messages).toEqual([userMessage]);
    expect(saved?.claudeSessionId).toBe("claude-123");
    expect(saved?.updatedAt).toEqual(new Date("2030-01-01T00:00:00Z"));
  });

  test("keeps the stored Claude session id when none is given", () => {
    const storage = openStorage(":memory:");
    const session = storage.createSession({ title: "Chat", cwd: "/work" });
    storage.saveMessages(session.id, [], "claude-123");

    storage.saveMessages(session.id, [userMessage]);

    expect(storage.getSession(session.id)?.claudeSessionId).toBe("claude-123");
  });

  test("lists sessions most recently updated first, without messages", () => {
    const storage = openStorage(":memory:");
    setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const older = storage.createSession({ title: "Older", cwd: "/a" });
    setSystemTime(new Date("2030-01-02T00:00:00Z"));
    const newer = storage.createSession({ title: "Newer", cwd: "/b" });
    setSystemTime(new Date("2030-01-03T00:00:00Z"));
    storage.saveMessages(older.id, [userMessage]);

    const list = storage.listSessions();

    expect(list.map((s) => s.id)).toEqual([older.id, newer.id]);
    expect(list[0]).not.toHaveProperty("messages");
  });

  test("makes the database file owner-only but leaves the parent of a custom path alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "marcsh-perm-"));
    chmodSync(dir, 0o755);
    const path = join(dir, "marcsh.db");

    try {
      openStorage(path).createSession({ title: "Private", cwd: "/work" });

      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("falls back to the default path when MARCSH_DB_PATH is empty", () => {
    const previous = process.env.MARCSH_DB_PATH;
    process.env.MARCSH_DB_PATH = "";

    try {
      expect(defaultDbPath()).toBe(join(homedir(), ".marcsh", "marcsh.db"));
    } finally {
      if (previous === undefined) delete process.env.MARCSH_DB_PATH;
      else process.env.MARCSH_DB_PATH = previous;
    }
  });

  test("falls back to the default path when MARCSH_DB_PATH is only whitespace, and trims a real path", () => {
    const previous = process.env.MARCSH_DB_PATH;

    try {
      process.env.MARCSH_DB_PATH = "  ";
      expect(defaultDbPath()).toBe(join(homedir(), ".marcsh", "marcsh.db"));

      process.env.MARCSH_DB_PATH = "  /data/my notes/x.db ";
      expect(defaultDbPath()).toBe("/data/my notes/x.db");
    } finally {
      if (previous === undefined) delete process.env.MARCSH_DB_PATH;
      else process.env.MARCSH_DB_PATH = previous;
    }
  });

  test("has no Claude commands until some are saved", () => {
    expect(openStorage(":memory:").getClaudeCommands()).toEqual([]);
  });

  test("saves and loads the Claude command list, replacing the previous one", () => {
    const storage = openStorage(":memory:");
    storage.saveClaudeCommands([
      { name: "probe:hello", description: "Say hello", argumentHint: "<who>" },
      { name: "old", description: "", argumentHint: "" },
    ]);

    storage.saveClaudeCommands([{ name: "review", description: "Review code", argumentHint: "" }]);

    expect(storage.getClaudeCommands()).toEqual([{ name: "review", description: "Review code", argumentHint: "" }]);
  });

  test("keeps the Claude command list across reopening the same file, next to the sessions", () => {
    const path = `${process.env.TMPDIR ?? "/tmp"}/marcsh-commands-${crypto.randomUUID()}.db`;
    const first = openStorage(path);
    const session = first.createSession({ title: "Kept", cwd: "/work" });
    first.saveClaudeCommands([{ name: "probe:hello", description: "Say hello", argumentHint: "<who>" }]);

    try {
      const reopened = openStorage(path);
      expect(reopened.getClaudeCommands()).toEqual([
        { name: "probe:hello", description: "Say hello", argumentHint: "<who>" },
      ]);
      expect(reopened.getSession(session.id)?.title).toBe("Kept");
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    }
  });

  test("keeps data across reopening the same file", () => {
    const path = `${process.env.TMPDIR ?? "/tmp"}/marcsh-storage-${crypto.randomUUID()}.db`;
    const session = openStorage(path).createSession({ title: "Persisted", cwd: "/work" });

    try {
      expect(openStorage(path).getSession(session.id)?.title).toBe("Persisted");
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    }
  });
});
