import { describe, expect, test } from "bun:test";
import { combineClaudeCommands, mergeCommands, normalizeClaudeCommands, slashInputKind } from "./claude-commands";

const OWN = ["new", "agents", "models", "sessions", "theme", "exit"];

describe("normalizeClaudeCommands", () => {
  test("keeps name, description and argument hint, and drops aliases and the builtin flag", () => {
    const list = normalizeClaudeCommands([
      { name: "probe:hello", description: "Say hello", argumentHint: "<who>", aliases: ["hi"], builtin: false },
    ]);

    expect(list).toEqual([{ name: "probe:hello", description: "Say hello", argumentHint: "<who>" }]);
  });

  test("strips a leading slash, trims, and fills missing text with empty strings", () => {
    const list = normalizeClaudeCommands([{ name: " /review " }, { name: "/plain", description: 3, argumentHint: null }]);

    expect(list).toEqual([
      { name: "review", description: "", argumentHint: "" },
      { name: "plain", description: "", argumentHint: "" },
    ]);
  });

  test("skips entries without a usable name and non-array input", () => {
    expect(normalizeClaudeCommands([null, 4, {}, { name: "" }, { name: "/" }, { name: "ok" }])).toEqual([
      { name: "ok", description: "", argumentHint: "" },
    ]);
    expect(normalizeClaudeCommands("nope")).toEqual([]);
    expect(normalizeClaudeCommands(undefined)).toEqual([]);
  });

  test("dedupes by name, preferring the builtin row, otherwise the first", () => {
    const list = normalizeClaudeCommands([
      { name: "dup", description: "first", argumentHint: "" },
      { name: "dup", description: "second", argumentHint: "", builtin: true },
      { name: "other", description: "a", argumentHint: "" },
      { name: "other", description: "b", argumentHint: "" },
    ]);

    expect(list).toEqual([
      { name: "dup", description: "second", argumentHint: "" },
      { name: "other", description: "a", argumentHint: "" },
    ]);
  });
});

describe("mergeCommands", () => {
  const entry = (c: { name: string; description: string }) => ({ name: c.name, description: c.description, claude: true });
  const own = OWN.map((name) => ({ name, description: `own ${name}`, claude: false }));

  test("lists marcsh commands first, then Claude commands sorted by name", () => {
    const merged = mergeCommands(
      own,
      [
        { name: "zeta", description: "", argumentHint: "" },
        { name: "alpha", description: "", argumentHint: "" },
        { name: "probe:hello", description: "", argumentHint: "" },
      ],
      entry,
    );

    expect(merged.map((c) => c.name)).toEqual([...OWN, "alpha", "probe:hello", "zeta"]);
  });

  test("marcsh wins a name clash, whatever the case", () => {
    const merged = mergeCommands(
      own,
      [
        { name: "new", description: "claude new", argumentHint: "" },
        { name: "Theme", description: "claude theme", argumentHint: "" },
        { name: "keep", description: "kept", argumentHint: "" },
      ],
      entry,
    );

    expect(merged.filter((c) => c.name.toLowerCase() === "new")).toEqual([own[0]!]);
    expect(merged.find((c) => c.name === "Theme")).toBeUndefined();
    expect(merged.at(-1)).toEqual({ name: "keep", description: "kept", claude: true });
  });

  test("does not mutate its inputs", () => {
    const claude = [
      { name: "b", description: "", argumentHint: "" },
      { name: "a", description: "", argumentHint: "" },
    ];
    mergeCommands(own, claude, entry);

    expect(claude.map((c) => c.name)).toEqual(["b", "a"]);
  });
});

describe("combineClaudeCommands", () => {
  const cmd = (name: string, description: string) => ({ name, description, argumentHint: "" });

  test("lists the cached commands, then the bundled ones the cache does not have", () => {
    expect(
      combineClaudeCommands([cmd("review", "cached")], [cmd("marcsh:feature", "static"), cmd("marcsh:workflow", "static")]),
    ).toEqual([cmd("review", "cached"), cmd("marcsh:feature", "static"), cmd("marcsh:workflow", "static")]);
  });

  test("the cached entry wins on the same name (it carries the CLI's exact description)", () => {
    const combined = combineClaudeCommands(
      [{ name: "marcsh:feature", description: "from the CLI", argumentHint: "<feature-name>" }],
      [cmd("marcsh:feature", "from the file")],
    );

    expect(combined).toEqual([{ name: "marcsh:feature", description: "from the CLI", argumentHint: "<feature-name>" }]);
  });

  test("with an empty cache the bundled commands are all there is", () => {
    expect(combineClaudeCommands([], [cmd("marcsh:feature", "static")])).toEqual([cmd("marcsh:feature", "static")]);
    expect(combineClaudeCommands([], [])).toEqual([]);
  });

  test("marcsh's own commands still win over both once merged into the menu", () => {
    const own = OWN.map((name) => ({ name, description: `own ${name}` }));
    const claude = combineClaudeCommands(
      [cmd("new", "cached new"), cmd("zeta", "cached")],
      [cmd("theme", "static theme"), cmd("marcsh:feature", "static")],
    );

    const merged = mergeCommands(own, claude, (c) => ({ name: c.name, description: c.description }));

    expect(merged.map((c) => c.name)).toEqual([...OWN, "marcsh:feature", "zeta"]);
    expect(merged.find((c) => c.name === "new")!.description).toBe("own new");
  });

  test("does not mutate its inputs", () => {
    const cached = [cmd("a", "")];
    const bundled = [cmd("b", "")];
    combineClaudeCommands(cached, bundled);

    expect(cached).toEqual([cmd("a", "")]);
    expect(bundled).toEqual([cmd("b", "")]);
  });
});

describe("slashInputKind", () => {
  test("a marcsh command name, alone or with arguments, is a marcsh command", () => {
    expect(slashInputKind("/new", OWN)).toBe("marcsh");
    expect(slashInputKind("/theme dark", OWN)).toBe("marcsh");
    expect(slashInputKind("/exit\nnow", OWN)).toBe("marcsh");
  });

  test("any other /name, with or without arguments, passes through to Claude", () => {
    expect(slashInputKind("/foo", OWN)).toBe("claude");
    expect(slashInputKind("/foo bar", OWN)).toBe("claude");
    expect(slashInputKind("/probe:hello world", OWN)).toBe("claude");
    expect(slashInputKind("/newish", OWN)).toBe("claude");
  });

  test("text that does not start with /name is plain text", () => {
    expect(slashInputKind("hello /new", OWN)).toBe("text");
    expect(slashInputKind("/", OWN)).toBe("text");
    expect(slashInputKind("/ new", OWN)).toBe("text");
    expect(slashInputKind("", OWN)).toBe("text");
  });
});
