import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorage } from "../storage";
import { isProjectTrusted, resolveProjectTrust, reviewProject, unreadableResources } from "./pi-trust";

// Verifier probes for R4-003: every listed entry, however small, counts against the 1000-entry review cap.

let root: string;
let project: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-pi-cap-")));
  project = join(root, "project");
  mkdirSync(join(root, "home"), { recursive: true });
  savedHome = process.env.HOME;
  process.env.HOME = join(root, "home");
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

const prompts = (count: number) => {
  const dir = join(project, ".pi", "prompts");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) writeFileSync(join(dir, `p${String(i).padStart(5, "0")}.md`), "x");
};

describe("the review cap counts top-level tiny files", () => {
  test("exactly 1000 prompt files are reviewed in full", () => {
    prompts(1000);
    expect(unreadableResources(reviewProject(project).resources)).toHaveLength(0);
  });

  test("1001 prompt files: the one past the cap is unreadable", () => {
    prompts(1001);
    const unreadable = unreadableResources(reviewProject(project).resources);
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]).toMatchObject({ path: ".pi/prompts/p01000.md", detail: expect.stringContaining("more than 1000 files to review") });
  });

  test("1500 prompt files: 500 unreadable, and 'trust' cannot make the project trusted", async () => {
    prompts(1500);
    expect(unreadableResources(reviewProject(project).resources)).toHaveLength(500);
    const storage = openStorage(":memory:");
    const trusted = await resolveProjectTrust({ cwd: project, records: () => storage, ask: async () => "trust", signal: new AbortController().signal });
    expect(trusted).toBe(false);
    expect(isProjectTrusted(project, () => storage)).toBe(false);
  });

  test("the scan stays bounded: 5000 tiny files are reviewed in well under the time hashing them all takes", () => {
    prompts(5000);
    const started = performance.now();
    const { resources } = reviewProject(project);
    const elapsed = performance.now() - started;
    expect(unreadableResources(resources)).toHaveLength(4000);
    expect(elapsed).toBeLessThan(1500);
  }, 30_000);
});
