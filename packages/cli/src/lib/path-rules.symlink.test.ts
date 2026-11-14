import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isScratchPath } from "./command-classifier";
import { matchesPathRule, pathRuleCandidate } from "./path-rules";

// A project with a rule folder `dist`, and a folder outside it that symlinks inside `dist` point at.
const root = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-symlink-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const project = join(root, "proj");
const dist = join(project, "dist");
const outside = join(root, "outside");
mkdirSync(join(dist, "real"), { recursive: true });
mkdirSync(outside);
writeFileSync(join(outside, "keep"), "1");
writeFileSync(join(dist, "real", "f"), "1");
symlinkSync(outside, join(dist, "h"));
symlinkSync(join(outside, "keep"), join(dist, "file-link"));
const rule = { program: "rm", dir: dist };

describe("a folder rule never reaches through a symlink to outside its folder", () => {
  test("targets under, or on, a symlink that points outside do not match", () => {
    for (const command of [`rm -rf ${dist}/h/*`, "rm -rf dist/h/keep", "rm -rf dist/h/", "rm dist/h/keep"]) {
      expect([command, matchesPathRule(command, project, rule)]).toEqual([command, false]);
    }
    // The source is inside the folder, so only the link as destination can make these fail.
    for (const program of ["cp", "mv"]) {
      expect(matchesPathRule(`${program} dist/real/f dist/real/g`, project, { ...rule, program })).toBe(true);
      for (const command of [`${program} dist/real/f dist/file-link`, `${program} dist/real/f dist/h`]) {
        expect([command, matchesPathRule(command, project, { ...rule, program })]).toEqual([command, false]);
      }
    }
  });

  test("a glob in a folder that holds a symlink to outside does not match", () => {
    expect(matchesPathRule("rm -rf dist/*", project, rule)).toBe(false);
  });

  test("find that follows symlinks does not match", () => {
    expect(matchesPathRule("find dist/real -delete", project, { ...rule, program: "find" })).toBe(true);
    expect(matchesPathRule("find dist/real -follow -delete", project, { ...rule, program: "find" })).toBe(false);
  });

  test("real paths inside the folder still match, and a symlink to outside is not offered as a rule", () => {
    expect(matchesPathRule("rm -rf dist/real/f", project, rule)).toBe(true);
    expect(matchesPathRule("rm -rf dist/real/*", project, rule)).toBe(true);
    expect(matchesPathRule("rm -rf dist/new-file", project, rule)).toBe(true);
    // The folders offered are the ones the target really is in, never the link or the folder holding it.
    const offered = pathRuleCandidate("rm -rf dist/h/keep", project)?.dirs ?? [];
    expect(offered).not.toContain(dist);
    expect(offered).not.toContain(join(dist, "h"));
    expect(offered[0]).toBe(root);
  });

  test("a rule folder reached through a symlink the user owns never matches, even when it still points inside", () => {
    expect(matchesPathRule("rm -rf dist/h/keep", project, { program: "rm", dir: join(dist, "h") })).toBe(false);
  });
});

describe("scratch deletes never reach through a symlink", () => {
  test("a path under, or on, a symlink in the temp folder that points outside it is not scratch", () => {
    // Not realpath'd: scratch paths are written under $TMPDIR as the shell sees it.
    const scratch = mkdtempSync(join(tmpdir(), "marcsh-scratch-"));
    try {
      // Only checked, never deleted.
      symlinkSync(homedir(), join(scratch, "h"));
      symlinkSync(outside, join(scratch, "t"));
      expect(isScratchPath(join(scratch, "h", "keep"))).toBe(false);
      expect(isScratchPath(join(scratch, "h"))).toBe(false);
      // A link to another temp folder is still scratch.
      expect(isScratchPath(join(scratch, "t", "keep"))).toBe(true);
      expect(isScratchPath(join(scratch, "plain", "x"))).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
