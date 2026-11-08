import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ChatMessage } from "./chat-types";
import { normalizeClaudeCommands, type ClaudeCommand } from "./claude-commands";

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
  /** Last known Claude Code commands and skills, kept so the `/` menu has them after a restart. */
  getClaudeCommands(): ClaudeCommand[];
  saveClaudeCommands(commands: ClaudeCommand[]): void;
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

const CLAUDE_COMMANDS_KEY = "claude_commands";

const marcshDir = () => join(homedir(), ".marcsh");

export function defaultDbPath() {
  return process.env.MARCSH_DB_PATH?.trim() || join(marcshDir(), "marcsh.db");
}

export function openStorage(path = defaultDbPath()): Storage {
  const isFile = path !== ":memory:";

  if (isFile) {
    // Owner-only permissions (rwx------) so other users on the machine can't read sessions
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // mkdir leaves an existing ~/.marcsh (e.g. created 0755 by the theme provider) untouched.
    // Only our own directory is tightened; the parent of a custom MARCSH_DB_PATH is the user's.
    if (resolve(dirname(path)) === resolve(marcshDir())) chmodSync(dirname(path), 0o700);
  }

  const db = new Database(path, { create: true, strict: true });
  // Before enabling WAL, so the -wal and -shm files inherit the owner-only mode
  if (isFile) chmodSync(path, 0o600);
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

  db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

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

    getClaudeCommands() {
      const row = db
        .query<{ value: string }, { key: string }>("SELECT value FROM meta WHERE key = $key")
        .get({ key: CLAUDE_COMMANDS_KEY });
      if (!row) return [];
      try {
        return normalizeClaudeCommands(JSON.parse(row.value));
      } catch {
        return [];
      }
    },

    saveClaudeCommands(commands) {
      db.query(
        `INSERT INTO meta (key, value) VALUES ($key, $value)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run({ key: CLAUDE_COMMANDS_KEY, value: JSON.stringify(normalizeClaudeCommands(commands)) });
    },
  };
}

let defaultStorage: Storage | undefined;

export function getStorage(): Storage {
  defaultStorage ??= openStorage();
  return defaultStorage;
}
