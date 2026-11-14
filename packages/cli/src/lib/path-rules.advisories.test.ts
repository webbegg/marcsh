import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesPathRule } from "./path-rules";

// Advisories of the branch review: R1-003 (a `.GIT` segment never matches) and the R3 re-review (cp/mv into a folder holding a link).
const root = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-rules-advisories-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const project = join(root, "proj");
const dir = join(project, "dir");
const outside = join(root, "outside");
mkdirSync(join(dir, "a"), { recursive: true });
mkdirSync(join(dir, "b"), { recursive: true });
mkdirSync(join(dir, "c"), { recursive: true });
mkdirSync(outside);
writeFileSync(join(dir, "a", "f"), "1");
writeFileSync(join(dir, "a", "g"), "1");
// `dir/b/f` leads outside, `dir/c` holds no link.
symlinkSync(outside, join(dir, "b", "f"));

describe("a .GIT segment never matches a rule, like .git (R1-003)", () => {
  test("any case of .git is refused, other names still match", () => {
    for (const program of ["rm", "mv", "cp"]) {
      const rule = { program, dir };
      const args = program === "rm" ? "" : "dir/a/f ";
      for (const name of [".git", ".GIT", ".Git"]) {
        const command = `${program} ${args}dir/c/${name}/hooks/x`;
        expect([command, matchesPathRule(command, project, rule)]).toEqual([command, false]);
        const last = `${program} ${args}dir/c/${name}`;
        expect([last, matchesPathRule(last, project, rule)]).toEqual([last, false]);
      }
      const ok = `${program} ${args}dir/c/ok`;
      expect([ok, matchesPathRule(ok, project, rule)]).toEqual([ok, true]);
    }
  });
});

describe("cp and mv also cover <dest>/<basename(src)> (R3 re-review)", () => {
  const cp = { program: "cp", dir };
  const mv = { program: "mv", dir };

  test("a destination folder holding a link to outside under the source's name does not match", () => {
    expect(matchesPathRule("cp dir/a/f dir/b", project, cp)).toBe(false);
    expect(matchesPathRule("cp dir/a/f dir/b/", project, cp)).toBe(false);
    expect(matchesPathRule("mv dir/a/f dir/b", project, mv)).toBe(false);
  });

  test("without the link the command still matches", () => {
    expect(matchesPathRule("cp dir/a/f dir/c", project, cp)).toBe(true);
    expect(matchesPathRule("cp dir/a/f dir/a/g dir/c", project, cp)).toBe(true);
    expect(matchesPathRule("mv dir/a/f dir/c", project, mv)).toBe(true);
    // `dir/b/g` is not a link.
    expect(matchesPathRule("cp dir/a/g dir/b", project, cp)).toBe(true);
  });
});
