import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
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
  test("creates a Claude session with no messages and no engine session yet", () => {
    const storage = openStorage(":memory:");

    const session = storage.createSession({ title: "First", cwd: "/work" });

    expect(session.title).toBe("First");
    expect(session.cwd).toBe("/work");
    expect(session.engine).toBe("claude");
    expect(session.engineSessionRef).toBeNull();
    expect(session.messages).toEqual([]);
    expect(storage.getSession(session.id)).toEqual(session);
  });

  test("returns null for an unknown session", () => {
    const storage = openStorage(":memory:");

    expect(storage.getSession("missing")).toBeNull();
  });

  test("creates a session owned by the given engine", () => {
    const storage = openStorage(":memory:");

    const session = storage.createSession({ title: "Pi", cwd: "/work", engine: "pi" });

    expect(session.engine).toBe("pi");
    expect(storage.getSession(session.id)?.engine).toBe("pi");
  });

  test("saves messages and the engine session reference", () => {
    const storage = openStorage(":memory:");
    const session = storage.createSession({ title: "Chat", cwd: "/work" });

    setSystemTime(new Date("2030-01-01T00:00:00Z"));
    storage.saveMessages(session.id, [userMessage], "claude-123");

    const saved = storage.getSession(session.id);
    expect(saved?.messages).toEqual([userMessage]);
    expect(saved?.engineSessionRef).toBe("claude-123");
    expect(saved?.updatedAt).toEqual(new Date("2030-01-01T00:00:00Z"));
  });

  test("keeps the stored engine session reference when none is given", () => {
    const storage = openStorage(":memory:");
    const session = storage.createSession({ title: "Chat", cwd: "/work" });
    storage.saveMessages(session.id, [], "claude-123");

    storage.saveMessages(session.id, [userMessage]);

    expect(storage.getSession(session.id)?.engineSessionRef).toBe("claude-123");
  });

  describe("databases created before engines", () => {
    function oldDatabase() {
      const path = `${process.env.TMPDIR ?? "/tmp"}/marcsh-old-${crypto.randomUUID()}.db`;
      const db = new Database(path, { create: true, strict: true });
      db.run(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          cwd TEXT NOT NULL,
          claude_session_id TEXT,
          messages TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      db.query(
        `INSERT INTO sessions (id, title, cwd, claude_session_id, messages, created_at, updated_at)
         VALUES ('old', 'Old chat', '/work', 'claude-old', $messages, 1, 2),
                ('fresh', 'Never ran', '/work', NULL, '[]', 3, 4)`,
      ).run({ messages: JSON.stringify([userMessage]) });
      db.close();
      return {
        path,
        claudeSessionId: (id: string) => {
          const raw = new Database(path, { strict: true });
          try {
            return raw.query<{ claude_session_id: string | null }, { id: string }>("SELECT claude_session_id FROM sessions WHERE id = $id").get({ id })
              ?.claude_session_id;
          } finally {
            raw.close();
          }
        },
        cleanup: () => {
          for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
        },
      };
    }

    test("existing sessions belong to Claude and resume with their stored Claude session id", () => {
      const old = oldDatabase();
      try {
        const storage = openStorage(old.path);

        const session = storage.getSession("old");
        expect(session?.engine).toBe("claude");
        expect(session?.engineSessionRef).toBe("claude-old");
        expect(session?.messages).toEqual([userMessage]);
        expect(session?.title).toBe("Old chat");
        expect(storage.getSession("fresh")?.engineSessionRef).toBeNull();
        expect(storage.listSessions().map((s) => s.id)).toEqual(["fresh", "old"]);
      } finally {
        old.cleanup();
      }
    });

    test("opening the database again keeps everything", () => {
      const old = oldDatabase();
      try {
        openStorage(old.path).saveMessages("fresh", [], "claude-new");

        const reopened = openStorage(old.path);
        expect(reopened.getSession("old")?.engineSessionRef).toBe("claude-old");
        expect(reopened.getSession("fresh")?.engineSessionRef).toBe("claude-new");
      } finally {
        old.cleanup();
      }
    });

    test("Claude sessions still write the old column, so the previous marcsh can resume them after a rollback", () => {
      const old = oldDatabase();
      try {
        const storage = openStorage(old.path);

        storage.saveMessages("old", [userMessage], "claude-next");
        storage.saveMessages("fresh", [userMessage], "claude-first");

        expect(old.claudeSessionId("old")).toBe("claude-next");
        expect(old.claudeSessionId("fresh")).toBe("claude-first");
      } finally {
        old.cleanup();
      }
    });

    test("other engines never write the Claude session id", () => {
      const old = oldDatabase();
      try {
        const storage = openStorage(old.path);
        const pi = storage.createSession({ title: "Pi", cwd: "/work", engine: "pi" });

        storage.saveMessages(pi.id, [userMessage], "/sessions/pi.jsonl");

        expect(storage.getSession(pi.id)?.engineSessionRef).toBe("/sessions/pi.jsonl");
        expect(old.claudeSessionId(pi.id)).toBeNull();
      } finally {
        old.cleanup();
      }
    });
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
