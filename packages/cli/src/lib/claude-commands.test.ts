import { describe, expect, test } from "bun:test";
import { mergeCommands, normalizeClaudeCommands, slashInputKind } from "./claude-commands";

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
