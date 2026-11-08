import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorage } from "./storage";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDb = () => {
  const dir = mkdtempSync(join(tmpdir(), "marcsh-rules-"));
  dirs.push(dir);
  return join(dir, "marcsh.db");
};

describe("permission rules", () => {
  test("a stored bash rule matches the same cwd, tool and command only", () => {
    const storage = openStorage(":memory:");
    expect(storage.hasPermissionRule({ cwd: "/work", toolName: "bash", command: "ls" })).toBe(false);

    storage.addPermissionRule({ cwd: "/work", toolName: "bash", command: "ls" });

    expect(storage.hasPermissionRule({ cwd: "/work", toolName: "bash", command: "ls" })).toBe(true);
    expect(storage.hasPermissionRule({ cwd: "/work", toolName: "bash", command: "ls -la" })).toBe(false);
    expect(storage.hasPermissionRule({ cwd: "/work", toolName: "bash" })).toBe(false);
    expect(storage.hasPermissionRule({ cwd: "/work", toolName: "edit", command: "ls" })).toBe(false);
  });

  test("a tool rule matches that tool in that cwd", () => {
    const storage = openStorage(":memory:");

    storage.addPermissionRule({ cwd: "/work", toolName: "edit" });

    expect(storage.hasPermissionRule({ cwd: "/work", toolName: "edit" })).toBe(true);
    expect(storage.hasPermissionRule({ cwd: "/work", toolName: "write" })).toBe(false);
  });

  test("a rule does not apply in another cwd", () => {
    const storage = openStorage(":memory:");

    storage.addPermissionRule({ cwd: "/work", toolName: "bash", command: "ls" });
    storage.addPermissionRule({ cwd: "/work", toolName: "edit" });

    expect(storage.hasPermissionRule({ cwd: "/other", toolName: "bash", command: "ls" })).toBe(false);
    expect(storage.hasPermissionRule({ cwd: "/other", toolName: "edit" })).toBe(false);
  });

  test("adding the same rule twice is harmless", () => {
    const storage = openStorage(":memory:");

    storage.addPermissionRule({ cwd: "/work", toolName: "edit" });
    storage.addPermissionRule({ cwd: "/work", toolName: "edit" });

    expect(storage.hasPermissionRule({ cwd: "/work", toolName: "edit" })).toBe(true);
  });

  test("reopening the file keeps the rules", () => {
    const path = tempDb();
    const first = openStorage(path);
    first.addPermissionRule({ cwd: "/work", toolName: "bash", command: "make test" });

    const second = openStorage(path);

    expect(second.hasPermissionRule({ cwd: "/work", toolName: "bash", command: "make test" })).toBe(true);
  });

  test("a database from before the rules gains the table and keeps its sessions", () => {
    const path = tempDb();
    const old = new Database(path, { create: true, strict: true });
    old.run(`
      CREATE TABLE sessions (
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
    old.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    old.run("INSERT INTO sessions (id, title, cwd, created_at, updated_at) VALUES ('old', 'Old chat', '/work', 1, 2)");
    old.close();

    const storage = openStorage(path);
    storage.addPermissionRule({ cwd: "/work", toolName: "edit" });

    expect(storage.hasPermissionRule({ cwd: "/work", toolName: "edit" })).toBe(true);
    expect(storage.getSession("old")?.title).toBe("Old chat");
  });
});
