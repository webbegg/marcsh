import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync } from "node:fs";
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

  test("a db path directly in the home dir leaves the home dir's mode alone", () => {
    const home = mkdtempSync(join(tmpdir(), "marcsh-home-"));
    dirs.push(home);
    chmodSync(home, 0o755);

    const script = `const { openStorage } = await import(${JSON.stringify(join(import.meta.dir, "storage.ts"))}); openStorage().createSession({ title: "Private", cwd: "/work" });`;
    const { MARCSH_DB_PATH: _ignored, ...rest } = process.env;
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      env: { ...rest, HOME: home, MARCSH_DB_PATH: join(home, "x.db") },
    });

    expect(child.exitCode).toBe(0);
    expect(mode(home)).toBe(0o755);
    expect(mode(join(home, "x.db"))).toBe(0o600);
  });

  test("a db path in /tmp (not owned by the user) opens and saves", async () => {
    const path = `/tmp/marcsh-test-${process.pid}-${Date.now()}.db`;
    try {
      const { openStorage } = await import("./storage");
      const created = openStorage(path).createSession({ title: "Tmp", cwd: "/work" });
      expect(openStorage(path).getSession(created.id)?.title).toBe("Tmp");
      expect(mode(path)).toBe(0o600);
    } finally {
      for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) unlinkSync(f);
    }
  });
});
