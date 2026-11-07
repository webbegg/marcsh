import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mode = (path: string) => statSync(path).mode & 0o777;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("storage permissions (S8a)", () => {
  test("forces an existing default ~/.marcsh to 0700 and the db to 0600", () => {
    const home = mkdtempSync(join(tmpdir(), "marcsh-home-"));
    dirs.push(home);
    mkdirSync(join(home, ".marcsh"), { mode: 0o755 });
    chmodSync(join(home, ".marcsh"), 0o755);

    // homedir() is read once per process, so the default path is opened in a child with its own HOME.
    const script = `const { openStorage } = await import(${JSON.stringify(join(import.meta.dir, "storage.ts"))}); openStorage().createSession({ title: "Private", cwd: "/work" });`;
    const { MARCSH_DB_PATH: _ignored, ...rest } = process.env;
    const child = Bun.spawnSync([process.execPath, "-e", script], { env: { ...rest, HOME: home } });

    expect(child.exitCode).toBe(0);
    expect(mode(join(home, ".marcsh"))).toBe(0o700);
    expect(mode(join(home, ".marcsh", "marcsh.db"))).toBe(0o600);
  });
});
