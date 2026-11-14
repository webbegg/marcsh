import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorage, type Storage } from "../lib/storage";
import { latestSessionForCwd, planLaunch, resolveLaunchDir } from "./launch";

let dir: string;
let storage: Storage;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-launch-")));
  storage = openStorage(":memory:");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Sessions are stamped with the clock: the writes are spaced out so their order is never a tie.
function sessionIn(cwd: string, title: string) {
  const session = storage.createSession({ title, cwd });
  Bun.sleepSync(2);
  return session;
}

describe("latestSessionForCwd", () => {
  test("is the most recently updated session of that folder", () => {
    const a = sessionIn(dir, "a");
    const b = sessionIn(dir, "b");
    sessionIn(join(dir, "elsewhere"), "other folder");
    storage.saveMessages(a.id, []);

    expect(latestSessionForCwd(storage.listSessions(), dir)?.id).toBe(a.id);
    Bun.sleepSync(2);
    storage.saveMessages(b.id, []);
    expect(latestSessionForCwd(storage.listSessions(), dir)?.id).toBe(b.id);
  });

  test("is undefined when the folder has no session", () => {
    sessionIn(join(dir, "elsewhere"), "other");

    expect(latestSessionForCwd(storage.listSessions(), dir)).toBeUndefined();
  });

  test("a folder is the same through a symlink", () => {
    const real = join(dir, "real");
    mkdirSync(real);
    const link = join(dir, "link");
    symlinkSync(real, link);
    const made = sessionIn(real, "x");

    expect(latestSessionForCwd(storage.listSessions(), link)?.id).toBe(made.id);
  });
});

describe("resolveLaunchDir", () => {
  test("no directory keeps the current one", () => {
    expect(resolveLaunchDir(undefined, dir)).toEqual({ ok: true, dir });
  });

  test("a relative directory is resolved against the current one", () => {
    mkdirSync(join(dir, "proj"));

    expect(resolveLaunchDir("proj", dir)).toEqual({ ok: true, dir: join(dir, "proj") });
  });

  test("a missing path and a file are errors that name it", () => {
    writeFileSync(join(dir, "file.txt"), "x");

    expect(resolveLaunchDir("nope", dir)).toEqual({ ok: false, message: '"nope" is not a directory' });
    expect(resolveLaunchDir("file.txt", dir)).toEqual({ ok: false, message: '"file.txt" is not a directory' });
  });
});

describe("planLaunch", () => {
  test("a plain launch opens the home screen", () => {
    expect(planLaunch({ continue: false }, storage, dir)).toEqual({ ok: true, initialEntries: ["/"], initialIndex: 0 });
  });

  test("--continue opens the latest session of the folder, with home behind it", () => {
    sessionIn(dir, "old");
    const latest = sessionIn(dir, "new");

    expect(planLaunch({ continue: true }, storage, dir)).toEqual({
      ok: true,
      initialEntries: ["/", `/sessions/${latest.id}`],
      initialIndex: 1,
    });
  });

  test("--continue with no session in the folder opens the home screen", () => {
    expect(planLaunch({ continue: true }, storage, dir)).toEqual({ ok: true, initialEntries: ["/"], initialIndex: 0 });
  });

  test("--session opens that session, wherever it was started", () => {
    const other = sessionIn(join(dir, "elsewhere"), "x");

    expect(planLaunch({ continue: false, session: other.id }, storage, dir)).toEqual({
      ok: true,
      initialEntries: ["/", `/sessions/${other.id}`],
      initialIndex: 1,
    });
  });

  test("--session with an unknown id is an error that names it", () => {
    expect(planLaunch({ continue: false, session: "nope" }, storage, dir)).toEqual({ ok: false, message: 'no session with id "nope"' });
  });
});
