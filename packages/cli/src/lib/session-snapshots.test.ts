import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, TurnSnapshot } from "./chat-types";
import {
  applyStep,
  baselineTree,
  describeStep,
  dropRedo,
  noStepReason,
  openSnapshots,
  parseUnifiedDiff,
  planStep,
  snapshotRoot,
  trackWithin,
  withSnapshot,
} from "./session-snapshots";
import { createSnapshotStore, type SnapshotStore } from "./snapshot";

let base: string;
let project: string;
let store: SnapshotStore;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "marcsh-session-snapshots-"));
  project = join(base, "project");
  mkdirSync(project);
  const created = createSnapshotStore({ cwd: project, root: join(base, "snapshots") });
  if (!created.available) throw new Error(created.reason);
  store = created.store;
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const file = (name: string) => join(project, name);
const reply = (id: string, snapshot?: TurnSnapshot): ChatMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text: id }],
  metadata: snapshot ? { snapshot } : {},
});

/** One "turn" against the real store: `change` edits the project, and the reply carries the snapshot around it. */
async function turn(id: string, change: () => void): Promise<ChatMessage> {
  const before = await store.track();
  change();
  const after = await store.track();
  return reply(id, { before, after });
}

/** Runs `body` with these variables set (undefined: unset), then puts them back. */
function withEnv(env: Record<string, string | undefined>, body: () => void) {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    apply(env);
    body();
  } finally {
    apply(saved);
  }
}

describe("where snapshots go", () => {
  test("MARCSH_SNAPSHOTS_DIR, else ~/.marcsh/snapshots", () => {
    withEnv({ MARCSH_SNAPSHOTS_DIR: "/tmp/own-snapshots" }, () => expect(snapshotRoot()).toBe("/tmp/own-snapshots"));
    withEnv({ MARCSH_SNAPSHOTS_DIR: undefined }, () => expect(snapshotRoot()).toMatch(/\.marcsh\/snapshots$/));
  });

  test("tests start with snapshots off and a temp folder (test-preload), so no test reaches the real home or snapshots its working folder by accident", () => {
    expect(process.env.MARCSH_SNAPSHOTS).toBe("off");
    expect(snapshotRoot().startsWith(tmpdir())).toBe(true);
    expect(openSnapshots(project).available).toBe(false);
    withEnv({ MARCSH_SNAPSHOTS_DIR: join(base, "named"), MARCSH_SNAPSHOTS: undefined }, () => {
      expect(openSnapshots(project).available).toBe(true);
    });
  });

  test("MARCSH_SNAPSHOTS=off turns them off, whatever else is set", () => {
    withEnv({ NODE_ENV: undefined, MARCSH_SNAPSHOTS_DIR: join(base, "named"), MARCSH_SNAPSHOTS: "off" }, () => {
      const result = openSnapshots(project);
      expect(result).toEqual({ available: false, reason: "turned off by MARCSH_SNAPSHOTS=off" });
    });
  });
});

describe("trackWithin", () => {
  const fake = (track: () => Promise<string>) => ({ track }) as unknown as SnapshotStore;

  test("returns the tree", async () => {
    expect(await trackWithin(fake(async () => "abc"), 1000)).toEqual({ tree: "abc" });
  });

  test("a failure becomes a reason and never throws", async () => {
    const result = await trackWithin(fake(async () => Promise.reject(new Error("disk full"))), 1000);
    expect(result).toEqual({ reason: "disk full" });
  });

  test("a snapshot that takes too long becomes a reason, marked as a timeout", async () => {
    const result = await trackWithin(fake(() => new Promise(() => {})), 20);
    expect("reason" in result && result.reason).toContain("took longer than");
    expect("reason" in result && result.timedOut).toBe(true);
  });

  test("a failure is not a timeout", async () => {
    const result = await trackWithin(fake(async () => Promise.reject(new Error("x"))), 1000);
    expect("reason" in result && result.timedOut).toBeUndefined();
  });
});

describe("message helpers", () => {
  test("withSnapshot sets the snapshot on that reply only", () => {
    const messages = [reply("a"), reply("b")];
    const next = withSnapshot(messages, "b", { before: "1", after: "2" });
    expect(next[0]).toBe(messages[0]!);
    expect(next[1]!.metadata?.snapshot).toEqual({ before: "1", after: "2" });
  });

  test("dropRedo marks undone replies abandoned and returns the same array when there are none", () => {
    const messages = [reply("a", { before: "1", after: "2" }), reply("b", { before: "2", after: "3", undone: true })];
    expect(dropRedo(messages[0] ? [messages[0]] : [])).toEqual([messages[0]!]);
    const same = [messages[0]!];
    expect(dropRedo(same)).toBe(same);
    expect(dropRedo(messages)[1]!.metadata?.snapshot).toEqual({ before: "2", after: "3", undone: true, abandoned: true });
  });

  test("baselineTree is the oldest snapshot's before, whatever its state", () => {
    const messages = [reply("x"), reply("a", { before: "1", after: "2", undone: true, abandoned: true }), reply("b", { before: "2", after: "3" })];
    expect(baselineTree(messages)).toBe("1");
    expect(baselineTree([reply("x")])).toBeUndefined();
  });
});

describe("undo and redo against a real project", () => {
  test("undo restores what the turn changed, redo puts it back, and only those files are written", async () => {
    writeFileSync(file("keep.txt"), "keep");
    writeFileSync(file("edit.txt"), "v1");
    const first = await turn("r1", () => {
      writeFileSync(file("edit.txt"), "v2");
      writeFileSync(file("new.txt"), "new");
    });
    let messages = [first];

    const planned = await planStep(store, messages, "undo");
    if (planned.kind !== "ready") throw new Error("expected a plan");
    expect(planned.files.sort()).toEqual(["edit.txt", "new.txt"]);
    expect(planned.modified).toEqual([]);

    const undone = await applyStep(store, messages, planned);
    messages = undone.messages;
    expect(readFileSync(file("edit.txt"), "utf8")).toBe("v1");
    expect(existsSync(file("new.txt"))).toBe(false);
    expect(undone.written).toEqual(["edit.txt"]);
    expect(undone.deleted).toEqual(["new.txt"]);
    expect(messages[0]!.metadata?.snapshot?.undone).toBe(true);
    expect(describeStep("undo", undone, planned)).toContain("restored edit.txt");
    expect(describeStep("undo", undone, planned)).toContain("deleted new.txt");

    // Nothing left to undo, and a redo is available.
    const again = await planStep(store, messages, "undo");
    expect(again.kind).toBe("none");

    const redoPlan = await planStep(store, messages, "redo");
    if (redoPlan.kind !== "ready") throw new Error("expected a redo plan");
    const redone = await applyStep(store, messages, redoPlan);
    expect(readFileSync(file("edit.txt"), "utf8")).toBe("v2");
    expect(readFileSync(file("new.txt"), "utf8")).toBe("new");
    expect(readFileSync(file("keep.txt"), "utf8")).toBe("keep");
    expect(redone.messages[0]!.metadata?.snapshot?.undone).toBeUndefined();
  });

  test("a file the user changed after the turn is listed before it would be overwritten", async () => {
    writeFileSync(file("mine.txt"), "base");
    const first = await turn("r2", () => writeFileSync(file("mine.txt"), "turn"));
    writeFileSync(file("mine.txt"), "edited by hand");

    const planned = await planStep(store, [first], "undo");
    if (planned.kind !== "ready") throw new Error("expected a plan");
    expect(planned.modified).toEqual(["mine.txt"]);
    // planning writes nothing
    expect(readFileSync(file("mine.txt"), "utf8")).toBe("edited by hand");
  });

  test("a turn that changed no files is skipped and the previous turn is undone", async () => {
    writeFileSync(file("skip.txt"), "s1");
    const older = await turn("r3", () => writeFileSync(file("skip.txt"), "s2"));
    const newest = await turn("r4", () => {});

    const planned = await planStep(store, [older, newest], "undo");
    if (planned.kind !== "ready") throw new Error("expected a plan");
    expect(planned.messageId).toBe("r3");
    expect(planned.skipped).toBe(1);
    expect(describeStep("undo", { written: ["skip.txt"], deleted: [] }, planned)).toContain("1 later turn");
  });

  test("replies without a snapshot, undone ones and abandoned ones are never candidates; redo takes the oldest undone, not an abandoned one", async () => {
    const a = reply("a", { before: "1", after: "2", undone: true, abandoned: true });
    const none = await planStep(store, [reply("plain"), a], "undo");
    expect(none).toEqual({ kind: "none", skipped: 0 });
    expect(await planStep(store, [a], "redo")).toEqual({ kind: "none", skipped: 0 });
  });

  test("a restore the store refuses is an error and the reply is not marked undone", async () => {
    const refusing = {
      changedFiles: async () => ["../escape.txt"],
      modifiedSince: async () => [],
      restore: async () => {
        throw new Error("snapshot: refusing path outside the project");
      },
    } as unknown as SnapshotStore;
    const messages = [reply("r", { before: "a".repeat(40), after: "b".repeat(40) })];
    const planned = await planStep(refusing, messages, "undo");
    if (planned.kind !== "ready") throw new Error("expected a plan");
    await expect(applyStep(refusing, messages, planned)).rejects.toThrow("refusing path");
    expect(messages[0]!.metadata?.snapshot?.undone).toBeUndefined();
  });
});

describe("noStepReason", () => {
  const none = { kind: "none", skipped: 0 } as const;
  test("says why undo cannot help", () => {
    expect(noStepReason("undo", none, { available: false, reason: "git is not installed" }, [], undefined)).toBe("File undo is unavailable: git is not installed.");
    expect(noStepReason("undo", none, { available: true }, [], "the snapshot took longer than 10 s")).toContain("the snapshot took longer than 10 s");
    expect(noStepReason("undo", none, { available: true }, [reply("p")], undefined)).toBe("No turn in this session has a file snapshot, so there is nothing to undo.");
    expect(noStepReason("undo", { kind: "none", skipped: 2 }, { available: true }, [reply("a", { before: "1", after: "1" })], undefined)).toBe(
      "Nothing to undo: no turn changed any files.",
    );
    expect(noStepReason("undo", none, { available: true }, [reply("a", { before: "1", after: "2", undone: true })], undefined)).toBe(
      "Nothing left to undo. /redo puts the files back.",
    );
    expect(noStepReason("redo", none, { available: true }, [], undefined)).toBe("Nothing to redo.");
  });
});

describe("parseUnifiedDiff", () => {
  test("splits a diff into files with their line kinds and counts", () => {
    const text = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,2 @@",
      " same",
      "-old",
      "+new",
      "diff --git a/b.txt b/b.txt",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ b/b.txt",
      "@@ -0,0 +1 @@",
      "+hello",
      "diff --git a/c.bin b/c.bin",
      "deleted file mode 100644",
      "index 4444444..0000000",
      "Binary files a/c.bin and /dev/null differ",
    ].join("\n");
    const files = parseUnifiedDiff(text);
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["a.txt", "modified", 1, 1],
      ["b.txt", "added", 1, 0],
      ["c.bin", "deleted", 0, 0],
    ]);
    expect(files[0]!.lines).toEqual([
      { kind: "hunk", text: "@@ -1,2 +1,2 @@" },
      { kind: "context", text: " same" },
      { kind: "remove", text: "-old" },
      { kind: "add", text: "+new" },
    ]);
    expect(files[2]!.lines).toEqual([{ kind: "note", text: "Binary files a/c.bin and /dev/null differ" }]);
  });

  test("works on the store's real diff", async () => {
    writeFileSync(file("d.txt"), "one\n");
    const before = await store.track();
    writeFileSync(file("d.txt"), "two\n");
    const files = parseUnifiedDiff(await store.diff(before));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: "d.txt", status: "modified", additions: 1, deletions: 1 });
  });

  test("empty text has no files", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});
