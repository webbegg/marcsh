import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorage } from "./storage";

const OLD_SCHEMA = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    cwd TEXT NOT NULL,
    claude_session_id TEXT,
    messages TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dbPath() {
  const dir = mkdtempSync(join(tmpdir(), "marcsh-storage-lock-"));
  dirs.push(dir);
  return join(dir, "marcsh.db");
}

const HOLDER = `
  const { Database } = require("bun:sqlite");
  const db = new Database(process.argv.at(-1));
  db.run("BEGIN IMMEDIATE");
  db.run("INSERT INTO meta (key, value) VALUES ('busy', '1')");
  console.log("holding");
  setTimeout(() => { db.run("ROLLBACK"); db.close(); }, 300);
`;

// Another marcsh process writing (a turn being saved) while this one starts.
function holdWriteLock(path: string) {
  const other = new Database(path);
  other.run("BEGIN IMMEDIATE");
  other.run("INSERT INTO meta (key, value) VALUES ('busy', '1') ON CONFLICT(key) DO UPDATE SET value = '2'");
  return () => {
    other.run("ROLLBACK");
    other.close();
  };
}

describe("opening the database while another process writes (S3)", () => {
  test("an already migrated database opens without taking the write lock", () => {
    const path = dbPath();
    openStorage(path).createSession({ title: "t", cwd: "/" });
    const release = holdWriteLock(path);
    try {
      expect(() => openStorage(path).listSessions()).not.toThrow();
    } finally {
      release();
    }
  });

  test("an old database is migrated once the other writer finishes", async () => {
    const path = dbPath();
    const old = new Database(path);
    old.run("PRAGMA journal_mode = WAL");
    old.run(OLD_SCHEMA);
    old.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    old.run("INSERT INTO sessions (id, title, cwd, claude_session_id, created_at, updated_at) VALUES ('s1', 't', '/', 'claude-1', 1, 1)");
    old.close();
    // A separate process, since openStorage blocks this thread while it waits for the lock.
    const holder = Bun.spawn([process.execPath, "-e", HOLDER, path], { stdout: "pipe" });
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("holding");
    const storage = openStorage(path);
    await holder.exited;
    expect(storage.getSession("s1")).toMatchObject({ engine: "claude", engineSessionRef: "claude-1" });
  });
});
