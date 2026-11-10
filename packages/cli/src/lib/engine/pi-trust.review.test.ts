import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorage } from "../storage";
import {
  diffReview,
  isProjectTrusted,
  resolveProjectTrust,
  reviewProject,
  sameReview,
  type ProjectTrustAsk,
  type TrustAnswer,
} from "./pi-trust";

let root: string;
let project: string;
let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-pi-review-")));
  project = join(root, "work", "project");
  home = join(root, "home");
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  savedHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

const write = (path: string, content = "") => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
};
const mcp = (server: unknown) => write(join(project, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { fx: server } }));
const record = () => reviewProject(project).record;

describe("the review record (S1)", () => {
  test("the same files give an equal record, run after run", () => {
    write(join(project, ".pi", "extensions", "foo.ts"), "export default 1");
    mcp({ command: "node", args: ["s.js"] });

    expect(sameReview(record(), record())).toBe(true);
  });

  test("it has one entry per listed path, in path order", () => {
    write(join(project, ".pi", "extensions", "foo.ts"), "export default 1");
    mcp({ command: "node", args: ["s.js"], env: { A: "1" } });

    expect(record().map((entry) => entry.path)).toEqual([".pi/extensions/foo.ts", ".pi/mcp.json"]);
  });

  test("a changed file content is a different record", () => {
    write(join(project, ".pi", "extensions", "foo.ts"), "export default 1");
    const before = record();

    write(join(project, ".pi", "extensions", "foo.ts"), "export default 2");

    expect(sameReview(before, record())).toBe(false);
  });

  test("a new file is a different record", () => {
    write(join(project, ".pi", "extensions", "foo.ts"), "x");
    const before = record();

    write(join(project, ".pi", "extensions", "bar.ts"), "y");

    expect(sameReview(before, record())).toBe(false);
  });

  test("a removed file is a different record", () => {
    write(join(project, ".pi", "extensions", "foo.ts"), "x");
    write(join(project, ".pi", "extensions", "bar.ts"), "y");
    const before = record();

    rmSync(join(project, ".pi", "extensions", "bar.ts"));

    expect(sameReview(before, record())).toBe(false);
  });

  test("a change in what mcp.json shows (the command's arguments) is a different record", () => {
    mcp({ command: "node", args: ["a.js"] });
    const before = record();

    mcp({ command: "node", args: ["b.js"] });

    expect(sameReview(before, record())).toBe(false);
  });

  test("a change to a value mcp.json does not show is still a different record (the content hash)", () => {
    mcp({ command: "node", timeout: 1 });
    const before = record();

    mcp({ command: "node", timeout: 2 });

    expect(sameReview(before, record())).toBe(false);
  });

  test("a change deep inside a listed folder is a different record", () => {
    write(join(project, ".pi", "skills", "review", "SKILL.md"), "---\nname: review\n---\n");
    write(join(project, ".pi", "skills", "review", "scripts", "run.sh"), "echo 1");
    const before = record();

    write(join(project, ".pi", "skills", "review", "scripts", "run.sh"), "echo 2");

    expect(sameReview(before, record())).toBe(false);
  });

  test("a new file deep inside a listed folder is a different record", () => {
    write(join(project, ".pi", "skills", "review", "SKILL.md"), "x");
    const before = record();

    write(join(project, ".pi", "skills", "review", "extra.sh"), "echo");

    expect(sameReview(before, record())).toBe(false);
  });

  test("a symlinked folder is followed: changes behind it count", () => {
    write(join(root, "shared", "SKILL.md"), "v1");
    mkdirSync(join(project, ".pi", "skills"), { recursive: true });
    symlinkSync(join(root, "shared"), join(project, ".pi", "skills", "linked"));
    const before = record();

    write(join(root, "shared", "SKILL.md"), "v2");

    expect(sameReview(before, record())).toBe(false);
  });

  test("only paths and hashes are stored: no contents, commands or env values appear anywhere in the record", () => {
    write(join(project, ".pi", "extensions", "foo.ts"), "SECRET-EXTENSION-BODY");
    mcp({ command: "SECRET-COMMAND", args: ["SECRET-ARG"], env: { TOKEN: "SECRET-ENV-VALUE" } });

    const json = JSON.stringify(record());

    for (const secret of ["SECRET-EXTENSION-BODY", "SECRET-COMMAND", "SECRET-ARG", "SECRET-ENV-VALUE", "TOKEN"]) expect(json.includes(secret)).toBe(false);
    for (const entry of record()) {
      expect(Object.keys(entry).sort()).toEqual(["content", "path", "shown"]);
      expect(entry.shown).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.content).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("a child file marcsh cannot read safely is listed as unreadable, so trusting stays impossible", () => {
    write(join(project, ".pi", "extensions", "big.ts"), "x".repeat(1024 * 1024 + 1));

    const { resources } = reviewProject(project);

    expect(resources).toEqual([{ path: ".pi/extensions/big.ts", detail: "could not be read: larger than 1 MB", unreadable: true }]);
  });

  test("a folder with a child it cannot read is unreadable as a whole, naming the child", () => {
    write(join(project, ".pi", "skills", "s", "SKILL.md"), "x");
    write(join(project, ".pi", "skills", "s", "data", "huge.bin"), "x".repeat(1024 * 1024 + 1));

    const { resources } = reviewProject(project);

    expect(resources).toEqual([{ path: ".pi/skills/s/", detail: "could not be read: data/huge.bin: larger than 1 MB", unreadable: true }]);
  });

  test("a folder with too many files is unreadable (the scan stays bounded)", () => {
    for (let i = 0; i < 1100; i++) write(join(project, ".pi", "skills", "s", `f${i}.md`), "x");

    const { resources } = reviewProject(project);

    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({ path: ".pi/skills/s/", unreadable: true });
  });

  test("an unreadable child (no permission) makes its entry unreadable", () => {
    write(join(project, ".pi", "extensions", "locked.ts"), "x");
    chmodSync(join(project, ".pi", "extensions", "locked.ts"), 0o000);

    try {
      expect(reviewProject(project).resources).toEqual([{ path: ".pi/extensions/locked.ts", detail: "could not be read: cannot be opened or read", unreadable: true }]);
    } finally {
      chmodSync(join(project, ".pi", "extensions", "locked.ts"), 0o600);
    }
  });
});

describe("diffReview", () => {
  test("marks each entry added, changed or unchanged, and lists removed paths", () => {
    write(join(project, ".pi", "extensions", "same.ts"), "1");
    write(join(project, ".pi", "extensions", "edit.ts"), "1");
    write(join(project, ".pi", "extensions", "gone.ts"), "1");
    const before = record();

    write(join(project, ".pi", "extensions", "edit.ts"), "2");
    write(join(project, ".pi", "extensions", "new.ts"), "1");
    rmSync(join(project, ".pi", "extensions", "gone.ts"));

    const changes = diffReview(before, record());

    expect(changes.known).toBe(true);
    expect(Object.fromEntries(changes.status)).toEqual({
      ".pi/extensions/edit.ts": "changed",
      ".pi/extensions/new.ts": "added",
      ".pi/extensions/same.ts": "unchanged",
    });
    expect(changes.removed).toEqual([".pi/extensions/gone.ts"]);
  });

  test("with no earlier record nothing can be compared", () => {
    write(join(project, ".pi", "extensions", "a.ts"), "1");

    const changes = diffReview(null, record());

    expect(changes.known).toBe(false);
    expect(changes.status.size).toBe(0);
    expect(changes.removed).toEqual([]);
  });
});

/** A project with one extension, trusted as it is now. */
function trustedProject() {
  write(join(project, ".pi", "extensions", "foo.ts"), "v1");
  const storage = openStorage(":memory:");
  storage.setProjectTrust(project, "trusted", record());
  return storage;
}

function resolveWith(storage: ReturnType<typeof openStorage>, answer?: TrustAnswer | (() => TrustAnswer)) {
  const asks: ProjectTrustAsk[] = [];
  const ask = answer
    ? async (request: ProjectTrustAsk) => {
        asks.push(request);
        return typeof answer === "function" ? answer() : answer;
      }
    : undefined;
  const resolve = () => resolveProjectTrust({ cwd: project, records: () => storage, ask, signal: new AbortController().signal });
  return { asks, resolve };
}

describe("a stored 'trusted' counts only while the files are as reviewed", () => {
  test("unchanged: trusted without asking, in the turn and in warm-up", async () => {
    const storage = trustedProject();
    const { asks, resolve } = resolveWith(storage, "skip");

    expect(await resolve()).toBe(true);
    expect(isProjectTrusted(project, () => storage)).toBe(true);
    expect(asks).toEqual([]);
  });

  for (const [label, change] of [
    ["a file changed", () => write(join(project, ".pi", "extensions", "foo.ts"), "v2")],
    ["a file added", () => write(join(project, ".pi", "extensions", "new.ts"), "x")],
    ["a file removed", () => (write(join(project, ".pi", "extensions", "other.ts"), "x"), rmSync(join(project, ".pi", "extensions", "foo.ts")))],
    ["an mcp.json appears", () => mcp({ command: "node" })],
  ] as const) {
    test(`${label}: warm-up does not trust, and the turn asks with the changes`, async () => {
      const storage = trustedProject();
      change();
      const { asks, resolve } = resolveWith(storage, "skip");

      expect(isProjectTrusted(project, () => storage)).toBe(false);
      expect(await resolve()).toBe(false);

      expect(asks).toHaveLength(1);
      expect(asks[0]!.changes?.known).toBe(true);
      // Esc stores nothing: the stored row is as it was.
      expect(storage.getProjectTrust(project)).toBe("trusted");
    });
  }

  test("the ask names what changed", async () => {
    const storage = trustedProject();
    write(join(project, ".pi", "extensions", "foo.ts"), "v2");
    write(join(project, ".pi", "extensions", "new.ts"), "x");
    const { asks, resolve } = resolveWith(storage, "skip");

    await resolve();

    expect(Object.fromEntries(asks[0]!.changes!.status)).toEqual({ ".pi/extensions/foo.ts": "changed", ".pi/extensions/new.ts": "added" });
  });

  test("a removed entry is named in the ask", async () => {
    const storage = trustedProject();
    write(join(project, ".pi", "extensions", "other.ts"), "x");
    storage.setProjectTrust(project, "trusted", record());
    rmSync(join(project, ".pi", "extensions", "foo.ts"));
    const { asks, resolve } = resolveWith(storage, "skip");

    await resolve();

    expect(asks[0]!.changes!.removed).toEqual([".pi/extensions/foo.ts"]);
  });

  test("'trust' stores the new record, so the next turn and warm-up trust without asking", async () => {
    const storage = trustedProject();
    write(join(project, ".pi", "extensions", "foo.ts"), "v2");
    const { asks, resolve } = resolveWith(storage, "trust");

    expect(await resolve()).toBe(true);
    expect(await resolve()).toBe(true);

    expect(asks).toHaveLength(1);
    expect(isProjectTrusted(project, () => storage)).toBe(true);
    expect(sameReview(storage.getProjectReview(project)!, record())).toBe(true);
  });

  test("'trust' is not stored when the files change while the question is open", async () => {
    const storage = trustedProject();
    write(join(project, ".pi", "extensions", "foo.ts"), "v2");
    const { resolve } = resolveWith(storage, () => (write(join(project, ".pi", "extensions", "foo.ts"), "v3"), "trust"));

    expect(await resolve()).toBe(false);

    expect(isProjectTrusted(project, () => storage)).toBe(false);
  });

  test("'distrust' stores untrusted and drops the record; it is not asked about again", async () => {
    const storage = trustedProject();
    write(join(project, ".pi", "extensions", "foo.ts"), "v2");
    const { asks, resolve } = resolveWith(storage, "distrust");

    expect(await resolve()).toBe(false);
    expect(await resolve()).toBe(false);

    expect(storage.getProjectTrust(project)).toBe("untrusted");
    expect(storage.getProjectReview(project)).toBeNull();
    expect(asks).toHaveLength(1);
  });

  test("a stored 'untrusted' stays untrusted without asking, whatever changes", async () => {
    write(join(project, ".pi", "extensions", "foo.ts"), "v1");
    const storage = openStorage(":memory:");
    storage.setProjectTrust(project, "untrusted");
    write(join(project, ".pi", "extensions", "foo.ts"), "v2");
    const { asks, resolve } = resolveWith(storage, "trust");

    expect(await resolve()).toBe(false);

    expect(asks).toEqual([]);
  });

  test("a 'trusted' row that has no record (stored before reviews existed) asks again, with nothing to compare", async () => {
    write(join(project, ".pi", "extensions", "foo.ts"), "v1");
    const storage = openStorage(":memory:");
    storage.setProjectTrust(project, "trusted");
    const { asks, resolve } = resolveWith(storage, "skip");

    expect(isProjectTrusted(project, () => storage)).toBe(false);
    expect(await resolve()).toBe(false);

    expect(asks).toHaveLength(1);
    expect(asks[0]!.changes?.known).toBe(false);
  });

  test("with nobody to ask, a changed project is untrusted", async () => {
    const storage = trustedProject();
    write(join(project, ".pi", "extensions", "foo.ts"), "v2");
    const { resolve } = resolveWith(storage);

    expect(await resolve()).toBe(false);
  });

  test("a store without review support never trusts a 'trusted' row", async () => {
    write(join(project, ".pi", "extensions", "foo.ts"), "v1");
    const records = { getProjectTrust: () => "trusted" as const, setProjectTrust: () => {} };

    expect(isProjectTrusted(project, () => records)).toBe(false);
  });

  test("a record that cannot be read from the store never trusts", async () => {
    write(join(project, ".pi", "extensions", "foo.ts"), "v1");
    const records = {
      getProjectTrust: () => "trusted" as const,
      getProjectReview: () => {
        throw new Error("disk is gone");
      },
      setProjectTrust: () => {},
    };

    expect(isProjectTrusted(project, () => records)).toBe(false);
    expect(await resolveProjectTrust({ cwd: project, records: () => records, signal: new AbortController().signal })).toBe(false);
  });

  test("an undecided project asks without changes, and 'trust' stores the record with the decision", async () => {
    write(join(project, ".pi", "extensions", "foo.ts"), "v1");
    const storage = openStorage(":memory:");
    const { asks, resolve } = resolveWith(storage, "trust");

    expect(await resolve()).toBe(true);

    expect(asks[0]!.changes).toBeUndefined();
    expect(sameReview(storage.getProjectReview(project)!, record())).toBe(true);
  });
});
