// S8 storage invariants: permission rules are additive and never touch session rows.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorage } from "./storage";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sessionRows = (path: string) => {
  const db = new Database(path, { readonly: true });
  const rows = JSON.stringify(db.query("SELECT * FROM sessions ORDER BY id").all());
  db.close();
  return rows;
};

test("opening an existing database and storing rules leaves every session row byte-identical", () => {
  const dir = mkdtempSync(join(tmpdir(), "marcsh-rules-inv-"));
  dirs.push(dir);
  const path = join(dir, "marcsh.db");
  const first = openStorage(path);
  const claude = first.createSession({ title: "claude chat", cwd: "/work" });
  first.saveMessages(claude.id, [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }], "claude-ref");
  const pi = first.createSession({ title: "pi chat", cwd: "/work", engine: "pi" });
  first.saveMessages(pi.id, [], "/sessions/pi.jsonl");
  const before = sessionRows(path);

  const second = openStorage(path);
  second.addPermissionRule({ cwd: "/work", toolName: "bash", command: "ls" });
  second.addPermissionRule({ cwd: "/work", toolName: "bash", command: "ls" });
  second.addPermissionRule({ cwd: "/work", toolName: "edit" });

  expect(sessionRows(path)).toBe(before);
  expect(second.getSession(claude.id)?.engineSessionRef).toBe("claude-ref");
  expect(second.hasPermissionRule({ cwd: "/work", toolName: "bash", command: "ls " })).toBe(false);
  expect(second.hasPermissionRule({ cwd: "/work/", toolName: "edit" })).toBe(false);
});
