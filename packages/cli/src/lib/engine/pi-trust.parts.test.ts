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
/** Runs git in `cwd` as a user would (the test's HOME, no system config); fails the test when git fails. */
const git = (cwd: string, ...args: string[]) => {
  const env: Record<string, string> = { GIT_CONFIG_NOSYSTEM: "1" };
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("GIT_")) env[key] ??= value;
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
};
const gitRepo = (dir = project) => {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, ".git", "info"), { recursive: true });
};
const gitRows = (dir = project) => reviewProject(dir).resources.filter((resource) => resource.kind === "git");
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
      ["no filter drivers", "git"],
      [".gitattributes", "git"],
    ]);
    expect(resources.find((resource) => resource.path === "no filter drivers")?.detail).toBeUndefined();
    expect(Object.fromEntries(record.map((entry) => [entry.path, entry.kind]))).toEqual({
      ".pi/extensions/a.ts": "pi",
      ".marcsh/commands/deploy.md": "command",
      "no filter drivers": "git",
      ".gitattributes": "git",
    });
  });

  test("a command row shows the agent and model its frontmatter sets", () => {
    command("ship.md", "---\nagent: build\nmodel: opus\n---\nShip it.\n");
    command("plain.md", "---\ndescription: d\n---\nPlain.\n");

    const rows = reviewProject(project).resources.filter((resource) => resource.kind === "command");

    expect(rows.map((row) => row.detail)).toEqual(["project command /plain", "project command /ship (agent: build, model: opus)"]);
  });

  test("a linked worktree's filter drivers are its repo's and its own worktree config's", () => {
    const main = join(root, "main");
    gitRepo(main);
    git(main, "commit", "-q", "--allow-empty", "-m", "one");
    git(main, "worktree", "add", "-q", join(root, "wt"));
    git(main, "config", "filter.m.clean", "m-clean");
    git(main, "config", "extensions.worktreeConfig", "true");
    git(join(root, "wt"), "config", "--worktree", "filter.w.smudge", "w-smudge");

    expect(gitRows(join(root, "wt")).map(({ path, detail }) => [path, detail])).toEqual([
      ["git filter drivers: m, w", "filter m clean: m-clean"],
      ["git filter drivers: m, w", "filter w smudge: w-smudge"],
    ]);
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
      "no filter drivers": "unreviewed",
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

  test("a new filter driver or a new .gitattributes turns only the git count off", () => {
    command("deploy.md");
    gitRepo();
    for (const change of [
      () => git(project, "config", "filter.x.clean", "./run-me"),
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

describe("the git part: only what could make the status line's git status run a program", () => {
  // Aged, so the review is kept (`currentProjectReview`) and only a noted path changing reads the project again.
  const trustedAged = () => {
    age();
    return trusted();
  };

  test("settings git itself writes (upstream, remotes, core) leave it holding", () => {
    gitRepo();
    git(project, "commit", "-q", "--allow-empty", "-m", "one");
    git(project, "branch", "other");
    const storage = trustedAged();
    for (const change of [
      () => git(project, "config", "branch.main.remote", "origin"),
      () => git(project, "branch", "-u", "other"),
      () => git(project, "remote", "add", "up", "https://example.invalid/r.git"),
      () => git(project, "config", "core.autocrlf", "input"),
    ]) {
      change();
      expect(partTrust(project, storage, "git")).toBe("holds");
    }
    expect(git(project, "config", "--get", "branch.main.merge").trim()).toBe("refs/heads/other");
  });

  test("a repo without filter drivers or attributes is one entry, so a driver added later asks again", () => {
    gitRepo();
    expect(gitRows().map(({ path, detail }) => [path, detail])).toEqual([["no filter drivers", undefined]]);
    const storage = trustedAged();
    expect(partTrust(project, storage, "git")).toBe("holds");

    git(project, "config", "filter.x.clean", "./run-me");

    expect(partTrust(project, storage, "git")).toBe("stale");
    expect(gitRows().map(({ path, detail }) => [path, detail])).toEqual([["git filter drivers: x", "filter x clean: ./run-me"]]);
  });

  test("a filter driver in a file the repo's config includes counts, and so does an edit to that file", () => {
    gitRepo();
    writeFileSync(join(project, "gitinc"), "[core]\n");
    git(project, "config", "include.path", "../gitinc");
    const storage = trustedAged();
    expect(partTrust(project, storage, "git")).toBe("holds");

    writeFileSync(join(project, "gitinc"), '[filter "inc"]\n\tsmudge = ./inc-run\n');

    expect(partTrust(project, storage, "git")).toBe("stale");
    expect(gitRows().map(({ path, detail }) => [path, detail])).toEqual([["git filter drivers: inc", "filter inc smudge: ./inc-run"]]);
  });

  test("an include added to the config, or one that applies on another branch, counts", () => {
    gitRepo();
    git(project, "commit", "-q", "--allow-empty", "-m", "one");
    writeFileSync(join(project, "gitinc"), '[filter "inc"]\n\tclean = ./inc-run\n');
    git(project, "config", "includeIf.onbranch:feature.path", "../gitinc");
    const storage = trustedAged();
    expect(partTrust(project, storage, "git")).toBe("holds");

    git(project, "switch", "-q", "-c", "feature");
    expect(partTrust(project, storage, "git")).toBe("stale");

    git(project, "switch", "-q", "main");
    expect(partTrust(project, storage, "git")).toBe("holds");
    git(project, "config", "include.path", "../gitinc");
    expect(partTrust(project, storage, "git")).toBe("stale");
  });

  test("an edit to .gitattributes turns it off", () => {
    gitRepo();
    writeFileSync(join(project, ".gitattributes"), "*.md text\n");
    const storage = trustedAged();
    expect(partTrust(project, storage, "git")).toBe("holds");

    writeFileSync(join(project, ".gitattributes"), "*.md filter=x\n");

    expect(partTrust(project, storage, "git")).toBe("stale");
  });

  test("the user's own global git config is not the project's: its filter drivers are neither shown nor reviewed", () => {
    gitRepo();
    const storage = trustedAged();
    const before = reviewProject(project).record;

    writeFileSync(join(process.env.HOME!, ".gitconfig"), '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n');
    expect(git(project, "config", "--get", "filter.lfs.clean").trim()).toBe("git-lfs clean -- %f");

    expect(partTrust(project, storage, "git")).toBe("holds");
    expect(reviewProject(project).record).toEqual(before);
    expect(gitRows().map(({ path }) => path)).toEqual(["no filter drivers"]);
  });

  test("the filter command is shown whole, escaped", () => {
    gitRepo();
    git(project, "config", "filter.x.clean", "run\u001b[2J\nnext %f");

    expect(gitRows().map(({ path, detail }) => [path, detail])).toEqual([["git filter drivers: x", "filter x clean: run\\u001b[2J\\nnext %f"]]);
  });

  test("is kept while nothing git reads for it changed (the status line's poll)", () => {
    gitRepo();
    git(project, "config", "filter.x.clean", "./run-me");
    age();
    const review = reviewProject(project);

    expect(currentProjectReview(project)).toBe(review);
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
