import { describe, expect, test } from "bun:test";
import { isWithinSurfaces, normalizeSurfaces, surfacesOverlap, validateSurfaces } from "./edit-surfaces";

// The paths and globs a bounded writer may touch: narrow, repository-relative, and disjoint between parallel writers.

describe("validateSurfaces", () => {
  test("a missing or empty list is a problem", () => {
    expect(validateSurfaces(undefined)).toHaveLength(1);
    expect(validateSurfaces([])).toHaveLength(1);
  });

  test("accepts narrow paths and globs", () => {
    expect(validateSurfaces(["src/auth/**", "tests/auth.test.ts", "docs/guide.md", "src/*.ts"])).toEqual([]);
    expect(validateSurfaces(["./src/a.ts"])).toEqual([]);
  });

  test("rejects the repository root in every spelling, naming the entry", () => {
    for (const root of [".", "./", ".//", "./.", "*", "**", "**/*", "./**", "./*", " . ", "**/**", "**/**/*", "./**/**", "**/**/**"]) {
      const problems = validateSurfaces([root]);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`"${root}"`);
      expect(problems[0]).toContain("whole repository");
    }
  });

  test("rejects absolute paths and home paths", () => {
    for (const absolute of ["/etc/hosts", "/", "C:\\x\\y", "C:/x", "~/notes.md", "~"]) {
      const problems = validateSurfaces([absolute]);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`"${absolute}"`);
      expect(problems[0]).toContain("repository-relative");
    }
  });

  test("rejects `..` anywhere in the path", () => {
    for (const escaping of ["../other", "src/../../x", "src/..", "a\\..\\b"]) {
      const problems = validateSurfaces([escaping]);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`"${escaping}"`);
      expect(problems[0]).toContain("..");
    }
  });

  test("rejects empty and blank entries, and non-strings", () => {
    expect(validateSurfaces([""])[0]).toContain("empty");
    expect(validateSurfaces(["   "])[0]).toContain("empty");
    expect(validateSurfaces(["src/a.ts", 3 as never])[0]).toContain("3");
  });

  test("reports every bad entry, not only the first", () => {
    const problems = validateSurfaces(["src/ok.ts", ".", "/abs", "../up"]);
    expect(problems).toHaveLength(3);
  });
});

describe("normalizeSurfaces", () => {
  test("trims, drops a leading ./ and trailing slashes, and uses forward slashes", () => {
    expect(normalizeSurfaces([" ./src/a.ts ", "tests/", "a\\b\\c.ts"])).toEqual(["src/a.ts", "tests", "a/b/c.ts"]);
  });

  test("drops an inner ./ and doubled slashes, so each path has one spelling", () => {
    expect(normalizeSurfaces(["src/./a.ts", "src//a.ts", "./src/./sub//", "src/**/./x"])).toEqual(["src/a.ts", "src/a.ts", "src/sub", "src/**/x"]);
    expect(isWithinSurfaces("src/a.ts", ["src/./a.ts"])).toBe(true);
    expect(isWithinSurfaces("src//a.ts", ["src/a.ts"])).toBe(true);
  });
});

describe("isWithinSurfaces", () => {
  test("a plain entry matches the file or anything under that directory, never a sibling with the same prefix", () => {
    expect(isWithinSurfaces("src/auth/login.ts", ["src/auth"])).toBe(true);
    expect(isWithinSurfaces("src/auth", ["src/auth"])).toBe(true);
    expect(isWithinSurfaces("src/authz.ts", ["src/auth"])).toBe(false);
    expect(isWithinSurfaces("src/b.ts", ["src/a.ts"])).toBe(false);
  });

  test("globs: ** crosses directories, * does not", () => {
    expect(isWithinSurfaces("src/auth/deep/x.ts", ["src/auth/**"])).toBe(true);
    expect(isWithinSurfaces("src/a.ts", ["src/*.ts"])).toBe(true);
    expect(isWithinSurfaces("src/sub/a.ts", ["src/*.ts"])).toBe(false);
    expect(isWithinSurfaces("src/sub/a.ts", ["src/**/*.ts"])).toBe(true);
    expect(isWithinSurfaces("src/a.ts", ["src/**/*.ts"])).toBe(true);
  });

  test("a leading ./ on the path is ignored", () => {
    expect(isWithinSurfaces("./tests/a.test.ts", ["tests/a.test.ts"])).toBe(true);
  });

  test("any surface is enough", () => {
    expect(isWithinSurfaces("tests/x.ts", ["src/a.ts", "tests"])).toBe(true);
    expect(isWithinSurfaces("README.md", ["src/a.ts", "tests"])).toBe(false);
  });
});

describe("surfacesOverlap", () => {
  test("disjoint paths and globs do not overlap", () => {
    expect(surfacesOverlap(["src/a.ts"], ["src/b.ts"])).toBeUndefined();
    expect(surfacesOverlap(["src/auth/**"], ["src/billing/**"])).toBeUndefined();
    expect(surfacesOverlap(["src/auth"], ["src/authz"])).toBeUndefined();
  });

  test("a directory and a file under it overlap, in either order, and the message names both entries", () => {
    expect(surfacesOverlap(["src/**"], ["src/a.ts"])).toContain('"src/**"');
    expect(surfacesOverlap(["src/a.ts"], ["src/**"])).toContain('"src/a.ts"');
    expect(surfacesOverlap(["src/auth"], ["src/auth/login.ts"])).toContain('"src/auth/login.ts"');
  });

  test("the same entry overlaps itself, and a leading ./ does not hide it", () => {
    expect(surfacesOverlap(["src/a.ts"], ["./src/a.ts"])).toBeDefined();
  });

  test("an inner ./ or a doubled slash does not hide an overlap", () => {
    expect(surfacesOverlap(["src//a"], ["src/a"])).toBeDefined();
    expect(surfacesOverlap(["src/./a.ts"], ["src/a.ts"])).toBeDefined();
    expect(surfacesOverlap(["src/./a"], ["src/b"])).toBeUndefined();
  });

  test("it is conservative: two globs in one directory may be reported", () => {
    expect(surfacesOverlap(["src/*.ts"], ["src/*.js"])).toBeDefined();
  });
});
