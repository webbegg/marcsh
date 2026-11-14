import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ChatMessage } from "./chat-types";
import { normalizeClaudeCommands, normalizeEngineCommands, type ClaudeCommand } from "./claude-commands";

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

/** An "always allow" decision. `command` is set for `bash` (that exact command); other tools are allowed by name. */
export type PermissionRule = {
  cwd: string;
  toolName: string;
  command?: string;
};

/** An "allow similar commands under a folder" decision: the path program (`rm`, `mv`...) may run without asking when every target is inside `dir`. */
export type PathRule = {
  cwd: string;
  program: string;
  dir: string;
};

/** Whether pi may load a project's own pi files (extensions, MCP servers, settings...). A project nobody decided about has no decision. */
export type ProjectTrust = "trusted" | "untrusted";

/**
 * What the user reviewed when trusting a project: one entry per listed path with a hash of what was shown for it and a hash of
 * its contents (a folder: of what it holds). Only paths and hashes; never contents, commands or environment values.
 */
export type StoredReview = { path: string; shown: string; content: string }[];

export type Storage = {
  listSessions(): SessionSummary[];
  getSession(id: string): StoredSession | null;
  createSession(input: { title: string; cwd: string; engine?: string }): StoredSession;
  saveMessages(id: string, messages: ChatMessage[], engineSessionRef?: string): void;
  /** Last known Claude Code commands and skills, kept so the `/` menu has them after a restart. */
  getClaudeCommands(): ClaudeCommand[];
  saveClaudeCommands(commands: ClaudeCommand[]): void;
  /** The last known command list of an engine (`claude` is the list above); every other engine has its own. */
  getCommands(engine: string): ClaudeCommand[];
  saveCommands(engine: string, commands: ClaudeCommand[]): void;
  addPermissionRule(rule: PermissionRule): void;
  hasPermissionRule(rule: PermissionRule): boolean;
  addPathRule(rule: PathRule): void;
  /** The path rules of the project at `cwd`. */
  pathRulesFor(cwd: string): PathRule[];
  /** The stored decision for the project at `cwd` (its resolved real path), or null when undecided. */
  getProjectTrust(cwd: string): ProjectTrust | null;
  /** Stores the decision for the project at `cwd`; null forgets it. A "trusted" keeps the `review` it was given; any other decision keeps none. */
  setProjectTrust(cwd: string, decision: ProjectTrust | null, review?: StoredReview): void;
  /** What was reviewed when the project at `cwd` was trusted; null when undecided, not trusted, trusted before reviews were kept, or unreadable. */
  getProjectReview(cwd: string): StoredReview | null;
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

// The Claude key is the one marcsh has always used; other engines get `<engine>_commands`.
const commandsKey = (engine: string) => (engine === "claude" ? CLAUDE_COMMANDS_KEY : `${engine}_commands`);

const marcshDir = () => join(homedir(), ".marcsh");

/** The stored review as written by `setProjectTrust`; anything else (damaged, from another version) is no review. */
function parseReview(text: string | null): StoredReview | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    const review: StoredReview = [];
    for (const entry of parsed) {
      if (typeof entry?.path !== "string" || typeof entry.shown !== "string" || typeof entry.content !== "string") return null;
      review.push({ path: entry.path, shown: entry.shown, content: entry.content });
    }
    return review;
  } catch {
    return null;
  }
}

/** A project is known by its real path, so a symlink and its target share one decision. A folder that is not there yet keeps its absolute path. */
function projectPath(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

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
  // `command` is empty for rules on a whole tool; a bash rule always has a non-empty command.
  db.run(`
    CREATE TABLE IF NOT EXISTS permission_rules (
      cwd TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      command TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (cwd, tool_name, command)
    )
  `);

  // Folder rules ("allow `rm` under /tmp/x"): one row per project, program and folder.
  db.run(`
    CREATE TABLE IF NOT EXISTS path_rules (
      cwd TEXT NOT NULL,
      program TEXT NOT NULL,
      dir TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (cwd, program, dir)
    )
  `);

  // One row per project (its real path); undecided projects have no row. `reviewed` is the JSON of a StoredReview, set with a "trusted".
  db.run(`
    CREATE TABLE IF NOT EXISTS project_trust (
      path TEXT PRIMARY KEY,
      decision TEXT NOT NULL CHECK (decision IN ('trusted', 'untrusted')),
      decided_at INTEGER NOT NULL,
      reviewed TEXT
    )
  `);
  // Databases created before reviews only gain the column; their trusted rows have no review, so they are asked about again.
  const missingReviewed = () => !db.query<{ name: string }, []>("PRAGMA table_info(project_trust)").all().some((c) => c.name === "reviewed");
  if (missingReviewed()) {
    db.transaction(() => {
      if (missingReviewed()) db.run("ALTER TABLE project_trust ADD COLUMN reviewed TEXT");
    }).immediate();
  }

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

  function readCommands(key: string, normalize: (raw: unknown) => ClaudeCommand[]): ClaudeCommand[] {
    const row = db.query<{ value: string }, { key: string }>("SELECT value FROM meta WHERE key = $key").get({ key });
    if (!row) return [];
    try {
      return normalize(JSON.parse(row.value));
    } catch {
      return [];
    }
  }

  function writeCommands(key: string, commands: ClaudeCommand[], normalize: (raw: unknown) => ClaudeCommand[]) {
    db.query(
      `INSERT INTO meta (key, value) VALUES ($key, $value)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run({ key, value: JSON.stringify(normalize(commands)) });
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
      return readCommands(CLAUDE_COMMANDS_KEY, normalizeClaudeCommands);
    },

    saveClaudeCommands(commands) {
      writeCommands(CLAUDE_COMMANDS_KEY, commands, normalizeClaudeCommands);
    },

    getCommands(engine) {
      return readCommands(commandsKey(engine), engine === "claude" ? normalizeClaudeCommands : normalizeEngineCommands);
    },

    saveCommands(engine, commands) {
      writeCommands(commandsKey(engine), commands, engine === "claude" ? normalizeClaudeCommands : normalizeEngineCommands);
    },

    addPermissionRule({ cwd, toolName, command = "" }) {
      db.query(
        `INSERT OR IGNORE INTO permission_rules (cwd, tool_name, command, created_at)
         VALUES ($cwd, $toolName, $command, $now)`,
      ).run({ cwd, toolName, command, now: Date.now() });
    },

    hasPermissionRule({ cwd, toolName, command = "" }) {
      return (
        db
          .query("SELECT 1 FROM permission_rules WHERE cwd = $cwd AND tool_name = $toolName AND command = $command")
          .get({ cwd, toolName, command }) !== null
      );
    },

    addPathRule({ cwd, program, dir }) {
      db.query(
        `INSERT OR IGNORE INTO path_rules (cwd, program, dir, created_at)
         VALUES ($cwd, $program, $dir, $now)`,
      ).run({ cwd, program, dir, now: Date.now() });
    },

    pathRulesFor(cwd) {
      return db.query<PathRule, { cwd: string }>("SELECT cwd, program, dir FROM path_rules WHERE cwd = $cwd ORDER BY created_at, program, dir").all({ cwd });
    },

    getProjectTrust(cwd) {
      const row = db
        .query<{ decision: ProjectTrust }, { path: string }>("SELECT decision FROM project_trust WHERE path = $path")
        .get({ path: projectPath(cwd) });
      return row?.decision ?? null;
    },

    setProjectTrust(cwd, decision, review) {
      const path = projectPath(cwd);
      if (decision === null) {
        db.query("DELETE FROM project_trust WHERE path = $path").run({ path });
        return;
      }
      // Fields are copied one by one: nothing but the path and the two hashes is ever written.
      const reviewed =
        decision === "trusted" && review ? JSON.stringify(review.map(({ path, shown, content }) => ({ path, shown, content }))) : null;
      db.query(
        `INSERT INTO project_trust (path, decision, decided_at, reviewed) VALUES ($path, $decision, $now, $reviewed)
         ON CONFLICT(path) DO UPDATE SET decision = excluded.decision, decided_at = excluded.decided_at, reviewed = excluded.reviewed`,
      ).run({ path, decision, now: Date.now(), reviewed });
    },

    getProjectReview(cwd) {
      const row = db
        .query<{ reviewed: string | null }, { path: string }>("SELECT reviewed FROM project_trust WHERE path = $path AND decision = 'trusted'")
        .get({ path: projectPath(cwd) });
      return parseReview(row?.reviewed ?? null);
    },
  };
}

let defaultStorage: Storage | undefined;

export function getStorage(): Storage {
  defaultStorage ??= openStorage();
  return defaultStorage;
}
