import { describe, expect, test } from "bun:test";
import { getFilteredCommands, getMenuCommands, groupOf } from "./filter-commands";
import type { Command } from "./types";
import type { UserCommand } from "../../lib/user-commands";

const command = (name: string): Command => ({ name, description: name, value: `/${name}` });
const names = (query: string, list: Command[]) => getFilteredCommands(query, list).map((c) => c.name);

const MENU = ["new", "agents", "models", "sessions", "theme", "exit", "marcsh:feature", "marcsh:workflow", "review"].map(command);

describe("pack commands in the menu (M2)", () => {
  const spec: UserCommand = {
    name: "spec",
    description: "Write a spec",
    template: "x",
    agent: "asdd",
    argumentHint: "[spec slug]",
    source: "pack",
    pack: "acme/flows",
    engineName: "acme-flows:spec",
  };

  test("listed with the pack's name as its source and its argument hint", () => {
    const entry = getMenuCommands([], [spec]).find((command) => command.name === "spec");
    expect(entry).toMatchObject({ name: "spec", value: "/spec", description: "Write a spec", argumentHint: "[spec slug]", source: "flows" });
  });

  test("the engine's own copy of it is not listed a second time: Claude's plugin name or pi's template name", () => {
    const claude = [{ name: "acme-flows:spec", description: "Write a spec", argumentHint: "" }, { name: "acme-flows:ship", description: "Ship", argumentHint: "" }];
    const pi = [{ name: "spec", description: "Write a spec", argumentHint: "", source: "prompt" }];
    const names = (list: Command[]) => list.map((command) => command.name);
    // The list is ordered by group (marcsh, packs & custom, engine) so the `/` menu can head each group: the pack's `spec` comes before Claude's `ship`.
    expect(names(getMenuCommands(claude, [spec])).filter((name) => name.includes("spec") || name.includes("ship"))).toEqual(["spec", "acme-flows:ship"]);
    expect(getMenuCommands(pi, [spec]).filter((command) => command.name === "spec")).toEqual([expect.objectContaining({ source: "flows" })]);
  });

  test("a hidden pack command's engine copy is not listed either (T8 d)", () => {
    const hidden: UserCommand = { ...spec, name: "review", engineName: "zed-flows:review", pack: "zed/flows" };
    const claude = [{ name: "zed-flows:review", description: "Review", argumentHint: "" }, { name: "zed-flows:ship", description: "Ship", argumentHint: "" }];
    const listed = getMenuCommands(claude, [spec], true, [hidden]).map((command) => command.name);
    expect(listed).not.toContain("zed-flows:review");
    expect(listed).toContain("zed-flows:ship");
  });

  test("a user's own command keeps an empty hint unless its file gives one", () => {
    const own: UserCommand = { name: "mine", description: "d", template: "x", source: "personal" };
    expect(getMenuCommands([], [own]).find((command) => command.name === "mine")).toMatchObject({ argumentHint: "", source: "personal" });
  });
});

describe("fuzzy command filter", () => {
  test("an empty query keeps every command in its original order", () => {
    expect(names("", MENU)).toEqual(MENU.map((c) => c.name));
  });

  test("matches characters in order anywhere in the name", () => {
    expect(names("feat", MENU)).toEqual(["marcsh:feature"]);
    // workflow has an f too, but feature's f starts a word, so it ranks first.
    expect(names("mf", MENU)).toEqual(["marcsh:feature", "marcsh:workflow"]);
    expect(names("mwf", MENU)).toEqual(["marcsh:workflow"]);
  });

  test("is case-insensitive", () => {
    expect(names("FEAT", MENU)).toEqual(["marcsh:feature"]);
  });

  test("drops commands that do not contain the characters in order", () => {
    expect(names("zzz", MENU)).toEqual([]);
    expect(names("fm", MENU)).toEqual([]);
  });

  test("ranks prefix matches above scattered matches", () => {
    // "models" starts with "mo"; "marcsh:workflow" only has m…o spread out.
    expect(names("mo", MENU)).toEqual(["models", "marcsh:workflow"]);
  });

  test("ranks word-start and consecutive matches above scattered ones", () => {
    const list = ["marcsh:workflow", "marcsh:feature", "mirror-sweep"].map(command);
    // "w" right after ":" in marcsh:workflow beats the w buried in mirror-sweep.
    expect(names("mw", list)).toEqual(["marcsh:workflow", "mirror-sweep"]);
  });

  test("keeps the original order between equally good matches", () => {
    const list = ["alpha-one", "alpha-two"].map(command);
    expect(names("alpha", list)).toEqual(["alpha-one", "alpha-two"]);
  });
});

describe("the engine hides commands that do not work on it (S16)", () => {
  const listed = (engine?: string) => getMenuCommands([], [], true, [], engine).map((entry) => entry.name);

  test("/login and /logout are hidden on claude, kept on pi", () => {
    expect(listed("claude")).not.toContain("login");
    expect(listed("claude")).not.toContain("logout");
    expect(listed("pi")).toEqual(expect.arrayContaining(["login", "logout"]));
  });

  test("no engine given: nothing is filtered", () => {
    expect(listed()).toEqual(expect.arrayContaining(["login", "logout"]));
    expect(listed().length).toBe(listed("pi").length);
  });

  test("the other commands stay on both engines", () => {
    expect(listed("claude").length).toBe(listed("pi").length - 2);
    expect(listed("claude")).toContain("new");
  });
});

describe("groups of the `/` menu (S16)", () => {
  test("marcsh's own commands, pack and custom commands, and the engine's", () => {
    expect(groupOf(command("new"))).toBe("marcsh");
    expect(groupOf({ ...command("spec"), source: "flows" , })).toBe("packs & custom");
    expect(groupOf({ ...command("mine"), source: "personal" })).toBe("packs & custom");
    expect(groupOf({ ...command("proj"), source: "project" })).toBe("packs & custom");
    expect(groupOf({ ...command("init"), source: "claude" })).toBe("claude");
    for (const source of ["extension", "prompt", "skill"]) expect(groupOf({ ...command("x"), source })).toBe("pi");
  });

  test("the list is ordered marcsh, packs & custom, then the engine's, whatever the names", () => {
    const user: UserCommand[] = [
      { name: "zeta", description: "z", template: "x", source: "personal" },
      { name: "pack-cmd", description: "p", template: "x", source: "pack", pack: "acme/flows", engineName: "acme-flows:pack-cmd" },
    ];
    const claude = [{ name: "alpha", description: "a", argumentHint: "" }, { name: "init", description: "i", argumentHint: "" }];
    const groups = getMenuCommands(claude, user).map(groupOf);
    expect(groups.indexOf("packs & custom")).toBeGreaterThan(groups.lastIndexOf("marcsh"));
    expect(groups.indexOf("claude")).toBeGreaterThan(groups.lastIndexOf("packs & custom"));
    expect(groups).toEqual([...groups].sort((a, b) => ["marcsh", "packs & custom", "claude"].indexOf(a) - ["marcsh", "packs & custom", "claude"].indexOf(b)));
  });
});
