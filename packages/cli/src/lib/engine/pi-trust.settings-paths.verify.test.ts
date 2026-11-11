import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorage } from "../storage";
import { isProjectTrusted, resolveProjectTrust, reviewProject, type ProjectTrustAsk } from "./pi-trust";

// S1 (verifier): files that .pi/settings.json makes pi load (extensions, packages, skills, prompts, themes paths) are code
// or instructions pi loads on trust; editing them after trusting must ask again, like an edit under .pi/extensions does.
let root: string;
let project: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-settings-paths-")));
  project = join(root, "project");
  mkdirSync(join(project, ".pi"), { recursive: true });
  mkdirSync(join(root, "home"), { recursive: true });
  savedHome = process.env.HOME;
  process.env.HOME = join(root, "home");
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

const write = (path: string, content: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
};

async function trustedThenEdited(settings: unknown, file: string) {
  write(join(project, ".pi/settings.json"), JSON.stringify(settings));
  const storage = openStorage(":memory:");
  storage.setProjectTrust(project, "trusted", reviewProject(project).record);
  expect(isProjectTrusted(project, () => storage)).toBe(true);
  write(join(project, file), "export default function () { /* changed after trust */ }\n");
  const asks: ProjectTrustAsk[] = [];
  const trusted = await resolveProjectTrust({ cwd: project, records: () => storage, ask: async (ask) => (asks.push(ask), "skip"), signal: new AbortController().signal });
  return { trusted, asks, warm: isProjectTrusted(project, () => storage) };
}

describe("paths named in .pi/settings.json", () => {
  test("an `extensions` file outside .pi changes after trust: asked again, not loaded, warm-up does not load", async () => {
    write(join(project, "tools/ext.ts"), "export default function () {}\n");
    const result = await trustedThenEdited({ extensions: ["../tools/ext.ts"] }, "tools/ext.ts");
    expect(result.asks).toHaveLength(1);
    expect(result.trusted).toBe(false);
    expect(result.warm).toBe(false);
  });

  test("a local package's extension changes after trust: asked again", async () => {
    write(join(project, "localpkg/package.json"), JSON.stringify({ name: "localpkg", version: "1.0.0", pi: { extensions: ["./extensions"] } }));
    write(join(project, "localpkg/extensions/e.ts"), "export default function () {}\n");
    const result = await trustedThenEdited({ packages: ["../localpkg"] }, "localpkg/extensions/e.ts");
    expect(result.asks).toHaveLength(1);
    expect(result.trusted).toBe(false);
  });

  test("a `skills` folder outside .pi gains a skill after trust: asked again", async () => {
    write(join(project, "myskills/a/SKILL.md"), "---\nname: a\ndescription: d\n---\n");
    const result = await trustedThenEdited({ skills: ["../myskills"] }, "myskills/b/SKILL.md");
    expect(result.asks).toHaveLength(1);
    expect(result.trusted).toBe(false);
  });
});
