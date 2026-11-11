import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openStorage } from "../storage";
import { isProjectTrusted, resolveProjectTrust, reviewProject, type ProjectTrustAsk } from "./pi-trust";

let root: string;
let project: string;
let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-targets-")));
  project = join(root, "project");
  home = join(root, "home");
  mkdirSync(join(project, ".pi"), { recursive: true });
  mkdirSync(home, { recursive: true });
  savedHome = process.env.HOME;
  process.env.HOME = home;
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
const EXT = "export default function () {}\n";

async function scenario(settings: unknown, mutate: () => void) {
  write(join(project, ".pi/settings.json"), JSON.stringify(settings));
  const storage = openStorage(":memory:");
  const first: ProjectTrustAsk[] = [];
  const t1 = await resolveProjectTrust({ cwd: project, records: () => storage, ask: async (a) => (first.push(a), "trust"), signal: new AbortController().signal });
  expect(t1).toBe(true);
  // unchanged: loads without asking
  const again: ProjectTrustAsk[] = [];
  const t2 = await resolveProjectTrust({ cwd: project, records: () => storage, ask: async (a) => (again.push(a), "skip"), signal: new AbortController().signal });
  expect(again).toHaveLength(0);
  expect(t2).toBe(true);
  expect(isProjectTrusted(project, () => storage)).toBe(true);
  mutate();
  const asks: ProjectTrustAsk[] = [];
  const warm = isProjectTrusted(project, () => storage);
  const trusted = await resolveProjectTrust({ cwd: project, records: () => storage, ask: async (a) => (asks.push(a), "skip"), signal: new AbortController().signal });
  return { first: first[0]!, asks, trusted, warm, storage };
}

const expectReask = (r: Awaited<ReturnType<typeof scenario>>) => {
  expect(r.warm).toBe(false);
  expect(r.asks).toHaveLength(1);
  expect(r.trusted).toBe(false);
  expect(r.asks[0]!.changes?.known).toBe(true);
};
const statusOf = (ask: ProjectTrustAsk) => [...(ask.changes?.status ?? new Map())].filter(([, s]) => s !== "unchanged");

// S1 (verifier, B1 recheck): files .pi/settings.json (or a package manifest) makes pi load are reviewed; editing one re-asks.
describe("S1 B1 settings targets", () => {
  test("extensions ../tools/ext.ts: listed with resolved path, edit re-asks and marks changed", async () => {
    write(join(project, "tools/ext.ts"), EXT);
    const r = await scenario({ extensions: ["../tools/ext.ts"] }, () => write(join(project, "tools/ext.ts"), EXT + "//x\n"));
    expectReask(r);
    expect(statusOf(r.asks[0]!)).toEqual([["tools/ext.ts", "changed"]]);
  });
  test("extensions outside the project (../../shared/ext.ts): absolute resolved path listed, edit re-asks", async () => {
    write(join(root, "shared/ext.ts"), EXT);
    const r = await scenario({ extensions: ["../../shared/ext.ts"] }, () => write(join(root, "shared/ext.ts"), EXT + "//x\n"));
    expect(r.first.resources.map((x) => x.path)).toContain(join(root, "shared/ext.ts"));
    expectReask(r);
  });
  test("extensions via ~/ path", async () => {
    write(join(home, "e/ext.ts"), EXT);
    const r = await scenario({ extensions: ["~/e/ext.ts"] }, () => write(join(home, "e/ext.ts"), EXT + "//x\n"));
    expectReask(r);
  });
  test("extensions via file:// URL", async () => {
    write(join(root, "u/ext.ts"), EXT);
    const r = await scenario({ extensions: [pathToFileURL(join(root, "u/ext.ts")).href] }, () => write(join(root, "u/ext.ts"), EXT + "//x\n"));
    expectReask(r);
  });
  test("extensions absolute path with surrounding spaces", async () => {
    write(join(root, "sp/ext.ts"), EXT);
    const r = await scenario({ extensions: [`  ${join(root, "sp/ext.ts")}  `] }, () => write(join(root, "sp/ext.ts"), EXT + "//x\n"));
    expectReask(r);
  });
  test("extensions folder with subfolder index.ts: edit re-asks", async () => {
    write(join(root, "extdir/a/index.ts"), EXT);
    const r = await scenario({ extensions: ["../../extdir"] }, () => write(join(root, "extdir/a/index.ts"), EXT + "//x\n"));
    expectReask(r);
  });
  test("extensions folder whose subfolder package.json points further out", async () => {
    write(join(root, "extdir/a/package.json"), JSON.stringify({ pi: { extensions: ["../../far/x.ts"] } }));
    write(join(root, "far/x.ts"), EXT);
    const r = await scenario({ extensions: ["../../extdir"] }, () => write(join(root, "far/x.ts"), EXT + "//x\n"));
    expectReask(r);
  });
  test(".pi/extensions/sub/package.json pointing outside the project", async () => {
    write(join(project, ".pi/extensions/sub/package.json"), JSON.stringify({ pi: { extensions: ["../../../../out/x.ts"] } }));
    write(join(root, "out/x.ts"), EXT);
    const r = await scenario({}, () => write(join(root, "out/x.ts"), EXT + "//x\n"));
    expectReask(r);
  });
  test("prompts path outside .pi", async () => {
    write(join(project, "myprompts/a.md"), "hi\n");
    const r = await scenario({ prompts: ["../myprompts"] }, () => write(join(project, "myprompts/a.md"), "evil\n"));
    expectReask(r);
  });
  test("skills old format { customDirectories }", async () => {
    write(join(project, "sk/a/SKILL.md"), "---\nname: a\ndescription: d\n---\n");
    const r = await scenario({ skills: { customDirectories: ["../sk"] } }, () => write(join(project, "sk/a/SKILL.md"), "---\nname: a\ndescription: evil\n---\n"));
    expectReask(r);
  });
  test("skills file path", async () => {
    write(join(project, "sk2/SKILL.md"), "---\nname: a\ndescription: d\n---\n");
    const r = await scenario({ skills: ["../sk2/SKILL.md"] }, () => write(join(project, "sk2/SKILL.md"), "---\nname: a\ndescription: evil\n---\n"));
    expectReask(r);
  });
  test("local package dir: manifest target outside the package", async () => {
    write(join(project, "pkg/package.json"), JSON.stringify({ name: "p", pi: { extensions: ["../shared/e.ts"] } }));
    write(join(project, "shared/e.ts"), EXT);
    const r = await scenario({ packages: ["../pkg"] }, () => write(join(project, "shared/e.ts"), EXT + "//x\n"));
    expectReask(r);
  });
  test("local package dir: manifest glob outside the package gains a file", async () => {
    write(join(project, "pkg/package.json"), JSON.stringify({ name: "p", pi: { extensions: ["../shared/*.ts"] } }));
    write(join(project, "shared/e.ts"), EXT);
    const r = await scenario({ packages: ["../pkg"] }, () => write(join(project, "shared/f.ts"), EXT));
    expectReask(r);
  });
  test("local package dir: manifest skills outside", async () => {
    write(join(project, "pkg/package.json"), JSON.stringify({ name: "p", pi: { skills: ["../../s"] } }));
    write(join(root, "s/x/SKILL.md"), "---\nname: x\ndescription: d\n---\n");
    const r = await scenario({ packages: ["../pkg"] }, () => write(join(root, "s/x/SKILL.md"), "---\nname: x\ndescription: e\n---\n"));
    expectReask(r);
  });
  test("local package conventional extensions/ folder subdir package.json pointing outside", async () => {
    write(join(project, "pkg/package.json"), JSON.stringify({ name: "p" }));
    write(join(project, "pkg/extensions/a/package.json"), JSON.stringify({ pi: { extensions: ["../../../far.ts"] } }));
    write(join(project, "far.ts"), EXT);
    const r = await scenario({ packages: ["../pkg"] }, () => write(join(project, "far.ts"), EXT + "//x\n"));
    expectReask(r);
  });
  test("local package as a single file, object form with filter", async () => {
    write(join(project, "single.ts"), EXT);
    const r = await scenario({ packages: [{ source: "../single.ts", extensions: [] }] }, () => write(join(project, "single.ts"), EXT + "//x\n"));
    expectReask(r);
  });
  test("npm package installed under .pi/npm (scoped, versioned)", async () => {
    write(join(project, ".pi/npm/node_modules/@s/foo/package.json"), JSON.stringify({ name: "@s/foo", version: "1.2.3", pi: { extensions: ["./index.ts"] } }));
    write(join(project, ".pi/npm/node_modules/@s/foo/index.ts"), EXT);
    const r = await scenario({ packages: ["npm:@s/foo@1.2.3"] }, () => write(join(project, ".pi/npm/node_modules/@s/foo/index.ts"), EXT + "//x\n"));
    expectReask(r);
  });
  test("npm package installed after trust (was missing): re-asks as added", async () => {
    const r = await scenario({ packages: ["npm:foo"] }, () => {
      write(join(project, ".pi/npm/node_modules/foo/package.json"), JSON.stringify({ name: "foo", version: "1.0.0" }));
      write(join(project, ".pi/npm/node_modules/foo/extensions/x.ts"), EXT);
    });
    expectReask(r);
  });
  test("git package under .pi/git: edit re-asks; .git internals do not", async () => {
    write(join(project, ".pi/git/github.com/u/r/package.json"), JSON.stringify({ name: "r" }));
    write(join(project, ".pi/git/github.com/u/r/extensions/x.ts"), EXT);
    write(join(project, ".pi/git/github.com/u/r/.git/HEAD"), "ref: x\n");
    const r = await scenario({ packages: ["git:github.com/u/r"] }, () => write(join(project, ".pi/git/github.com/u/r/extensions/x.ts"), EXT + "//x\n"));
    expectReask(r);
  });
  test("git package https source", async () => {
    write(join(project, ".pi/git/github.com/u/r/index.ts"), EXT);
    const r = await scenario({ packages: ["https://github.com/u/r"] }, () => write(join(project, ".pi/git/github.com/u/r/index.ts"), EXT + "//x\n"));
    expectReask(r);
  });
  test("extension target missing at trust, created later: re-asks as added", async () => {
    const r = await scenario({ extensions: ["../tools/late.ts"] }, () => write(join(project, "tools/late.ts"), EXT));
    expectReask(r);
    expect(statusOf(r.asks[0]!)).toEqual([["tools/late.ts", "added"]]);
  });
  test("extension target deleted after trust: re-asks with removed", async () => {
    write(join(project, "tools/gone.ts"), EXT);
    const r = await scenario({ extensions: ["../tools/gone.ts"] }, () => unlinkSync(join(project, "tools/gone.ts")));
    expectReask(r);
    expect(r.asks[0]!.changes?.removed).toContain("tools/gone.ts");
  });
  test("extensions symlinked folder: edit through the link target", async () => {
    write(join(root, "real/a.ts"), EXT);
    symlinkSync(join(root, "real"), join(project, "link"));
    const r = await scenario({ extensions: ["../link"] }, () => write(join(root, "real/a.ts"), EXT + "//x\n"));
    expectReask(r);
  });
  test("trusting again after the edit stores the new review; next turn loads without asking", async () => {
    write(join(project, "tools/ext.ts"), EXT);
    const r = await scenario({ extensions: ["../tools/ext.ts"] }, () => write(join(project, "tools/ext.ts"), EXT + "//x\n"));
    const t = await resolveProjectTrust({ cwd: project, records: () => r.storage, ask: async () => "trust", signal: new AbortController().signal });
    expect(t).toBe(true);
    const asks: ProjectTrustAsk[] = [];
    expect(await resolveProjectTrust({ cwd: project, records: () => r.storage, ask: async (a) => (asks.push(a), "skip"), signal: new AbortController().signal })).toBe(true);
    expect(asks).toHaveLength(0);
  });
  test("d after the edit stores untrusted; then never asks", async () => {
    write(join(project, "tools/ext.ts"), EXT);
    const r = await scenario({ extensions: ["../tools/ext.ts"] }, () => write(join(project, "tools/ext.ts"), EXT + "//x\n"));
    expect(await resolveProjectTrust({ cwd: project, records: () => r.storage, ask: async () => "distrust", signal: new AbortController().signal })).toBe(false);
    const asks: ProjectTrustAsk[] = [];
    expect(await resolveProjectTrust({ cwd: project, records: () => r.storage, ask: async (a) => (asks.push(a), "trust"), signal: new AbortController().signal })).toBe(false);
    expect(asks).toHaveLength(0);
    expect(r.storage.getProjectTrust(project)).toBe("untrusted");
  });
});
