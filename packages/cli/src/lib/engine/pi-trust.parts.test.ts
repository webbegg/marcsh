import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorage, type StoredReview } from "../storage";
import {
  currentProjectReview,
  diffReview,
  isProjectTrusted,
  partTrust,
  resolveProjectTrust,
  reviewProject,
  trustedProjectCommands,
  type ProjectTrustAsk,
} from "./pi-trust";

// The review has three parts (pi files, project commands, git settings); each consumer checks only its own part.

let root: string;
let project: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-trust-parts-")));
  project = join(root, "project");
  mkdirSync(join(project, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(project, ".pi", "extensions", "a.ts"), "export default function () {}\n");
  mkdirSync(join(root, "home"), { recursive: true });
  savedHome = process.env.HOME;
  process.env.HOME = join(root, "home");
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

const commands = () => join(project, ".marcsh", "commands");
const command = (name: string, body = `Run ${name}.\n`) => {
  mkdirSync(commands(), { recursive: true });
  writeFileSync(join(commands(), name), body);
};
const gitRepo = (config = "[core]\n\tbare = false\n") => {
  mkdirSync(join(project, ".git", "info"), { recursive: true });
  writeFileSync(join(project, ".git", "config"), config);
};
const age = (path = project, when = new Date(Date.now() - 60_000)) => {
  if (statSync(path).isDirectory()) for (const name of readdirSync(path)) age(join(path, name), when);
  utimesSync(path, when, when);
};
const never = new AbortController().signal;

/** What marcsh stored before it reviewed commands and git settings: the pi entries only, with no `kind`. */
const legacyReview = (): StoredReview =>
  reviewProject(project)
    .record.filter((entry) => (entry.kind ?? "pi") === "pi")
    .map(({ path, shown, content }) => ({ path, shown, content }));

const trusted = () => {
  const storage = openStorage(":memory:");
  storage.setProjectTrust(project, "trusted", reviewProject(project).record);
  return storage;
};

describe("entries are tagged with their part", () => {
  test("pi files, project commands and git settings each carry their kind in the record", () => {
    command("deploy.md");
    gitRepo();
    writeFileSync(join(project, ".gitattributes"), "*.secret filter=crypt\n");

    const { resources, record } = reviewProject(project);

    expect(resources.map((resource) => [resource.path, resource.kind ?? "pi"])).toEqual([
      [".pi/extensions/a.ts", "pi"],
      [".marcsh/commands/deploy.md", "command"],
      [".git/config", "git"],
      [".gitattributes", "git"],
    ]);
    expect(resources.find((resource) => resource.path === ".git/config")?.detail).toBe("git settings: may run programs the repo names (filter drivers)");
    expect(Object.fromEntries(record.map((entry) => [entry.path, entry.kind]))).toEqual({
      ".pi/extensions/a.ts": "pi",
      ".marcsh/commands/deploy.md": "command",
      ".git/config": "git",
      ".gitattributes": "git",
    });
  });

  test("a command row shows the agent and model its frontmatter sets", () => {
    command("ship.md", "---\nagent: build\nmodel: opus\n---\nShip it.\n");
    command("plain.md", "---\ndescription: d\n---\nPlain.\n");

    const rows = reviewProject(project).resources.filter((resource) => resource.kind === "command");

    expect(rows.map((row) => row.detail)).toEqual(["project command /plain", "project command /ship (agent: build, model: opus)"]);
  });

  test("a worktree's git settings are where its .git file points", () => {
    const main = join(root, "main");
    mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true });
    writeFileSync(join(main, ".git", "config"), "[core]\n");
    writeFileSync(join(main, ".git", "worktrees", "wt", "commondir"), "../..\n");
    writeFileSync(join(project, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);

    const git = reviewProject(project).resources.filter((resource) => resource.kind === "git");

    expect(git.map((resource) => resource.path)).toEqual([join(main, ".git", "config")]);
  });
});

describe("the upgrade: a review stored before commands and git settings were reviewed", () => {
  test("keeps pi trusted (warm-up, the turn asks nothing); commands and git are not reviewed yet", async () => {
    command("deploy.md");
    gitRepo();
    const storage = openStorage(":memory:");
    storage.setProjectTrust(project, "trusted", legacyReview());

    expect(partTrust(project, storage, "pi")).toBe("holds");
    expect(isProjectTrusted(project, () => storage)).toBe(true);
    const asks: ProjectTrustAsk[] = [];
    expect(await resolveProjectTrust({ cwd: project, records: () => storage, ask: async (ask) => (asks.push(ask), "skip"), signal: never })).toBe(true);
    expect(asks).toEqual([]);

    expect(trustedProjectCommands(project, storage)).toMatchObject({ state: "unreviewed", present: true, commands: [] });
    expect(partTrust(project, storage, "git")).toBe("unreviewed");
  });

  test("headless (nobody to ask) still trusts the pi files", async () => {
    command("deploy.md");
    const storage = openStorage(":memory:");
    storage.setProjectTrust(project, "trusted", legacyReview());

    expect(await resolveProjectTrust({ cwd: project, records: () => storage, signal: never })).toBe(true);
  });

  test("when the pi files changed too, the question marks commands and git as not reviewed before, not as added", () => {
    command("deploy.md");
    gitRepo();
    const reviewed = legacyReview();
    writeFileSync(join(project, ".pi", "extensions", "b.ts"), "export default function () {}\n");

    const changes = diffReview(reviewed, reviewProject(project).record);

    expect(Object.fromEntries(changes.status)).toEqual({
      ".pi/extensions/a.ts": "unchanged",
      ".pi/extensions/b.ts": "added",
      ".marcsh/commands/deploy.md": "unreviewed",
      ".git/config": "unreviewed",
    });
    expect(changes.removed).toEqual([]);
  });
});

describe("each part goes stale on its own", () => {
  test("a command added, changed or removed turns only the commands off", () => {
    command("keep.md");
    command("gone.md");
    gitRepo();
    for (const change of [() => command("new.md"), () => command("keep.md", "Changed.\n"), () => rmSync(join(commands(), "gone.md"))]) {
      const storage = trusted();
      expect(trustedProjectCommands(project, storage).state).toBe("holds");
      change();
      expect(trustedProjectCommands(project, storage)).toMatchObject({ state: "stale", commands: [] });
      expect(partTrust(project, storage, "pi")).toBe("holds");
      expect(partTrust(project, storage, "git")).toBe("holds");
    }
  });

  test("a changed .git/config or a new .gitattributes turns only the git count off", () => {
    command("deploy.md");
    gitRepo();
    for (const change of [
      () => writeFileSync(join(project, ".git", "config"), '[filter "x"]\n\tclean = ./run-me\n'),
      () => writeFileSync(join(project, ".gitattributes"), "* filter=x\n"),
      () => writeFileSync(join(project, ".git", "info", "attributes"), "* filter=x\n"),
    ]) {
      const storage = trusted();
      expect(partTrust(project, storage, "git")).toBe("holds");
      change();
      expect(partTrust(project, storage, "git")).toBe("stale");
      expect(partTrust(project, storage, "pi")).toBe("holds");
      expect(trustedProjectCommands(project, storage).state).toBe("holds");
    }
  });

  test("a changed pi file leaves commands and git as they are", () => {
    command("deploy.md");
    gitRepo();
    const storage = trusted();
    writeFileSync(join(project, ".pi", "extensions", "a.ts"), "export default function () { return 1; }\n");

    expect(partTrust(project, storage, "pi")).toBe("stale");
    expect(trustedProjectCommands(project, storage).state).toBe("holds");
    expect(partTrust(project, storage, "git")).toBe("holds");
  });
});

describe("commands never make pi trusted (R1-5)", () => {
  test("a project with only commands is not asked about by the pi turn and never gets pi's trust", async () => {
    rmSync(join(project, ".pi"), { recursive: true });
    command("deploy.md");
    const storage = trusted();
    const asks: ProjectTrustAsk[] = [];

    expect(await resolveProjectTrust({ cwd: project, records: () => storage, ask: async (ask) => (asks.push(ask), "trust"), signal: never })).toBe(false);
    expect(asks).toEqual([]);
    expect(isProjectTrusted(project, () => storage)).toBe(false);
    expect(trustedProjectCommands(project, storage).state).toBe("holds");
  });
});

describe("what cannot be read affects only its own part (R3-4)", () => {
  test("an unreadable command: pi keeps its trust, the commands stay off, and the pi turn still offers trust", async () => {
    command("deploy.md");
    command("locked.md");
    chmodSync(join(commands(), "locked.md"), 0);
    try {
      const storage = openStorage(":memory:");
      const review = reviewProject(project);
      expect(review.resources.find((resource) => resource.path === ".marcsh/commands/locked.md")).toMatchObject({ kind: "command", unreadable: true });

      // The question's "trust" is honoured: only the pi part is needed to be readable for it.
      expect(await resolveProjectTrust({ cwd: project, records: () => storage, ask: async () => "trust", signal: never })).toBe(true);
      expect(partTrust(project, storage, "pi")).toBe("holds");
      expect(trustedProjectCommands(project, storage)).toMatchObject({ state: "stale", commands: [] });
    } finally {
      chmodSync(join(commands(), "locked.md"), 0o644);
    }
  });

  test("more commands than the review reads: only the commands stay off", () => {
    for (let i = 0; i < 1001; i++) command(`c${i}.md`, "x\n");
    const storage = trusted();

    expect(reviewProject(project).resources.filter((resource) => resource.kind === "command" && resource.unreadable).length).toBeGreaterThan(0);
    expect(partTrust(project, storage, "pi")).toBe("holds");
    expect(trustedProjectCommands(project, storage).state).toBe("stale");
  });
});

describe("the loader uses the bytes it checked (R1-4, R1-7)", () => {
  test("the commands it returns are the reviewed bytes, read once, and re-hashed on every call (not from the stat cache)", () => {
    command("deploy.md", "Deploy A.\n");
    age();
    const storage = trusted();
    currentProjectReview(project);

    expect(trustedProjectCommands(project, storage).commands).toEqual([
      { name: "deploy", file: "deploy.md", path: join(commands(), "deploy.md"), text: "Deploy A.\n" },
    ]);

    // Same size, dates put back: whatever the stat cache says, the bytes differ from the review.
    writeFileSync(join(commands(), "deploy.md"), "Deploy B.\n");
    age();
    expect(trustedProjectCommands(project, storage)).toMatchObject({ state: "stale", commands: [] });
  });
});

describe("the stat cache re-checks only what was racy (R3-10)", () => {
  test("a review taken right after a write is kept, and its racy files are re-read to tell a same-tick change", () => {
    command("deploy.md", "Deploy A.\n");
    const first = currentProjectReview(project);
    expect(currentProjectReview(project)).toBe(first);

    const file = join(commands(), "deploy.md");
    const { atime, mtime } = statSync(file);
    writeFileSync(file, "Deploy B.\n");
    utimesSync(file, atime, mtime);

    expect(currentProjectReview(project)).not.toBe(first);
  });
});
