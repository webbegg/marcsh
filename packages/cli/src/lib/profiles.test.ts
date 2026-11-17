import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeProfiles, createStarterProfiles, getSessionProfile, loadProfiles, parseProfiles, profilesPath, profilesWarning, setSessionProfile, writeDefaultProfile } from "./profiles";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-profiles-"));
  path = join(dir, "profiles.json");
});

afterEach(() => {
  setSessionProfile(undefined);
  rmSync(dir, { recursive: true, force: true });
});

const valid = {
  version: 1,
  default: "cheap",
  profiles: {
    cheap: {
      primary: { model: "anthropic/claude-sonnet-5-5", thinking: "low", fallback: [{ model: "openai/gpt-5", thinking: "high" }, "google/gemini"] },
      "review-*": { model: "anthropic/claude-haiku-5-5" },
      "*": { model: "anthropic/claude-haiku-5-5" },
      refuter: { model: "openai/gpt-5" },
    },
    deep: { primary: { model: "anthropic/claude-opus-5-5" } },
  },
};

describe("parseProfiles", () => {
  test("reads the documented format: routes, thinking, fallback chains (a plain string is a model) and the default", () => {
    const { file, problems } = parseProfiles(valid);
    expect(problems).toEqual([]);
    expect(file.default).toBe("cheap");
    expect(Object.keys(file.profiles)).toEqual(["cheap", "deep"]);
    expect(file.profiles.cheap!.primary).toEqual({
      model: "anthropic/claude-sonnet-5-5",
      thinking: "low",
      fallback: [{ model: "openai/gpt-5", thinking: "high" }, { model: "google/gemini" }],
    });
    expect(file.profiles.cheap!["review-*"]).toEqual({ model: "anthropic/claude-haiku-5-5" });
  });

  test("a file that is not an object, or has no version 1, is ignored whole and says why", () => {
    for (const raw of [[], "x", null, 3, { profiles: {} }, { version: 2, profiles: {} }, { version: 1, profiles: [] }]) {
      const { file, problems } = parseProfiles(raw);
      expect(file).toEqual({ version: 1, profiles: {} });
      expect(problems).toHaveLength(1);
    }
    expect(parseProfiles({ version: 2, profiles: {} }).problems[0]).toContain('"version" must be 1');
  });

  test("a wrong part is dropped and reported; the rest stays", () => {
    const { file, problems } = parseProfiles({
      version: 1,
      default: "nope",
      profiles: {
        "bad name!": { "*": { model: "a/b" } },
        notobject: 3,
        ok: {
          "": { model: "a/b" },
          "has space": { model: "a/b" },
          "*x": { model: "a/b" },
          nomodel: { thinking: "low" },
          badthinking: { model: "a/b", thinking: "loud" },
          good: { model: "a/b", fallback: [{ model: "" }, { model: "a/b" }, { model: "c/d" }, { model: "c/d" }, 5] },
          notalist: { model: "a/b", fallback: "c/d" },
        },
      },
    });
    expect(Object.keys(file.profiles)).toEqual(["ok"]);
    expect(Object.keys(file.profiles.ok!).sort()).toEqual(["badthinking", "good", "notalist"]);
    // The model itself and repeats are not fallbacks; thinking that is wrong is dropped, the route stays.
    expect(file.profiles.ok!.good).toEqual({ model: "a/b", fallback: [{ model: "c/d" }] });
    expect(file.profiles.ok!.badthinking).toEqual({ model: "a/b" });
    expect(file.default).toBeUndefined();
    const text = problems.join("\n");
    expect(text).toContain("bad name!");
    expect(text).toContain('profile "notobject" must be an object');
    expect(text).toContain('"has space"');
    expect(text).toContain("nomodel");
    expect(text).toContain('"thinking" must be one of');
    expect(text).toContain('"default" names profile "nope"');
  });

  test("keys that would reach Object.prototype are refused", () => {
    // JSON.parse makes `__proto__` an own key, which is how a file can carry one.
    const { file, problems } = parseProfiles(JSON.parse('{"version":1,"profiles":{"__proto__":{"*":{"model":"a/b"}},"p":{"constructor":{"model":"a/b"}}}}'));
    expect(Object.keys(file.profiles)).toEqual(["p"]);
    expect(Object.keys(file.profiles.p!)).toEqual([]);
    expect(problems.length).toBe(2);
    expect(({} as Record<string, unknown>).model).toBeUndefined();
  });

  test("a chain keeps at most 8 fallbacks", () => {
    const fallback = Array.from({ length: 12 }, (_, index) => ({ model: `p/m${index}` }));
    const { file, problems } = parseProfiles({ version: 1, profiles: { p: { "*": { model: "a/b", fallback } } } });
    expect(file.profiles.p!["*"]!.fallback).toHaveLength(8);
    expect(problems.join("\n")).toContain("at most 8");
  });
});

describe("loadProfiles", () => {
  test("a missing file is no profiles and no problem", () => {
    expect(loadProfiles(path)).toEqual({ file: { version: 1, profiles: {} }, problems: [], exists: false });
    expect(profilesWarning(loadProfiles(path), path)).toBeUndefined();
  });

  test("a file that is not JSON does not throw: no profiles, and a warning that names the file", () => {
    writeFileSync(path, "{ not json");
    const loaded = loadProfiles(path);
    expect(loaded.file).toEqual({ version: 1, profiles: {} });
    expect(loaded.exists).toBe(true);
    expect(profilesWarning(loaded, path)).toContain(path);
    expect(profilesWarning(loaded, path)).toContain("cannot be read");
  });

  test("a valid file loads", () => {
    writeFileSync(path, JSON.stringify(valid));
    const loaded = loadProfiles(path);
    expect(loaded.problems).toEqual([]);
    expect(loaded.file.default).toBe("cheap");
  });

  test("the warning lists at most three problems and counts the rest", () => {
    const warning = profilesWarning({ file: { version: 1, profiles: {} }, exists: true, problems: ["a", "b", "c", "d", "e"] }, "/x/profiles.json");
    expect(warning).toBe("/x/profiles.json: a; b; c; and 2 more. Whatever is invalid is ignored.");
  });
});

describe("profilesPath", () => {
  const saved = { profiles: process.env.MARCSH_PROFILES_PATH, prefs: process.env.MARCSH_PREFERENCES_PATH };
  afterEach(() => {
    for (const [key, value] of [["MARCSH_PROFILES_PATH", saved.profiles], ["MARCSH_PREFERENCES_PATH", saved.prefs]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("MARCSH_PROFILES_PATH wins; else the folder of the preferences file; an empty value is ignored", () => {
    process.env.MARCSH_PROFILES_PATH = "/somewhere/p.json";
    expect(profilesPath()).toBe("/somewhere/p.json");
    process.env.MARCSH_PROFILES_PATH = "  ";
    process.env.MARCSH_PREFERENCES_PATH = "/prefs/dir/preferences.json";
    expect(profilesPath()).toBe("/prefs/dir/profiles.json");
  });

  test("by default it is ~/.marcsh/profiles.json", () => {
    delete process.env.MARCSH_PROFILES_PATH;
    delete process.env.MARCSH_PREFERENCES_PATH;
    expect(profilesPath()).toMatch(/\.marcsh[\\/]profiles\.json$/);
  });
});

describe("writeDefaultProfile", () => {
  test("sets the default and keeps everything else in the file, leaving no temp file", () => {
    writeFileSync(path, JSON.stringify({ ...valid, default: undefined, extra: { keep: true } }));
    writeDefaultProfile("deep", path);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.default).toBe("deep");
    expect(written.extra).toEqual({ keep: true });
    expect(written.profiles.cheap.primary.model).toBe("anthropic/claude-sonnet-5-5");
    expect(readdirSync(dir)).toEqual(["profiles.json"]);
  });

  test("refuses, and leaves the file as it is, when it is missing, broken, or lacks the profile", () => {
    expect(() => writeDefaultProfile("deep", path)).toThrow("no profiles file");
    writeFileSync(path, "{ broken");
    expect(() => writeDefaultProfile("deep", path)).toThrow("is not valid JSON, so it was left as it is");
    expect(readFileSync(path, "utf8")).toBe("{ broken");
    writeFileSync(path, JSON.stringify(valid));
    expect(() => writeDefaultProfile("missing", path)).toThrow('no profile "missing"');
    expect(() => writeDefaultProfile("__proto__", path)).toThrow('no profile "__proto__"');
    expect(JSON.parse(readFileSync(path, "utf8")).default).toBe("cheap");
  });

  test("with no file nothing is created, not even its folder", () => {
    const nested = join(dir, "a", "b", "profiles.json");
    expect(() => writeDefaultProfile("x", nested)).toThrow("no profiles file");
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("the profiles in force", () => {
  const { file } = parseProfiles(valid);

  test("the session's profile comes first, then the default's; no choice is the default alone", () => {
    expect(activeProfiles(file, undefined).map((p) => [p.name, p.source])).toEqual([["cheap", "default"]]);
    expect(activeProfiles(file, "deep").map((p) => [p.name, p.source])).toEqual([["deep", "session"], ["cheap", "default"]]);
    // The same profile is not listed twice.
    expect(activeProfiles(file, "cheap").map((p) => [p.name, p.source])).toEqual([["cheap", "session"]]);
  });

  test("a session profile the file no longer has is skipped", () => {
    expect(activeProfiles(file, "gone").map((p) => p.name)).toEqual(["cheap"]);
  });

  test("/profile use is remembered for the run and cleared with undefined", () => {
    setSessionProfile("deep");
    expect(getSessionProfile()).toBe("deep");
    expect(activeProfiles(file)[0]!.name).toBe("deep");
    setSessionProfile(undefined);
    expect(getSessionProfile()).toBeUndefined();
  });
});

describe("createStarterProfiles (S17)", () => {
  const models = { engine: "pi", piModel: "openai/gpt-5", claudeModel: "sonnet" };

  test("creates the file, and the profile reader accepts it with one default profile", () => {
    const result = createStarterProfiles(models, path);
    expect(result).toEqual({ ok: true, path });
    const loaded = loadProfiles(path);
    expect(loaded.exists).toBe(true);
    expect(loaded.problems).toEqual([]);
    expect(loaded.file.default).toBe("default");
    expect(Object.keys(loaded.file.profiles)).toEqual(["default"]);
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
  });

  test("the profile uses the current models: the engine's own is the primary, the other engine's is a fallback that its engine skips", () => {
    createStarterProfiles(models, path);
    const onPi = loadProfiles(path).file.profiles.default!.primary!;
    expect(onPi.model).toBe("openai/gpt-5");
    expect(onPi.fallback?.map((step) => step.model)).toEqual(["sonnet"]);

    const other = join(dir, "claude.json");
    createStarterProfiles({ ...models, engine: "claude" }, other);
    const onClaude = loadProfiles(other).file.profiles.default!.primary!;
    expect(onClaude.model).toBe("sonnet");
    expect(onClaude.fallback?.map((step) => step.model)).toEqual(["openai/gpt-5"]);
  });

  test("an empty pi model falls back to pi's default model", () => {
    createStarterProfiles({ ...models, piModel: "" }, path);
    expect(loadProfiles(path).file.profiles.default!.primary!.model).toBe("anthropic/claude-opus-5-5");
  });

  test("the file explains itself in a top-level $comment, which the reader ignores, and /profile default keeps it", () => {
    createStarterProfiles(models, path);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(typeof raw.$comment).toBe("string");
    expect(raw.$comment).toContain("primary");
    expect(raw.$comment).toContain("/profile use");
    expect(loadProfiles(path).problems).toEqual([]);
    writeDefaultProfile("default", path);
    expect(JSON.parse(readFileSync(path, "utf8")).$comment).toBe(raw.$comment);
  });

  test("creates the parent folder when it is missing", () => {
    const nested = join(dir, "a", "b", "profiles.json");
    expect(createStarterProfiles(models, nested)).toEqual({ ok: true, path: nested });
    expect(loadProfiles(nested).problems).toEqual([]);
  });

  test("never overwrites: an existing file, even an empty or invalid one, stays as it is", () => {
    for (const content of ["", "not json", JSON.stringify({ version: 1, profiles: { mine: {} } })]) {
      writeFileSync(path, content);
      const result = createStarterProfiles(models, path);
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ ok: false, reason: "exists" });
      expect((result as { message: string }).message).toContain(path);
      expect((result as { message: string }).message).toContain("left as it is");
      expect(readFileSync(path, "utf8")).toBe(content);
    }
  });

  test("a dangling symlink at the path is not followed and not replaced", () => {
    const target = join(dir, "elsewhere.json");
    symlinkSync(target, path);
    expect(createStarterProfiles(models, path)).toMatchObject({ ok: false, reason: "exists" });
    expect(() => readFileSync(target)).toThrow();
  });

  test.skipIf(process.getuid?.() === 0)("a folder that cannot be written says permission denied, and where to point MARCSH_PROFILES_PATH", () => {
    const locked = join(dir, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      const result = createStarterProfiles(models, join(locked, "profiles.json"));
      expect(result).toMatchObject({ ok: false, reason: "denied" });
      expect((result as { message: string }).message).toContain("permission denied");
      expect((result as { message: string }).message).toContain("MARCSH_PROFILES_PATH");
      expect(readdirSync(locked)).toEqual([]);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  test("a path that is a folder, or under a file, reports the failure without throwing", () => {
    mkdirSync(path);
    expect(createStarterProfiles(models, path)).toMatchObject({ ok: false });
    const file = join(dir, "plain");
    writeFileSync(file, "x");
    expect(createStarterProfiles(models, join(file, "profiles.json"))).toMatchObject({ ok: false, reason: "failed" });
  });
});
