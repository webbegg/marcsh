import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAgentId,
  getDefaultEngine,
  getFavoriteModels,
  getNotifyMode,
  getPiModel,
  getRecentModels,
  preferencesPath,
  readPreferences,
  recordRecentModel,
  setAgentId,
  setDefaultEngine,
  setFavoriteModels,
  setLaunchEngine,
  setPiModel,
  updatePreferences,
} from "./preferences";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-prefs-"));
  path = join(dir, "nested", "preferences.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const writeRaw = (text: string) => {
  mkdirSync(join(dir, "nested"), { recursive: true });
  writeFileSync(path, text, "utf8");
};

describe("agent preference", () => {
  test("is unset when there is no preferences file", () => {
    expect(getAgentId(path)).toBeUndefined();
  });

  test("a change is persisted and read back, keeping the other preferences", () => {
    setDefaultEngine("claude", path);
    setAgentId("user/reviewer", path);
    expect(getAgentId(path)).toBe("user/reviewer");
    expect(getDefaultEngine(path)).toBe("claude");
  });

  test("a stored value that is not a string is ignored", () => {
    writeRaw(JSON.stringify({ agent: 42 }));
    expect(getAgentId(path)).toBeUndefined();
  });
});

describe("default engine preference", () => {
  test("is pi when there is no preferences file", () => {
    expect(getDefaultEngine(path)).toBe("pi");
  });

  test("is pi when preferences exist but hold no engine", () => {
    writeRaw(JSON.stringify({ themeName: "nord" }));
    expect(getDefaultEngine(path)).toBe("pi");
  });

  test("an explicit stored claude is kept", () => {
    writeRaw(JSON.stringify({ defaultEngine: "claude" }));
    expect(getDefaultEngine(path)).toBe("claude");
  });

  test("a change is persisted and read back, creating the directory", () => {
    setDefaultEngine("pi", path);

    expect(getDefaultEngine(path)).toBe("pi");
    expect(JSON.parse(readFileSync(path, "utf8")).defaultEngine).toBe("pi");

    setDefaultEngine("claude", path);
    expect(getDefaultEngine(path)).toBe("claude");
  });

  test("an unknown stored value falls back to the default (pi)", () => {
    writeRaw(JSON.stringify({ defaultEngine: "gpt" }));
    expect(getDefaultEngine(path)).toBe("pi");

    writeRaw(JSON.stringify({ defaultEngine: 7 }));
    expect(getDefaultEngine(path)).toBe("pi");
  });

  test("a broken preferences file falls back to the default (pi)", () => {
    writeRaw("{not json");
    expect(getDefaultEngine(path)).toBe("pi");

    writeRaw("[]");
    expect(getDefaultEngine(path)).toBe("pi");
  });

  test("setting it keeps the other preferences, and updating them keeps the engine", () => {
    writeRaw(JSON.stringify({ themeName: "nord" }));

    setDefaultEngine("pi", path);
    expect(readPreferences(path)).toEqual({ themeName: "nord", defaultEngine: "pi" });

    updatePreferences({ themeName: "dracula" }, path);
    expect(readPreferences(path)).toEqual({ themeName: "dracula", defaultEngine: "pi" });
  });

  test("a failing write is ignored", () => {
    // The parent of the file is a regular file, so the directory cannot be created.
    writeFileSync(join(dir, "blocker"), "x", "utf8");
    expect(() => setDefaultEngine("pi", join(dir, "blocker", "preferences.json"))).not.toThrow();
  });
});

describe("pi model preference", () => {
  test("is unset when there is no preferences file", () => {
    expect(getPiModel(path)).toBeUndefined();
  });

  test("a choice is persisted as piModel and read back, next to the other preferences", () => {
    writeRaw(JSON.stringify({ themeName: "nord", defaultEngine: "pi" }));

    setPiModel("openai/gpt-5", path);

    expect(getPiModel(path)).toBe("openai/gpt-5");
    expect(readPreferences(path)).toEqual({ themeName: "nord", defaultEngine: "pi", piModel: "openai/gpt-5" });
  });

  test("a stored value that is not a provider/id ref is ignored", () => {
    for (const bad of [7, "", "opus", "/x", "x/", null]) {
      writeRaw(JSON.stringify({ piModel: bad }));
      expect(getPiModel(path)).toBeUndefined();
    }
    writeRaw("{not json");
    expect(getPiModel(path)).toBeUndefined();
  });
});

describe("preferencesPath", () => {
  test("defaults to ~/.marcsh/preferences.json and can be overridden for tests", () => {
    const previous = process.env.MARCSH_PREFERENCES_PATH;
    try {
      delete process.env.MARCSH_PREFERENCES_PATH;
      expect(preferencesPath()).toBe(join(homedir(), ".marcsh", "preferences.json"));

      process.env.MARCSH_PREFERENCES_PATH = " /tmp/x/prefs.json ";
      expect(preferencesPath()).toBe("/tmp/x/prefs.json");

      process.env.MARCSH_PREFERENCES_PATH = "  ";
      expect(preferencesPath()).toBe(join(homedir(), ".marcsh", "preferences.json"));
    } finally {
      if (previous === undefined) delete process.env.MARCSH_PREFERENCES_PATH;
      else process.env.MARCSH_PREFERENCES_PATH = previous;
    }
  });
});

describe("launch engine override", () => {
  afterEach(() => setLaunchEngine(undefined));

  test("wins over the stored engine for this process and writes nothing", () => {
    setDefaultEngine("pi", path);
    const before = readFileSync(path, "utf8");

    setLaunchEngine("claude");

    expect(getDefaultEngine(path)).toBe("claude");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("clearing it brings the stored engine back", () => {
    setDefaultEngine("claude", path);
    setLaunchEngine("pi");
    setLaunchEngine(undefined);

    expect(getDefaultEngine(path)).toBe("claude");
  });

  test("choosing an engine afterwards replaces the override", () => {
    setLaunchEngine("claude");
    setDefaultEngine("pi", path);

    expect(getDefaultEngine(path)).toBe("pi");
  });
});

describe("favorite and recent models", () => {
  test("are empty when there is no preferences file", () => {
    expect(getFavoriteModels("claude", path)).toEqual([]);
    expect(getRecentModels("pi", path)).toEqual([]);
  });

  test("favorites are kept per engine, next to the other preferences", () => {
    setDefaultEngine("claude", path);
    setFavoriteModels("claude", ["opus", "haiku"], path);
    setFavoriteModels("pi", ["anthropic/claude-opus-5-5"], path);

    expect(getFavoriteModels("claude", path)).toEqual(["opus", "haiku"]);
    expect(getFavoriteModels("pi", path)).toEqual(["anthropic/claude-opus-5-5"]);
    expect(getDefaultEngine(path)).toBe("claude");
  });

  test("a recorded model goes first, once, and only the last 5 stay, per engine", () => {
    for (const model of ["a", "b", "c", "d", "e", "f"]) recordRecentModel("claude", model, path);
    recordRecentModel("claude", "d", path);
    recordRecentModel("pi", "x/y", path);

    expect(getRecentModels("claude", path)).toEqual(["d", "f", "e", "c", "b"]);
    expect(getRecentModels("pi", path)).toEqual(["x/y"]);
  });

  test("an older preferences file without them still loads", () => {
    writeRaw(JSON.stringify({ themeName: "dark", defaultEngine: "claude", piModel: "a/b" }));
    expect(getFavoriteModels("claude", path)).toEqual([]);
    expect(getRecentModels("claude", path)).toEqual([]);
    expect(getDefaultEngine(path)).toBe("claude");
    expect(getPiModel(path)).toBe("a/b");
  });

  test("stored values of the wrong shape are ignored; the good ones in the list stay", () => {
    writeRaw(JSON.stringify({ favoriteModels: ["opus"], recentModels: { claude: ["opus", 3, null, "opus", "sonnet"], pi: "x/y", other: ["z"] } }));
    expect(getFavoriteModels("claude", path)).toEqual([]);
    expect(getRecentModels("claude", path)).toEqual(["opus", "sonnet"]);
    expect(getRecentModels("pi", path)).toEqual([]);
  });

  test("setLaunchEngine keeps working next to them", () => {
    setFavoriteModels("claude", ["opus"], path);
    setLaunchEngine("claude");
    expect(getDefaultEngine(path)).toBe("claude");
    expect(getFavoriteModels("claude", path)).toEqual(["opus"]);
    setLaunchEngine(undefined);
  });
});

describe("notify preference", () => {
  test("is the bell by default", () => {
    expect(getNotifyMode(path)).toBe("bell");
  });

  test.each(["bell", "system", "off"] as const)("reads %s", (mode) => {
    updatePreferences({ notify: mode }, path);
    expect(getNotifyMode(path)).toBe(mode);
  });

  test("a value that is not one of them is the bell", () => {
    writeRaw(JSON.stringify({ notify: "loud" }));
    expect(getNotifyMode(path)).toBe("bell");
    writeRaw(JSON.stringify({ notify: false }));
    expect(getNotifyMode(path)).toBe("bell");
  });
});
