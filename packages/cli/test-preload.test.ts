import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";

// The preload (test-preload.ts) must give every test process temp paths, wherever `bun test` is started from and
// whatever the shell exports: the real ~/.marcsh holds the user's pi login, their sessions and their settings.

const VARIABLES = ["MARCSH_AGENT_DIR", "MARCSH_DB_PATH", "MARCSH_PREFERENCES_PATH"] as const;
// Set in the child runs below, which only check the variables (they must not start more children).
const CHILD = "MARCSH_PRELOAD_CHILD";
const cliDir = import.meta.dir;
const repoRoot = dirname(dirname(cliDir));
const realMarcsh = join(userInfo().homedir, ".marcsh");

const inside = (path: string, dir: string) => {
  const from = relative(dir, path);
  return from !== "" && !from.startsWith("..") && !isAbsolute(from);
};
const resolved = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

describe("the test preload", () => {
  test("points the agent dir, the database and the preferences at temp paths, never at the real ~/.marcsh", () => {
    const temp = [tmpdir(), resolved(tmpdir())];
    for (const name of VARIABLES) {
      const value = process.env[name];
      expect(value, `${name} is set`).toBeTruthy();
      expect(temp.some((dir) => inside(value!, dir)), `${name}=${value} is under ${tmpdir()}`).toBe(true);
      expect(inside(value!, realMarcsh) || value === realMarcsh, `${name}=${value} is under the real ${realMarcsh}`).toBe(false);
    }
    expect(new Set(VARIABLES.map((name) => process.env[name])).size).toBe(VARIABLES.length);
  });

  // The runs below start `bun test` on this same file from another folder with the real paths exported, as a shell could have them.
  const exported = {
    ...process.env,
    [CHILD]: "1",
    MARCSH_AGENT_DIR: join(realMarcsh, "agent"),
    MARCSH_DB_PATH: join(realMarcsh, "marcsh.db"),
    MARCSH_PREFERENCES_PATH: join(realMarcsh, "preferences.json"),
  };
  const runFrom = (cwd: string, file: string) => {
    const result = Bun.spawnSync([process.execPath, "test", file], { cwd, env: exported, timeout: 60_000 });
    return { exitCode: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}` };
  };

  test.skipIf(!!process.env[CHILD])("`bun test` from the repo root uses temp paths even when the real ones are exported", () => {
    const { exitCode, output } = runFrom(repoRoot, "packages/cli/test-preload.test.ts");
    expect(output).toContain("1 pass");
    expect(exitCode).toBe(0);
  });

  test.skipIf(!!process.env[CHILD])("`bun test` from packages/cli uses temp paths even when the real ones are exported", () => {
    const { exitCode, output } = runFrom(cliDir, "test-preload.test.ts");
    expect(output).toContain("1 pass");
    expect(exitCode).toBe(0);
  });
});
