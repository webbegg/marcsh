import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// From the tier 4 verification: every exit-2 mistake, not only the parser's, ends with the pointer to the help (S19).
const bin = join(import.meta.dir, "..", "..", "bin", "marcsh");
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-run-usage-"));
  mkdirSync(join(dir, "home"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function marcsh(...args: string[]) {
  const run = Bun.spawnSync([process.execPath, "--no-env-file", "--config=/dev/null", bin, ...args], {
    cwd: dir,
    env: { ...process.env, HOME: join(dir, "home"), MARCSH_DB_PATH: join(dir, "marcsh.db") },
    stdin: new Blob([""]),
    timeout: 20_000,
  });
  return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

test("run with no message is a usage error in the short form", () => {
  const run = marcsh("run");
  expect(run.code).toBe(2);
  expect(run.stdout).toBe("");
  expect(run.stderr).toBe("marcsh: no message: pass it as arguments or on standard input\nsee marcsh --help\n");
});

test("run with an unknown session is a usage error in the short form", () => {
  const run = marcsh("run", "-s", "nope", "hi");
  expect(run.code).toBe(2);
  expect(run.stderr).toBe('marcsh: no session with id "nope"\nsee marcsh --help\n');
});

test("launch mistakes (a folder that is not there, an unknown session) end with the pointer too", () => {
  const folder = marcsh("./not-here");
  expect(folder.code).toBe(2);
  expect(folder.stderr).toBe('marcsh: "./not-here" is not a directory\nsee marcsh --help\n');

  const session = marcsh("--session", "nope");
  expect(session.code).toBe(2);
  expect(session.stderr).toBe('marcsh: no session with id "nope"\nsee marcsh --help\n');
});
