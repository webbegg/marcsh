// From the tier 4 recheck: a string element in one session's messages must not break `session list`, `--json` or `stats` for the others.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorage } from "../lib/storage";

const bin = join(import.meta.dir, "..", "..", "bin", "marcsh");
let dir: string;
let db: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-list-elements-proc-"));
  mkdirSync(join(dir, "home"));
  db = join(dir, "marcsh.db");
  const storage = openStorage(db);
  const odd = storage.createSession({ title: "Odd", cwd: dir, engine: "claude" });
  const kept = storage.createSession({ title: "Kept", cwd: dir, engine: "pi" });
  storage.saveMessages(kept.id, [
    { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }], metadata: { model: "openai/gpt-5" } },
  ] as never);
  const raw = new Database(db);
  raw.query("UPDATE sessions SET messages = $m WHERE id = $id").run({
    $m: '[{"id":"m","role":"user","parts":[]},"oops"]',
    $id: odd.id,
  });
  raw.close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const marcsh = (...args: string[]) => {
  const run = Bun.spawnSync([process.execPath, "--no-env-file", "--config=/dev/null", bin, ...args], {
    cwd: dir,
    env: { ...process.env, HOME: join(dir, "home"), MARCSH_DB_PATH: db },
    stdin: new Blob([""]),
    timeout: 20_000,
  });
  return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
};

test("session list, --json and stats still work", () => {
  const list = marcsh("session", "list");
  expect(list.code).toBe(0);
  expect(list.stdout).toContain("claude/—  2 msgs");
  expect(list.stdout).toContain("pi/openai/gpt-5  1 msg");
  const json = marcsh("session", "list", "--json");
  expect(json.code).toBe(0);
  expect(JSON.parse(json.stdout).map((s: { messageCount: number }) => s.messageCount).sort()).toEqual([1, 2]);
  expect(marcsh("stats").code).toBe(0);
});
