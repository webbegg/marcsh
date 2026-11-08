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
  /** The engine that runs this session's turns (`claude` for sessions created before engines existed). */
  engine: string;
  /** The engine's reference for resuming the session, once its first turn has started. */
  engineSessionRef: string | null;
  messages: ChatMessage[];
};

export type Storage = {
  listSessions(): SessionSummary[];
  getSession(id: string): StoredSession | null;
  createSession(input: { title: string; cwd: string; engine?: string }): StoredSession;
  saveMessages(id: string, messages: ChatMessage[], engineSessionRef?: string): void;
  /** Last known Claude Code commands and skills, kept so the `/` menu has them after a restart. */
  getClaudeCommands(): ClaudeCommand[];
  saveClaudeCommands(commands: ClaudeCommand[]): void;
};

type SessionRow = {
  id: string;
  title: string;
  cwd: string;
  engine: string;
  engine_session_ref: string | null;
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
  // Another marcsh process may be saving a turn: wait for its write lock instead of failing.
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA journal_mode = WAL");
  // `claude_session_id` stays next to `engine_session_ref`: marcsh versions before engines resume Claude sessions from it.
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      cwd TEXT NOT NULL,
      claude_session_id TEXT,
      messages TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      engine TEXT NOT NULL DEFAULT 'claude',
      engine_session_ref TEXT
    )
  `);
  // Databases created before engines only gain columns; their rows become Claude sessions.
  const missingColumns = () => {
    const columns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(sessions)").all().map((c) => c.name));
    return { engine: !columns.has("engine"), ref: !columns.has("engine_session_ref") };
  };
  const missing = missingColumns();
  // Only an old file takes the write lock; checked again inside, since another marcsh may have just migrated it.
  if (missing.engine || missing.ref) {
    db.transaction(() => {
      const still = missingColumns();
      if (still.engine) db.run("ALTER TABLE sessions ADD COLUMN engine TEXT NOT NULL DEFAULT 'claude'");
      if (still.ref) db.run("ALTER TABLE sessions ADD COLUMN engine_session_ref TEXT");
    }).immediate();
  }

  db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

  const selectSession = db.query<SessionRow, { id: string }>("SELECT * FROM sessions WHERE id = $id");

  function toSession(row: SessionRow): StoredSession {
    return {
      id: row.id,
      title: row.title,
      cwd: row.cwd,
      engine: row.engine,
      // Claude sessions read the old column first: a previous marcsh (after a rollback) only updates that one.
      engineSessionRef: row.engine === "claude" ? (row.claude_session_id ?? row.engine_session_ref) : row.engine_session_ref,
      messages: JSON.parse(row.messages) as ChatMessage[],
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  return {
    listSessions() {
      return db
        .query<Pick<SessionRow, "id" | "title" | "cwd" | "created_at" | "updated_at">, []>(
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

    createSession({ title, cwd, engine = "claude" }) {
      const now = Date.now();
      const id = crypto.randomUUID();
      db.query(
        `INSERT INTO sessions (id, title, cwd, engine, created_at, updated_at)
         VALUES ($id, $title, $cwd, $engine, $now, $now)`,
      ).run({ id, title, cwd, engine, now });
      return toSession(selectSession.get({ id })!);
    },

    saveMessages(id, messages, engineSessionRef) {
      db.query(
        `UPDATE sessions
         SET messages = $messages,
             engine_session_ref = COALESCE($ref, engine_session_ref),
             claude_session_id = CASE WHEN engine = 'claude' THEN COALESCE($ref, claude_session_id) ELSE claude_session_id END,
             updated_at = $now
         WHERE id = $id`,
      ).run({
        id,
        messages: JSON.stringify(messages),
        ref: engineSessionRef ?? null,
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
