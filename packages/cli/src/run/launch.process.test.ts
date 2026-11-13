import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The launch mistakes that end before any screen or turn starts, run through the real launcher: exit code 2, a message on stderr,
// nothing on stdout. The paths in MARCSH_* come from the test preload, so no real ~/.marcsh is read.

const bin = join(import.meta.dir, "..", "..", "bin", "marcsh");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-launch-proc-"));
  mkdirSync(join(dir, "home"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function marcsh(...args: string[]) {
  const run = Bun.spawnSync([process.execPath, "--no-env-file", "--config=/dev/null", bin, ...args], {
    cwd: dir,
    env: { ...process.env, HOME: join(dir, "home") },
    stdin: new Blob([""]),
    timeout: 20_000,
  });
  return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

describe("launch mistakes", () => {
  test("a directory that does not exist is exit 2", () => {
    const run = marcsh("nope");

    expect(run).toMatchObject({ code: 2, stdout: "" });
    expect(run.stderr).toContain('marcsh: "nope" is not a directory');
  });

  test("--session with an unknown id is exit 2", () => {
    const run = marcsh("--session", "nope");

    expect(run).toMatchObject({ code: 2, stdout: "" });
    expect(run.stderr).toContain('marcsh: no session with id "nope"');
  });

  test("run with no message is exit 2", () => {
    const run = marcsh("run");

    expect(run).toMatchObject({ code: 2, stdout: "" });
    expect(run.stderr).toContain("marcsh: no message");
  });

  test("run --session with an unknown id is exit 2", () => {
    const run = marcsh("run", "--session", "nope", "hello");

    expect(run).toMatchObject({ code: 2, stdout: "" });
    expect(run.stderr).toContain('marcsh: no session with id "nope"');
  });

  test("a bad option value prints the usage and exits 2, for the interface and for run", () => {
    for (const args of [["--engine", "gpt"], ["run", "--engine", "gpt", "hi"], ["run", "--format", "xml", "hi"]]) {
      const run = marcsh(...args);

      expect(run.code).toBe(2);
      expect(run.stderr).toContain("Usage: marcsh");
    }
  });

  test("--help lists the commands and flags", () => {
    const run = marcsh("--help");

    expect(run.code).toBe(0);
    for (const word of ["marcsh run", "[dir]", "--continue", "--session", "--engine", "--format", "--model", "--agent"]) {
      expect(run.stdout).toContain(word);
    }
  });
});
