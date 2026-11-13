import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Bun loads `.env` from the current directory on its own, so a project the user opens could set MARCSH_PACKS_DIR, MARCSH_AGENTS_DIR,
// MARCSH_PACK_URL_BASE and every other variable marcsh reads; it also reads that directory's bunfig.toml, whose `preload` runs
// the project's code before marcsh. The launcher must start Bun without either.

const bin = join(import.meta.dir, "..", "..", "bin", "marcsh");

/** The interpreter command the launcher's first line asks the OS for, e.g. ["bun", "--no-env-file"]. */
function interpreter() {
  const first = readFileSync(bin, "utf8").split("\n")[0]!;
  // `-S` is what lets env pass more than one argument on Linux.
  const match = /^#!\/usr\/bin\/env\s+-S\s+(.+)$/.exec(first);
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

  test("does not run a preload from the bunfig.toml of the directory it is started in", () => {
    writeFileSync(join(project, "bunfig.toml"), 'preload = ["./evil.ts"]\n');
    writeFileSync(join(project, "evil.ts"), 'console.log("PRELOAD RAN");\n');
    const probe = join(dir, "probe.ts");
    writeFileSync(probe, 'console.log("marcsh");\n');

    const [command, ...args] = interpreter();
    const run = Bun.spawnSync([command!, ...args, probe], { cwd: project });

    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString().trim()).toBe("marcsh");
  });

  describe("options", () => {
    const version = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")).version as string;

    // HOME is an empty temp dir (Bun itself may add ~/Library): an option that only prints must not start the app, which would create ~/.marcsh.
    function launch(...args: string[]) {
      const home = join(dir, "home");
      mkdirSync(home);
      const [command, ...flags] = interpreter();
      const run = Bun.spawnSync([command!, ...flags, bin, ...args], { cwd: project, env: { ...process.env, HOME: home }, timeout: 10_000 });
      return { run, stdout: run.stdout.toString(), stderr: run.stderr.toString(), home };
    }

    test("--version prints the package version and exits 0 without touching ~/.marcsh", () => {
      const { run, stdout, home } = launch("--version");

      expect(version).toMatch(/^\d+\.\d+\.\d+/);
      expect(run.exitCode).toBe(0);
      expect(stdout).toBe(`marcsh ${version}\n`);
      expect(readdirSync(home)).not.toContain(".marcsh");
    });

    test("--help prints the usage with --version and --help and exits 0", () => {
      const { run, stdout, home } = launch("--help");

      expect(run.exitCode).toBe(0);
      expect(stdout).toContain("Usage: marcsh");
      expect(stdout).toContain("--version");
      expect(stdout).toContain("--help");
      expect(readdirSync(home)).not.toContain(".marcsh");
    });

    test("an unknown option prints the error and the usage and exits 2", () => {
      const { run, stdout, stderr, home } = launch("--bogus");

      expect(run.exitCode).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toContain('marcsh: unknown option "--bogus"');
      expect(stderr).toContain("Usage: marcsh");
      expect(readdirSync(home)).not.toContain(".marcsh");
    });
  });
});
