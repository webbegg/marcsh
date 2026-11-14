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
  const dir = mkdtempSync(join(tmpdir(), "marcsh-path-rules-"));
  dirs.push(dir);
  return join(dir, "marcsh.db");
};

describe("path rules", () => {
  test("a project has none until one is added", () => {
    expect(openStorage(":memory:").pathRulesFor("/work")).toEqual([]);
  });

  test("a stored rule comes back for its project", () => {
    const storage = openStorage(":memory:");

    storage.addPathRule({ cwd: "/work", program: "rm", dir: "/tmp/x" });

    expect(storage.pathRulesFor("/work")).toEqual([{ cwd: "/work", program: "rm", dir: "/tmp/x" }]);
  });

  test("a project sees only its own rules", () => {
    const storage = openStorage(":memory:");

    storage.addPathRule({ cwd: "/work", program: "rm", dir: "/tmp/x" });
    storage.addPathRule({ cwd: "/other", program: "mv", dir: "/tmp/y" });

    expect(storage.pathRulesFor("/work")).toEqual([{ cwd: "/work", program: "rm", dir: "/tmp/x" }]);
    expect(storage.pathRulesFor("/other")).toEqual([{ cwd: "/other", program: "mv", dir: "/tmp/y" }]);
    expect(storage.pathRulesFor("/elsewhere")).toEqual([]);
  });

  test("the same program under two folders, and two programs under one, are separate rules", () => {
    const storage = openStorage(":memory:");

    storage.addPathRule({ cwd: "/work", program: "rm", dir: "/tmp/x" });
    storage.addPathRule({ cwd: "/work", program: "rm", dir: "/tmp/y" });
    storage.addPathRule({ cwd: "/work", program: "mv", dir: "/tmp/x" });

    expect(storage.pathRulesFor("/work")).toHaveLength(3);
  });

  test("adding the same rule twice is harmless", () => {
    const storage = openStorage(":memory:");

    storage.addPathRule({ cwd: "/work", program: "rm", dir: "/tmp/x" });
    storage.addPathRule({ cwd: "/work", program: "rm", dir: "/tmp/x" });

    expect(storage.pathRulesFor("/work")).toHaveLength(1);
  });

  test("path rules and permission rules do not mix", () => {
    const storage = openStorage(":memory:");

    storage.addPathRule({ cwd: "/work", program: "rm", dir: "/tmp/x" });
    storage.addPermissionRule({ cwd: "/work", toolName: "bash", command: "rm -rf /tmp/x/a" });

    expect(storage.pathRulesFor("/work")).toHaveLength(1);
    expect(storage.hasPermissionRule({ cwd: "/work", toolName: "bash", command: "rm -rf /tmp/x/b" })).toBe(false);
  });

  test("reopening the file keeps the rules", () => {
    const path = tempDb();
    openStorage(path).addPathRule({ cwd: "/work", program: "rm", dir: "/tmp/x" });

    expect(openStorage(path).pathRulesFor("/work")).toEqual([{ cwd: "/work", program: "rm", dir: "/tmp/x" }]);
  });

  test("a database from before path rules gains the table and keeps its sessions and permission rules", () => {
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
    old.run(`
      CREATE TABLE permission_rules (
        cwd TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        command TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (cwd, tool_name, command)
      )
    `);
    old.run("INSERT INTO sessions (id, title, cwd, created_at, updated_at) VALUES ('old', 'Old chat', '/work', 1, 2)");
    old.run("INSERT INTO permission_rules (cwd, tool_name, command, created_at) VALUES ('/work', 'bash', 'ls', 1)");
    old.close();

    const storage = openStorage(path);
    storage.addPathRule({ cwd: "/work", program: "rm", dir: "/tmp/x" });

    expect(storage.pathRulesFor("/work")).toHaveLength(1);
    expect(storage.getSession("old")?.title).toBe("Old chat");
    expect(storage.hasPermissionRule({ cwd: "/work", toolName: "bash", command: "ls" })).toBe(true);
  });
});
