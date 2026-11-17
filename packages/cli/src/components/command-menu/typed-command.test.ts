import { describe, expect, test } from "bun:test";
import { typedCommand } from "./typed-command";
import { getFilteredCommands } from "./filter-commands";
import type { Command } from "./types";

const command = (name: string, source?: string): Command => ({ name, description: name, value: `/${name}`, ...(source ? { source } : {}) });

const LIST = [
  command("new"),
  command("agents"),
  command("models"),
  command("model-info"),
  command("sessions"),
  command("subagents"),
  command("theme"),
  command("help"),
  command("exit"),
  command("review", "claude"),
];

describe("typedCommand (S13): what Enter does in the / menu", () => {
  test("`/he` never runs `/theme`: fuzzy matches are not typed matches", () => {
    // Without `/help` the fuzzy list ranks `/theme` first for `he`, and Enter used to run it.
    const withoutHelp = LIST.filter((c) => c.name !== "help");
    const fuzzy = getFilteredCommands("he", withoutHelp);
    expect(fuzzy[0]!.name).toBe("theme");
    expect(typedCommand("he", fuzzy, false)).toEqual({ unknown: true });
    // With it, `he` is the start of `help`, the only name it begins.
    const shown = getFilteredCommands("he", LIST);
    expect(typedCommand("he", shown, false)).toEqual({ run: LIST.find((c) => c.name === "help")! });
    expect(typedCommand("th", getFilteredCommands("th", LIST), false)).toEqual({ run: LIST.find((c) => c.name === "theme")! });
    // A query that only matches `theme` by skipping letters runs nothing.
    expect(typedCommand("tm", getFilteredCommands("tm", LIST), false)).toEqual({ unknown: true });
    expect(typedCommand("hm", getFilteredCommands("hm", LIST), false)).toEqual({ unknown: true });
  });

  test("an exact name runs that command, even when it is also the start of another name", () => {
    expect(typedCommand("model", getFilteredCommands("model", LIST), false)).toEqual({ unknown: true });
    expect(typedCommand("models", getFilteredCommands("models", LIST), false)).toEqual({ run: LIST.find((c) => c.name === "models")! });
    const withShort = [...LIST, command("model")];
    expect(typedCommand("model", getFilteredCommands("model", withShort), false)).toEqual({ run: withShort.find((c) => c.name === "model")! });
  });

  test("the name is matched without regard to case", () => {
    expect(typedCommand("EXIT", LIST, false)).toEqual({ run: LIST.find((c) => c.name === "exit")! });
  });

  test("a unique prefix runs: `/mod` is not unique here, `/ag` is", () => {
    expect(typedCommand("ag", getFilteredCommands("ag", LIST), false)).toEqual({ run: LIST.find((c) => c.name === "agents")! });
    expect(typedCommand("rev", getFilteredCommands("rev", LIST), false)).toEqual({ run: LIST.find((c) => c.name === "review")! });
    const models = [command("models"), command("new")];
    expect(typedCommand("mod", getFilteredCommands("mod", models), false)).toEqual({ run: models[0]! });
  });

  test("an ambiguous prefix does not run", () => {
    expect(typedCommand("s", getFilteredCommands("s", LIST), false)).toEqual({ unknown: true });
    expect(typedCommand("mod", getFilteredCommands("mod", LIST), false)).toEqual({ unknown: true });
  });

  test("the highlighted row runs when the user moved it, whatever was typed", () => {
    const shown = getFilteredCommands("s", LIST);
    expect(typedCommand("s", shown, true, 1)).toEqual({ run: shown[1]! });
    expect(typedCommand("s", shown, true)).toEqual({ run: shown[0]! });
    expect(typedCommand("", LIST, true, 2)).toEqual({ run: LIST[2]! });
  });

  test("a moved highlight past the list runs nothing", () => {
    expect(typedCommand("zz", [], true, 0)).toEqual({ unknown: true });
  });

  test("an unknown name is unknown, with or without the menu listing something", () => {
    expect(typedCommand("probe:hello", getFilteredCommands("probe:hello", LIST), false)).toEqual({ unknown: true });
    expect(typedCommand("x", getFilteredCommands("x", LIST), false)).toEqual({ unknown: true });
    expect(typedCommand("", LIST, false)).toEqual({ unknown: true });
  });

  test("arguments after the name do not change which command it is", () => {
    expect(typedCommand("agents install acme/flows", LIST, false)).toEqual({ run: LIST.find((c) => c.name === "agents")! });
    expect(typedCommand("ag install x", LIST, false)).toEqual({ run: LIST.find((c) => c.name === "agents")! });
    expect(typedCommand("nope with args", LIST, false)).toEqual({ unknown: true });
  });

  test("engine commands in the list are known by their names", () => {
    const engine = [command("review", "claude"), command("pr-comments", "claude"), command("pi-skill:lint", "skill")];
    expect(typedCommand("review", engine, false)).toEqual({ run: engine[0]! });
    expect(typedCommand("pi-skill:lint", engine, false)).toEqual({ run: engine[2]! });
    expect(typedCommand("pr", engine, false)).toEqual({ run: engine[1]! });
  });

  test("text that has a path in it is sent as it is, not taken for a command", () => {
    expect(typedCommand("usr/bin/env", LIST, false)).toEqual({ send: true });
    expect(typedCommand("/comment", LIST, false)).toEqual({ send: true });
  });
});
