import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorage } from "../storage";
import {
  currentProjectReview,
  diffReview,
  isProjectTrusted,
  projectTrustHolds,
  resolveProjectTrust,
  reviewProject,
  sameReview,
  type ProjectTrustAsk,
} from "./pi-trust";

// S2-S4: project commands are part of the trust review, one rule says whether a trust holds, and that check is cached.

let root: string;
let project: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-trust-commands-")));
  project = join(root, "project");
  mkdirSync(project, { recursive: true });
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

/** Every file and folder of the project dated a minute ago, as files that were not just written are (a fresh one is never cached). */
const age = (path = project, when = new Date(Date.now() - 60_000)) => {
  if (statSync(path).isDirectory()) for (const name of readdirSync(path)) age(join(path, name), when);
  utimesSync(path, when, when);
};

describe("the trust review holds the project's commands (S2)", () => {
  test("each command file is listed as a project command, next to the pi files", () => {
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(project, ".pi", "SYSTEM.md"), "be nice");
    command("deploy.md");
    command("review.md");

    const { resources, record } = reviewProject(project);

    expect(resources).toEqual([
      { path: ".pi/SYSTEM.md", detail: "changes the system prompt" },
      { path: ".marcsh/commands/deploy.md", detail: "project command /deploy" },
      { path: ".marcsh/commands/review.md", detail: "project command /review" },
    ]);
    expect(record.map((entry) => entry.path)).toEqual([".marcsh/commands/deploy.md", ".marcsh/commands/review.md", ".pi/SYSTEM.md"]);
  });

  test("only the files marcsh would read as commands are listed: not other files, bad names, links or oversized files", () => {
    command("ok.md");
    command("notes.txt");
    command("Bad Name.md");
    command("big.md", "x".repeat(256 * 1024 + 1));
    writeFileSync(join(root, "elsewhere.md"), "outside");
    symlinkSync(join(root, "elsewhere.md"), join(commands(), "linked.md"));

    expect(reviewProject(project).resources).toEqual([{ path: ".marcsh/commands/ok.md", detail: "project command /ok" }]);
  });

  test("a command added, changed or removed makes the review differ, and the diff says which", () => {
    command("keep.md");
    command("edit.md");
    command("gone.md");
    const reviewed = reviewProject(project).record;

    command("edit.md", "Do something else.\n");
    command("new.md");
    rmSync(join(commands(), "gone.md"));
    const now = reviewProject(project).record;

    expect(sameReview(reviewed, now)).toBe(false);
    const changes = diffReview(reviewed, now);
    expect(Object.fromEntries(changes.status)).toEqual({
      ".marcsh/commands/edit.md": "changed",
      ".marcsh/commands/keep.md": "unchanged",
      ".marcsh/commands/new.md": "added",
    });
    expect(changes.removed).toEqual([".marcsh/commands/gone.md"]);
  });
});

describe("projectTrustHolds: one rule for every consumer (S3)", () => {
  const store = () => openStorage(":memory:");

  test("holds only for a stored 'trusted' whose review equals the project now", () => {
    command("deploy.md");
    const storage = store();
    expect(projectTrustHolds(project, storage)).toBe(false);

    storage.setProjectTrust(project, "untrusted");
    expect(projectTrustHolds(project, storage)).toBe(false);

    storage.setProjectTrust(project, "trusted", reviewProject(project).record);
    expect(projectTrustHolds(project, storage)).toBe(true);
    expect(projectTrustHolds(project, () => storage)).toBe(true);
  });

  test("a trust gone stale (a command changed since the review) does not hold", () => {
    command("deploy.md");
    const storage = store();
    storage.setProjectTrust(project, "trusted", reviewProject(project).record);

    command("deploy.md", "Deploy, and also something else.\n");

    expect(projectTrustHolds(project, storage)).toBe(false);
  });

  test("a stored 'trusted' with no review (from before reviews) does not hold, not even for an empty project", () => {
    const storage = store();
    storage.setProjectTrust(project, "trusted");

    expect(projectTrustHolds(project, storage)).toBe(false);
  });

  test("an empty project trusted with the empty review holds until something to review appears", () => {
    const storage = store();
    storage.setProjectTrust(project, "trusted", reviewProject(project).record);
    expect(storage.getProjectReview(project)).toEqual([]);
    expect(projectTrustHolds(project, storage)).toBe(true);

    command("deploy.md");

    expect(projectTrustHolds(project, storage)).toBe(false);
  });

  test("a store that cannot be read never holds", () => {
    expect(
      projectTrustHolds(project, () => {
        throw new Error("no store");
      }),
    ).toBe(false);
  });

  test("pi warm-up follows it: a project with only commands, trusted as it is, is trusted; once a command changes it is not", () => {
    command("deploy.md");
    const storage = store();
    storage.setProjectTrust(project, "trusted", reviewProject(project).record);
    expect(isProjectTrusted(project, () => storage)).toBe(true);

    command("deploy.md", "Changed.\n");

    expect(isProjectTrusted(project, () => storage)).toBe(false);
  });
});

describe("the pi turn asks when the project has only commands (S2)", () => {
  test("an undecided project with only commands is asked about, with the commands listed; trusting stores their review", async () => {
    command("deploy.md");
    const storage = openStorage(":memory:");
    const asks: ProjectTrustAsk[] = [];

    const trusted = await resolveProjectTrust({
      cwd: project,
      records: () => storage,
      ask: async (request) => {
        asks.push(request);
        return "trust";
      },
      signal: new AbortController().signal,
    });

    expect(trusted).toBe(true);
    expect(asks.map((ask) => ask.resources)).toEqual([[{ path: ".marcsh/commands/deploy.md", detail: "project command /deploy" }]]);
    expect(storage.getProjectReview(project)).toEqual(reviewProject(project).record);
  });

  test("a trusted project whose command changed is asked again, with the change listed", async () => {
    command("deploy.md");
    const storage = openStorage(":memory:");
    storage.setProjectTrust(project, "trusted", reviewProject(project).record);
    command("deploy.md", "Changed.\n");
    const asks: ProjectTrustAsk[] = [];

    await resolveProjectTrust({
      cwd: project,
      records: () => storage,
      ask: async (request) => {
        asks.push(request);
        return "skip";
      },
      signal: new AbortController().signal,
    });

    expect(asks).toHaveLength(1);
    expect(asks[0]!.changes?.status.get(".marcsh/commands/deploy.md")).toBe("changed");
  });
});

describe("the check is cached by a stat signature of what was reviewed (S4)", () => {
  test("nothing changed: the same review is returned without reading the project again", () => {
    command("deploy.md");
    age();

    const first = currentProjectReview(project);

    expect(currentProjectReview(project)).toBe(first);
  });

  test("a command edited in place (same size, same dates) is seen", () => {
    const past = new Date(Date.now() - 60_000);
    command("deploy.md", "Deploy A.\n");
    age(project, past);
    const storage = openStorage(":memory:");
    storage.setProjectTrust(project, "trusted", reviewProject(project).record);
    expect(projectTrustHolds(project, storage)).toBe(true);

    command("deploy.md", "Deploy B.\n");
    age(project, past);

    expect(projectTrustHolds(project, storage)).toBe(false);
  });

  test("a command added or removed is seen", () => {
    command("deploy.md");
    age();
    const storage = openStorage(":memory:");
    storage.setProjectTrust(project, "trusted", reviewProject(project).record);
    expect(projectTrustHolds(project, storage)).toBe(true);

    command("other.md");
    age();
    expect(projectTrustHolds(project, storage)).toBe(false);

    rmSync(join(commands(), "other.md"));
    age();
    expect(projectTrustHolds(project, storage)).toBe(true);

    rmSync(join(commands(), "deploy.md"));
    age();
    expect(projectTrustHolds(project, storage)).toBe(false);
  });

  test("files appearing where there were none (a commands folder, a .pi folder) are seen", () => {
    age();
    const storage = openStorage(":memory:");
    storage.setProjectTrust(project, "trusted", reviewProject(project).record);
    expect(projectTrustHolds(project, storage)).toBe(true);

    command("deploy.md");
    age();
    expect(projectTrustHolds(project, storage)).toBe(false);

    rmSync(join(project, ".marcsh"), { recursive: true });
    age();
    expect(projectTrustHolds(project, storage)).toBe(true);

    mkdirSync(join(project, ".pi"));
    writeFileSync(join(project, ".pi", "mcp.json"), "{}");
    age();
    expect(projectTrustHolds(project, storage)).toBe(false);
  });

  test("a file nested in a reviewed folder edited in place is seen", () => {
    mkdirSync(join(project, ".pi", "extensions", "pack", "lib"), { recursive: true });
    writeFileSync(join(project, ".pi", "extensions", "pack", "lib", "a.ts"), "export const a = 1;\n");
    age();
    const storage = openStorage(":memory:");
    storage.setProjectTrust(project, "trusted", reviewProject(project).record);
    expect(projectTrustHolds(project, storage)).toBe(true);

    writeFileSync(join(project, ".pi", "extensions", "pack", "lib", "a.ts"), "export const a = 2;\n");
    age();

    expect(projectTrustHolds(project, storage)).toBe(false);
  });
});
