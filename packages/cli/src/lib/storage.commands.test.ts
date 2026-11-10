import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorage } from "./storage";

const CLAUDE = [{ name: "review", description: "Review code", argumentHint: "<file>" }];
const PI = [
  { name: "deploy", description: "Ship it", argumentHint: "", source: "extension" },
  { name: "skill:workflow", description: "Pick a lane", argumentHint: "", source: "skill" },
];

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("the command list cache, per engine", () => {
  test("each engine starts empty", () => {
    const storage = openStorage(":memory:");

    expect(storage.getCommands("claude")).toEqual([]);
    expect(storage.getCommands("pi")).toEqual([]);
  });

  test("a list saved for pi is read back with its sources, and replaces the previous one", () => {
    const storage = openStorage(":memory:");
    storage.saveCommands("pi", [{ name: "old", description: "", argumentHint: "", source: "prompt" }]);

    storage.saveCommands("pi", PI);

    expect(storage.getCommands("pi")).toEqual(PI);
  });

  test("the pi list and the Claude list do not touch each other", () => {
    const storage = openStorage(":memory:");

    storage.saveCommands("pi", PI);
    expect(storage.getClaudeCommands()).toEqual([]);

    storage.saveClaudeCommands(CLAUDE);
    expect(storage.getCommands("pi")).toEqual(PI);

    storage.saveCommands("pi", []);
    expect(storage.getClaudeCommands()).toEqual(CLAUDE);
  });

  test("the Claude list is the one the Claude accessors already use, and keeps no source", () => {
    const storage = openStorage(":memory:");

    storage.saveClaudeCommands(CLAUDE);
    expect(storage.getCommands("claude")).toEqual(CLAUDE);

    storage.saveCommands("claude", [{ name: "other", description: "", argumentHint: "", source: "skill" }]);
    expect(storage.getClaudeCommands()).toEqual([{ name: "other", description: "", argumentHint: "" }]);
  });

  test("unusable pi entries are dropped and a source that is not text is ignored", () => {
    const storage = openStorage(":memory:");

    storage.saveCommands("pi", [
      { name: "  /clean  ", description: "ok", argumentHint: "", source: "prompt" },
      { name: "", description: "no name", argumentHint: "" },
      { name: "plain", description: "no source", argumentHint: "", source: 7 },
    ] as never);

    expect(storage.getCommands("pi")).toEqual([
      { name: "clean", description: "ok", argumentHint: "", source: "prompt" },
      { name: "plain", description: "no source", argumentHint: "" },
    ]);
  });

  test("both lists survive reopening the same file", () => {
    dir = mkdtempSync(join(tmpdir(), "marcsh-commands-"));
    const path = join(dir, "marcsh.db");
    const first = openStorage(path);
    first.saveClaudeCommands(CLAUDE);
    first.saveCommands("pi", PI);

    const reopened = openStorage(path);

    expect(reopened.getClaudeCommands()).toEqual(CLAUDE);
    expect(reopened.getCommands("pi")).toEqual(PI);
  });

  test("a database from before the pi cache keeps its Claude list and has an empty pi list", () => {
    dir = mkdtempSync(join(tmpdir(), "marcsh-commands-"));
    const path = join(dir, "marcsh.db");
    const old = new Database(path, { create: true });
    old.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    old.run("INSERT INTO meta (key, value) VALUES ('claude_commands', ?)", [JSON.stringify(CLAUDE)]);
    old.close();

    const storage = openStorage(path);

    expect(storage.getClaudeCommands()).toEqual(CLAUDE);
    expect(storage.getCommands("claude")).toEqual(CLAUDE);
    expect(storage.getCommands("pi")).toEqual([]);

    storage.saveCommands("pi", PI);
    expect(storage.getClaudeCommands()).toEqual(CLAUDE);
  });

  test("an unreadable stored list reads as empty", () => {
    dir = mkdtempSync(join(tmpdir(), "marcsh-commands-"));
    const path = join(dir, "marcsh.db");
    openStorage(path);
    const raw = new Database(path);
    raw.run("INSERT INTO meta (key, value) VALUES ('pi_commands', 'not json')");
    raw.close();

    expect(openStorage(path).getCommands("pi")).toEqual([]);
  });
});
