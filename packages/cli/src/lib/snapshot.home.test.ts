import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSnapshotStore, type SnapshotStore } from "./snapshot";

// S4: a project folder that contains marcsh's own data (marcsh started in the home folder) must not snapshot or restore it.
let home: string;
let root: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-snapshot-home-")));
  root = join(home, ".marcsh", "snapshots");
  writeFileSync(join(home, "notes.txt"), "n0");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const open = (): SnapshotStore => {
  const created = createSnapshotStore({ cwd: home, root });
  if (!created.available) throw new Error(created.reason);
  return created.store;
};

test("the shadow repo inside the project is never part of a snapshot", async () => {
  const store = open();
  const first = await store.track();
  const second = await store.track();

  expect(second).toBe(first);
  expect(await store.changedFiles(first)).toEqual([]);
}, 60_000);

test("a turn's changed files are only the project's, not marcsh's own data, and undo restores them", async () => {
  const store = open();
  const before = await store.track();
  writeFileSync(join(home, "notes.txt"), "n1");
  mkdirSync(join(home, ".marcsh"), { recursive: true });
  writeFileSync(join(home, ".marcsh", "marcsh.db"), "saved turn");
  const after = await store.track();

  const files = await store.changedFiles(before, after);
  expect(files.filter((file) => file.startsWith(".marcsh/"))).toEqual([]);
  expect(files).toContain("notes.txt");
  await store.restore(before, files);
  expect(await store.changedFiles(before)).toEqual([]);
}, 60_000);
