import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ChatMessage } from "./chat-types";

export type SessionSummary = {
  id: string;
  title: string;
  cwd: string;
  createdAt: Date;
  updatedAt: Date;
};

export type StoredSession = SessionSummary & {
  claudeSessionId: string | null;
  messages: ChatMessage[];
};

export type Storage = {
  listSessions(): SessionSummary[];
  getSession(id: string): StoredSession | null;
  createSession(input: { title: string; cwd: string }): StoredSession;
  saveMessages(id: string, messages: ChatMessage[], claudeSessionId?: string): void;
};

type SessionRow = {
  id: string;
  title: string;
  cwd: string;
  claude_session_id: string | null;
  messages: string;
  created_at: number;
  updated_at: number;
};

export function defaultDbPath() {
  return process.env.MARCSH_DB_PATH ?? join(homedir(), ".marcsh", "marcsh.db");
}

export function openStorage(path = defaultDbPath()): Storage {
  if (path !== ":memory:") {
    // Owner-only permissions (rwx------) so other users on the machine can't read sessions
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      cwd TEXT NOT NULL,
      claude_session_id TEXT,
      messages TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  const selectSession = db.query<SessionRow, { id: string }>("SELECT * FROM sessions WHERE id = $id");

  function toSession(row: SessionRow): StoredSession {
    return {
      id: row.id,
      title: row.title,
      cwd: row.cwd,
      claudeSessionId: row.claude_session_id,
      messages: JSON.parse(row.messages) as ChatMessage[],
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  return {
    listSessions() {
      return db
        .query<Omit<SessionRow, "messages" | "claude_session_id">, []>(
          "SELECT id, title, cwd, created_at, updated_at FROM sessions ORDER BY updated_at DESC",
        )
        .all()
        .map((row) => ({
          id: row.id,
          title: row.title,
          cwd: row.cwd,
          createdAt: new Date(row.created_at),
          updatedAt: new Date(row.updated_at),
        }));
    },

    getSession(id) {
      const row = selectSession.get({ id });
      return row ? toSession(row) : null;
    },

    createSession({ title, cwd }) {
      const now = Date.now();
      const id = crypto.randomUUID();
      db.query(
        `INSERT INTO sessions (id, title, cwd, created_at, updated_at)
         VALUES ($id, $title, $cwd, $now, $now)`,
      ).run({ id, title, cwd, now });
      return toSession(selectSession.get({ id })!);
    },

    saveMessages(id, messages, claudeSessionId) {
      db.query(
        `UPDATE sessions
         SET messages = $messages,
             claude_session_id = COALESCE($claudeSessionId, claude_session_id),
             updated_at = $now
         WHERE id = $id`,
      ).run({
        id,
        messages: JSON.stringify(messages),
        claudeSessionId: claudeSessionId ?? null,
        now: Date.now(),
      });
    },
  };
}

let defaultStorage: Storage | undefined;

export function getStorage(): Storage {
  defaultStorage ??= openStorage();
  return defaultStorage;
}
