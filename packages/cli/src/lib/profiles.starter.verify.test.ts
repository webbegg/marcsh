import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// S17 / L6-Q3: the /profile starter file never overwrites anything and changes no routing until edited.
const root = mkdtempSync(join(tmpdir(), "marcsh-starter-verify-"));
const previousProfiles = process.env.MARCSH_PROFILES_PATH;
process.env.MARCSH_PREFERENCES_PATH = join(root, "prefs", "preferences.json");
delete process.env.MARCSH_PROFILES_PATH;
const { createStarterProfiles, loadProfiles, activeProfiles, profilesPath } = await import("./profiles");
const { runProfileCommand } = await import("./profiles-command");
const { resolveRoute } = await import("./model-routing");
const { agentModelFits } = await import("./agents");
afterAll(() => {
  try {
    chmodSync(join(root, "ro"), 0o755);
  } catch {}
  rmSync(root, { recursive: true, force: true });
  if (previousProfiles === undefined) delete process.env.MARCSH_PROFILES_PATH;
  else process.env.MARCSH_PROFILES_PATH = previousProfiles;
});

const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const models = (engine: string) => ({ engine, piModel: "openai/gpt-5", claudeModel: "sonnet" });
const env = (engine: string, path?: string) => ({
  engine,
  setPiModel: () => {
    throw new Error("the starter must not switch the model");
  },
  setClaudeModel: () => {
    throw new Error("the starter must not switch the model");
  },
  subagents: () => [],
  piModel: "openai/gpt-5",
  claudeModel: "sonnet",
  ...(path ? { path } : {}),
});
const fits = (engine: string) => ({ id: engine, fits: (model: string) => agentModelFits(model, engine) });

describe("createStarterProfiles never touches what is there", () => {
  test("an existing file keeps its bytes", () => {
    const path = join(root, "existing.json");
    writeFileSync(path, '{"version":1,"profiles":{"x":{}}}');
    const before = hash(path);
    const result = createStarterProfiles(models("pi"), path);
    expect(result).toEqual({ ok: false, reason: "exists", message: `A profiles file already exists at ${path}, so it was left as it is.` });
    expect(hash(path)).toBe(before);
  });

  test("a dangling symlink is never written through", () => {
    mkdirSync(join(root, "elsewhere"));
    const target = join(root, "elsewhere", "target.json");
    const path = join(root, "dangling.json");
    symlinkSync(target, path);
    const outcome = runProfileCommand({ kind: "create-starter" }, env("pi", path));
    expect("toast" in outcome && outcome.toast.variant).toBe("error");
    expect(existsSync(target)).toBe(false);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
  });

  test("a symlink to a file leaves the file as it is", () => {
    const target = join(root, "real.json");
    writeFileSync(target, "keep me");
    const path = join(root, "link.json");
    symlinkSync(target, path);
    expect(createStarterProfiles(models("pi"), path).ok).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("keep me");
  });

  test("a directory at the path is not offered and not touched", () => {
    const path = join(root, "dir.json");
    mkdirSync(path);
    writeFileSync(join(path, "inside"), "x");
    const shown = runProfileCommand({ kind: "show" }, env("pi", path));
    expect("create" in shown).toBe(false);
    expect(createStarterProfiles(models("pi"), path).ok).toBe(false);
    expect(readdirSync(path)).toEqual(["inside"]);
  });

  test("a folder that cannot be written gets the permission message and no file", () => {
    const folder = join(root, "ro");
    mkdirSync(folder);
    chmodSync(folder, 0o555);
    const path = join(folder, "profiles.json");
    const result = createStarterProfiles(models("pi"), path);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toBe(
      `Cannot create ${path}: permission denied. Fix the folder's permissions, or set MARCSH_PROFILES_PATH to a file you can write.`,
    );
    expect(existsSync(path)).toBe(false);
  });

  test("MARCSH_PROFILES_PATH is where it writes, and nowhere else", () => {
    const target = join(root, "custom", "my-profiles.json");
    process.env.MARCSH_PROFILES_PATH = target;
    try {
      expect(profilesPath()).toBe(target);
      const outcome = runProfileCommand({ kind: "create-starter" }, env("pi"));
      expect("show" in outcome).toBe(true);
      expect(readdirSync(join(root, "custom"))).toEqual(["my-profiles.json"]);
      expect(existsSync(join(root, "prefs", "profiles.json"))).toBe(false);
      expect(loadProfiles(target).problems).toEqual([]);
    } finally {
      delete process.env.MARCSH_PROFILES_PATH;
    }
  });
});

describe("the starter changes no routing", () => {
  for (const madeOn of ["pi", "claude"]) {
    test(`made on ${madeOn}: no engine gets a fallback, a thinking level or a subagent route`, () => {
      const path = join(root, `starter-${madeOn}.json`);
      expect(createStarterProfiles(models(madeOn), path).ok).toBe(true);
      const active = activeProfiles(loadProfiles(path).file, undefined);
      for (const engine of ["pi", "claude"]) {
        const primary = resolveRoute({ active, engine: fits(engine) });
        expect(primary.thinking).toBeUndefined();
        expect(primary.fallback).toEqual([]);
        expect(resolveRoute({ active, name: "reviewer", engine: fits(engine) }).source.kind).toBe("turn");
        expect(resolveRoute({ active, name: "reviewer", agentModel: "haiku", engine: fits("claude") }).source.kind).toBe("agent");
      }
    });
  }
});
