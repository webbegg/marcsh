import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Bun loads `.env` from the current directory on its own, so a project the user opens could set MARCSH_PACKS_DIR, MARCSH_AGENTS_DIR,
// MARCSH_PACK_URL_BASE and every other variable marcsh reads. The launcher must start Bun without that.

const bin = join(import.meta.dir, "..", "..", "bin", "marcsh");

/** The interpreter command the launcher's first line asks the OS for, e.g. ["bun", "--no-env-file"]. */
function interpreter() {
  const first = readFileSync(bin, "utf8").split("\n")[0]!;
  const match = /^#!\/usr\/bin\/env(?:\s+-S)?\s+(.+)$/.exec(first);
  expect(match).not.toBeNull();
  const argv = match![1]!.trim().split(/\s+/);
  // The shebang finds `bun` on PATH; the test runs under the same Bun.
  return argv[0] === "bun" ? [process.execPath, ...argv.slice(1)] : argv;
}

describe("bin/marcsh", () => {
  let dir: string;
  let project: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marcsh-bin-"));
    project = join(dir, "project");
    mkdirSync(project);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("does not read the .env of the directory it is started in", () => {
    writeFileSync(join(project, ".env"), "MARCSH_PACKS_DIR=/tmp/evil\n");
    const probe = join(dir, "probe.ts");
    writeFileSync(probe, 'console.log(process.env.MARCSH_PACKS_DIR ?? "unset");\n');
    const env = { ...process.env };
    delete env.MARCSH_PACKS_DIR;

    const [command, ...args] = interpreter();
    const run = Bun.spawnSync([command!, ...args, probe], { cwd: project, env });

    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString().trim()).toBe("unset");
  });
});
