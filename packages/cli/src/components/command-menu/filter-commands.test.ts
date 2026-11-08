import { describe, expect, test } from "bun:test";
import { getFilteredCommands } from "./filter-commands";
import type { Command } from "./types";

const command = (name: string): Command => ({ name, description: name, value: `/${name}` });
const names = (query: string, list: Command[]) => getFilteredCommands(query, list).map((c) => c.name);

const MENU = ["new", "agents", "models", "sessions", "theme", "exit", "marcsh:feature", "marcsh:workflow", "review"].map(command);

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
