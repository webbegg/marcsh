import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorage } from "./storage";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-trust-")));
  dirs.push(dir);
  return dir;
};

describe("project trust (S18)", () => {
  test("a project nobody decided about has no decision", () => {
    const storage = openStorage(":memory:");

    expect(storage.getProjectTrust("/work")).toBeNull();
  });

  test("a stored decision reads back as trusted or untrusted", () => {
    const storage = openStorage(":memory:");

    storage.setProjectTrust("/work/a", "trusted");
    storage.setProjectTrust("/work/b", "untrusted");

    expect(storage.getProjectTrust("/work/a")).toBe("trusted");
    expect(storage.getProjectTrust("/work/b")).toBe("untrusted");
  });

  test("a new decision replaces the old one for that project only", () => {
    const storage = openStorage(":memory:");
    storage.setProjectTrust("/work/a", "trusted");
    storage.setProjectTrust("/work/b", "trusted");

    storage.setProjectTrust("/work/a", "untrusted");

    expect(storage.getProjectTrust("/work/a")).toBe("untrusted");
    expect(storage.getProjectTrust("/work/b")).toBe("trusted");
  });

  test("forgetting a decision (null) makes the project undecided again", () => {
    const storage = openStorage(":memory:");
    storage.setProjectTrust("/work/a", "trusted");

    storage.setProjectTrust("/work/a", null);

    expect(storage.getProjectTrust("/work/a")).toBeNull();
  });

  test("a decision covers the project's folder only, not its parent or subfolders", () => {
    const storage = openStorage(":memory:");
    storage.setProjectTrust("/work/app", "trusted");

    expect(storage.getProjectTrust("/work")).toBeNull();
    expect(storage.getProjectTrust("/work/app/packages/x")).toBeNull();
  });

  test("the decision is kept per resolved real path: a symlink and its target share it, a trailing slash or dot segment changes nothing", () => {
    const root = tempDir();
    const real = join(root, "real");
    mkdirSync(real);
    symlinkSync(real, join(root, "link"));
    const storage = openStorage(":memory:");

    storage.setProjectTrust(join(root, "link"), "trusted");

    expect(storage.getProjectTrust(real)).toBe("trusted");
    expect(storage.getProjectTrust(`${real}/`)).toBe("trusted");
    expect(storage.getProjectTrust(join(real, "..", "real"))).toBe("trusted");
    expect(storage.getProjectTrust(root)).toBeNull();
  });

  test("a project folder that does not exist yet is keyed by its absolute path", () => {
    const root = tempDir();
    const storage = openStorage(":memory:");

    storage.setProjectTrust(join(root, "later"), "untrusted");

    expect(storage.getProjectTrust(join(root, "later"))).toBe("untrusted");
  });

  test("decisions survive reopening the database file", () => {
    const path = join(tempDir(), "marcsh.db");
    openStorage(path).setProjectTrust("/work/a", "trusted");

    expect(openStorage(path).getProjectTrust("/work/a")).toBe("trusted");
  });

  test("a database from before project trust gains the table and keeps its sessions and rules", () => {
    const path = join(tempDir(), "marcsh.db");
    const old = new Database(path, { create: true });
    old.run(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, cwd TEXT NOT NULL, claude_session_id TEXT,
      messages TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    old.run("INSERT INTO sessions (id, title, cwd, claude_session_id, messages, created_at, updated_at) VALUES ('old', 'Old chat', '/work', 'claude-old', '[]', 1, 2)");
    old.run(`CREATE TABLE permission_rules (
      cwd TEXT NOT NULL, tool_name TEXT NOT NULL, command TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
      PRIMARY KEY (cwd, tool_name, command)
    )`);
    old.run("INSERT INTO permission_rules (cwd, tool_name, command, created_at) VALUES ('/work', 'edit', '', 1)");
    old.close();

    const storage = openStorage(path);

    expect(storage.getProjectTrust("/work")).toBeNull();
    storage.setProjectTrust("/work", "trusted");
    expect(storage.getProjectTrust("/work")).toBe("trusted");
    expect(storage.getSession("old")?.engineSessionRef).toBe("claude-old");
    expect(storage.hasPermissionRule({ cwd: "/work", toolName: "edit" })).toBe(true);
  });

  test("opening an existing database again keeps the table and its rows (the creation is idempotent)", () => {
    const path = join(tempDir(), "marcsh.db");
    openStorage(path).setProjectTrust("/work/a", "untrusted");

    const again = openStorage(path);
    again.setProjectTrust("/work/b", "trusted");

    expect(again.getProjectTrust("/work/a")).toBe("untrusted");
    expect(again.getProjectTrust("/work/b")).toBe("trusted");
  });
});

const REVIEW = [
  { path: ".pi/extensions/foo.ts", shown: "a".repeat(64), content: "b".repeat(64) },
  { path: ".pi/mcp.json", shown: "c".repeat(64), content: "d".repeat(64) },
];

const columns = (path: string) => {
  const db = new Database(path);
  const names = db.query<{ name: string }, []>("PRAGMA table_info(project_trust)").all().map((c) => c.name);
  db.close();
  return names;
};

describe("the review kept with a trusted project (S1)", () => {
  test("a trusted project reads back the review it was trusted with", () => {
    const storage = openStorage(":memory:");

    storage.setProjectTrust("/work/a", "trusted", REVIEW);

    expect(storage.getProjectTrust("/work/a")).toBe("trusted");
    expect(storage.getProjectReview("/work/a")).toEqual(REVIEW);
  });

  test("a project without a decision, or trusted without a review, has no review", () => {
    const storage = openStorage(":memory:");
    storage.setProjectTrust("/work/a", "trusted");

    expect(storage.getProjectReview("/work/a")).toBeNull();
    expect(storage.getProjectReview("/work/none")).toBeNull();
  });

  test("untrusting or forgetting drops the review; trusting again replaces it", () => {
    const storage = openStorage(":memory:");
    storage.setProjectTrust("/work/a", "trusted", REVIEW);
    storage.setProjectTrust("/work/a", "untrusted", REVIEW);
    expect(storage.getProjectReview("/work/a")).toBeNull();

    storage.setProjectTrust("/work/a", "trusted", REVIEW);
    storage.setProjectTrust("/work/a", "trusted", REVIEW.slice(0, 1));
    expect(storage.getProjectReview("/work/a")).toEqual(REVIEW.slice(0, 1));

    storage.setProjectTrust("/work/a", null);
    expect(storage.getProjectReview("/work/a")).toBeNull();
  });

  test("the review is kept per project", () => {
    const storage = openStorage(":memory:");
    storage.setProjectTrust("/work/a", "trusted", REVIEW);
    storage.setProjectTrust("/work/b", "trusted", REVIEW.slice(1));

    expect(storage.getProjectReview("/work/a")).toEqual(REVIEW);
    expect(storage.getProjectReview("/work/b")).toEqual(REVIEW.slice(1));
  });

  test("only paths and hashes reach the database", () => {
    const path = join(tempDir(), "marcsh.db");
    openStorage(path).setProjectTrust("/work/a", "trusted", [{ path: ".pi/mcp.json", shown: "s", content: "c", secret: "TOKEN=abc" } as never]);

    const db = new Database(path);
    const row = db.query<{ reviewed: string }, []>("SELECT reviewed FROM project_trust").get()!;
    db.close();

    expect(JSON.parse(row.reviewed)).toEqual([{ path: ".pi/mcp.json", shown: "s", content: "c" }]);
  });

  test("a review that was damaged on disk reads as no review", () => {
    const path = join(tempDir(), "marcsh.db");
    openStorage(path).setProjectTrust("/work/a", "trusted", REVIEW);
    const db = new Database(path);
    db.run("UPDATE project_trust SET reviewed = '{not json'");
    db.close();
    const storage = openStorage(path);
    expect(storage.getProjectReview("/work/a")).toBeNull();

    const damaged = new Database(path);
    damaged.run("UPDATE project_trust SET reviewed = '[{\"path\":1}]'");
    damaged.close();
    expect(openStorage(path).getProjectReview("/work/a")).toBeNull();
  });

  test("a database from before reviews gains the column, and its trusted row has no review", () => {
    const path = join(tempDir(), "marcsh.db");
    const old = new Database(path, { create: true });
    old.run(`CREATE TABLE project_trust (
      path TEXT PRIMARY KEY,
      decision TEXT NOT NULL CHECK (decision IN ('trusted', 'untrusted')),
      decided_at INTEGER NOT NULL
    )`);
    old.run("INSERT INTO project_trust (path, decision, decided_at) VALUES ('/work/old', 'trusted', 1)");
    old.close();
    expect(columns(path)).not.toContain("reviewed");

    const storage = openStorage(path);

    expect(columns(path)).toContain("reviewed");
    expect(storage.getProjectTrust("/work/old")).toBe("trusted");
    expect(storage.getProjectReview("/work/old")).toBeNull();
    storage.setProjectTrust("/work/old", "trusted", REVIEW);
    expect(openStorage(path).getProjectReview("/work/old")).toEqual(REVIEW);
  });

  test("opening a database that already has the column again changes nothing", () => {
    const path = join(tempDir(), "marcsh.db");
    openStorage(path).setProjectTrust("/work/a", "trusted", REVIEW);

    expect(openStorage(path).getProjectReview("/work/a")).toEqual(REVIEW);
    expect(columns(path).filter((name) => name === "reviewed")).toHaveLength(1);
  });
});
