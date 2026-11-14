import { describe, expect, test } from "bun:test";
import { ENGINE_IDS } from "./lib/engine";
import { COMMAND_USAGE, LAUNCH_ENGINE_IDS, parseCliArgs, USAGE, type CliArgs, type RunArgs, type TuiArgs } from "./cli-args";

const tui = (rest: Partial<TuiArgs> = {}): TuiArgs => ({ kind: "tui", continue: false, ...rest });
const run = (rest: Partial<RunArgs> = {}): RunArgs => ({ kind: "run", message: "", continue: false, format: "text", ...rest });

describe("parseCliArgs", () => {
  test("no arguments starts the app", () => {
    expect(parseCliArgs([])).toEqual(tui());
  });

  test("--version asks for the version", () => {
    expect(parseCliArgs(["--version"])).toEqual({ kind: "version" });
  });

  test("--help asks for the usage", () => {
    expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
  });

  test("an unknown option is an error that names it", () => {
    expect(parseCliArgs(["--bogus"])).toEqual({ kind: "error", message: 'unknown option "--bogus"' });
    expect(parseCliArgs(["-x"])).toEqual({ kind: "error", message: 'unknown option "-x"' });
  });

  test("the first of --version, --help or an unknown option decides", () => {
    expect(parseCliArgs(["--help", "--bogus"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["--version", "--help"])).toEqual({ kind: "version" });
    expect(parseCliArgs(["--bogus", "--version"])).toEqual({ kind: "error", message: 'unknown option "--bogus"' });
    expect(parseCliArgs(["run", "--help"])).toEqual({ kind: "help" });
  });

  test("the usage lists --version, --help, the commands and the flags", () => {
    expect(USAGE).toContain("Usage: marcsh");
    for (const word of ["--version", "--help", "run", "[dir]", "--continue", "--session", "--model", "--agent", "--engine", "--format"]) {
      expect(USAGE).toContain(word);
    }
  });

  test("the engines the parser accepts are the registered engines", () => {
    expect([...LAUNCH_ENGINE_IDS]).toEqual([...ENGINE_IDS]);
  });
});

describe("parseCliArgs: launching the TUI", () => {
  test("one word is the directory to start in", () => {
    expect(parseCliArgs(["../other"])).toEqual(tui({ dir: "../other" }));
  });

  test("a second word is an error", () => {
    expect(parseCliArgs(["a", "b"])).toEqual({ kind: "error", message: 'unexpected argument "b"' });
  });

  test("-c and --continue open the latest session", () => {
    expect(parseCliArgs(["-c"])).toEqual(tui({ continue: true }));
    expect(parseCliArgs(["--continue", "proj"])).toEqual(tui({ continue: true, dir: "proj" }));
  });

  test("-s and --session take a session id, also as --session=<id>", () => {
    expect(parseCliArgs(["-s", "abc"])).toEqual(tui({ session: "abc" }));
    expect(parseCliArgs(["--session", "abc"])).toEqual(tui({ session: "abc" }));
    expect(parseCliArgs(["--session=abc"])).toEqual(tui({ session: "abc" }));
  });

  test("--engine takes claude or pi and nothing else", () => {
    expect(parseCliArgs(["--engine", "claude"])).toEqual(tui({ engine: "claude" }));
    expect(parseCliArgs(["--engine=pi"])).toEqual(tui({ engine: "pi" }));
    expect(parseCliArgs(["--engine", "gpt"])).toEqual({ kind: "error", message: 'invalid --engine "gpt" (expected claude or pi)' });
  });

  test("an option without its value is an error", () => {
    expect(parseCliArgs(["--session"])).toEqual({ kind: "error", message: 'option "--session" needs a value' });
    expect(parseCliArgs(["--engine"])).toEqual({ kind: "error", message: 'option "--engine" needs a value' });
  });

  test("a flag that takes no value rejects one", () => {
    expect(parseCliArgs(["--continue=yes"])).toEqual({ kind: "error", message: 'option "--continue" takes no value' });
  });

  test("--continue and --session together are an error", () => {
    expect(parseCliArgs(["-c", "-s", "abc"])).toEqual({ kind: "error", message: "--continue and --session cannot be used together" });
  });

  test("the run-only options are unknown to the TUI", () => {
    expect(parseCliArgs(["--model", "x"])).toEqual({ kind: "error", message: 'unknown option "--model"' });
    expect(parseCliArgs(["--format", "json"])).toEqual({ kind: "error", message: 'unknown option "--format"' });
  });

  test("-- makes the rest words, so a directory can start with a dash", () => {
    expect(parseCliArgs(["--", "-odd"])).toEqual(tui({ dir: "-odd" }));
  });
});

describe("parseCliArgs: marcsh run", () => {
  test("the words after run are the message", () => {
    expect(parseCliArgs(["run", "fix", "the", "bug"])).toEqual(run({ message: "fix the bug" }));
  });

  test("no words give an empty message (stdin may supply it)", () => {
    expect(parseCliArgs(["run"])).toEqual(run());
  });

  test("all flags", () => {
    expect(
      parseCliArgs(["run", "-m", "opus", "--agent", "plan", "--engine", "claude", "--format", "json", "-s", "abc", "hello"]),
    ).toEqual(run({ message: "hello", model: "opus", agent: "plan", engine: "claude", format: "json", session: "abc" }));
    expect(parseCliArgs(["run", "--continue", "--model=m", "hi"])).toEqual(run({ message: "hi", continue: true, model: "m" }));
  });

  test("flags may sit between the words", () => {
    expect(parseCliArgs(["run", "say", "-c", "hi"])).toEqual(run({ message: "say hi", continue: true }));
  });

  test("-- makes the rest of the message literal", () => {
    expect(parseCliArgs(["run", "--", "--help", "me"])).toEqual(run({ message: "--help me" }));
  });

  test("--format accepts text and json only", () => {
    expect(parseCliArgs(["run", "--format", "text", "x"])).toEqual(run({ message: "x", format: "text" }));
    expect(parseCliArgs(["run", "--format", "xml"])).toEqual({ kind: "error", message: 'invalid --format "xml" (expected text or json)' });
  });

  test("errors of the shared options apply", () => {
    expect(parseCliArgs(["run", "--engine", "x"])).toEqual({ kind: "error", message: 'invalid --engine "x" (expected claude or pi)' });
    expect(parseCliArgs(["run", "--model"])).toEqual({ kind: "error", message: 'option "--model" needs a value' });
    expect(parseCliArgs(["run", "-c", "-s", "a"])).toEqual({ kind: "error", message: "--continue and --session cannot be used together" });
    expect(parseCliArgs(["run", "--bogus"])).toEqual({ kind: "error", message: 'unknown option "--bogus"' });
  });

  test("run is a command only as the first word", () => {
    expect(parseCliArgs(["x", "run"])).toEqual({ kind: "error", message: 'unexpected argument "run"' });
  });
});

const bad = (message: string): CliArgs => ({ kind: "error", message });

describe("parseCliArgs: marcsh session", () => {
  test("list, with --json", () => {
    expect(parseCliArgs(["session", "list"])).toEqual({ kind: "session", action: "list", json: false });
    expect(parseCliArgs(["session", "list", "--json"])).toEqual({ kind: "session", action: "list", json: true });
    expect(parseCliArgs(["session", "--json", "list"])).toEqual({ kind: "session", action: "list", json: true });
  });

  test("delete takes one id", () => {
    expect(parseCliArgs(["session", "delete", "abc"])).toEqual({ kind: "session", action: "delete", id: "abc" });
    expect(parseCliArgs(["session", "delete"])).toEqual(bad("session delete needs a session id"));
    expect(parseCliArgs(["session", "delete", "a", "b"])).toEqual(bad('unexpected argument "b"'));
  });

  test("export takes an id, --format md|json (default md), -o and --force", () => {
    expect(parseCliArgs(["session", "export", "abc"])).toEqual({ kind: "session", action: "export", id: "abc", format: "md", force: false });
    expect(parseCliArgs(["session", "export", "abc", "--format", "json", "-o", "out.json", "--force"])).toEqual({
      kind: "session",
      action: "export",
      id: "abc",
      format: "json",
      output: "out.json",
      force: true,
    });
    expect(parseCliArgs(["session", "export", "abc", "--output=x.md"])).toMatchObject({ output: "x.md" });
    expect(parseCliArgs(["session", "export", "abc", "--format", "xml"])).toEqual(bad('invalid --format "xml" (expected md or json)'));
    expect(parseCliArgs(["session", "export"])).toEqual(bad("session export needs a session id"));
  });

  test("a missing or unknown action is an error", () => {
    expect(parseCliArgs(["session"])).toEqual(bad("session needs a command: list, delete or export"));
    expect(parseCliArgs(["session", "rename", "x"])).toEqual(bad('unknown session command "rename" (expected list, delete or export)'));
  });

  test("an option that belongs to another action is an error", () => {
    expect(parseCliArgs(["session", "list", "--force"])).toEqual(bad('option "--force" does not apply to "session list"'));
    expect(parseCliArgs(["session", "delete", "a", "--json"])).toEqual(bad('option "--json" does not apply to "session delete"'));
    expect(parseCliArgs(["session", "list", "--bogus"])).toEqual(bad('unknown option "--bogus"'));
  });

  test("--help asks for the help of the command", () => {
    expect(parseCliArgs(["session", "--help"])).toEqual({ kind: "help", command: "session" });
    expect(parseCliArgs(["session", "export", "a", "--help"])).toEqual({ kind: "help", command: "session" });
  });
});

describe("parseCliArgs: marcsh models", () => {
  test("lists every engine, or one with --engine", () => {
    expect(parseCliArgs(["models"])).toEqual({ kind: "models" });
    expect(parseCliArgs(["models", "--engine", "pi"])).toEqual({ kind: "models", engine: "pi" });
    expect(parseCliArgs(["models", "--engine=claude"])).toEqual({ kind: "models", engine: "claude" });
    expect(parseCliArgs(["models", "--engine", "x"])).toEqual(bad('invalid --engine "x" (expected claude or pi)'));
    expect(parseCliArgs(["models", "extra"])).toEqual(bad('unexpected argument "extra"'));
    expect(parseCliArgs(["models", "--help"])).toEqual({ kind: "help", command: "models" });
  });
});

describe("parseCliArgs: marcsh mcp", () => {
  test("list", () => {
    expect(parseCliArgs(["mcp", "list"])).toEqual({ kind: "mcp", action: "list" });
    expect(parseCliArgs(["mcp"])).toEqual(bad("mcp needs a command: list or add"));
    expect(parseCliArgs(["mcp", "remove", "x"])).toEqual(bad('unknown mcp command "remove" (expected list or add)'));
    expect(parseCliArgs(["mcp", "--help"])).toEqual({ kind: "help", command: "mcp" });
  });

  test("add takes a name, then the command after --", () => {
    expect(parseCliArgs(["mcp", "add", "fs", "--", "npx", "-y", "server", "--flag"])).toEqual({
      kind: "mcp",
      action: "add",
      name: "fs",
      command: ["npx", "-y", "server", "--flag"],
      force: false,
    });
    expect(parseCliArgs(["mcp", "add", "--force", "fs", "--", "srv"])).toMatchObject({ force: true, command: ["srv"] });
  });

  test("add needs a valid name and a command", () => {
    expect(parseCliArgs(["mcp", "add"])).toEqual(bad("mcp add needs a server name"));
    expect(parseCliArgs(["mcp", "add", "fs"])).toEqual(bad('mcp add needs a command after "--": marcsh mcp add <name> -- <command...>'));
    expect(parseCliArgs(["mcp", "add", "fs", "--"])).toEqual(bad('mcp add needs a command after "--": marcsh mcp add <name> -- <command...>'));
    expect(parseCliArgs(["mcp", "add", "fs", "srv"])).toEqual(bad('mcp add needs "--" before the command: marcsh mcp add <name> -- <command...>'));
    expect(parseCliArgs(["mcp", "add", "a b", "--", "srv"])).toEqual(bad('invalid server name "a b" (use letters, digits, "_" and "-")'));
    expect(parseCliArgs(["mcp", "add", "a", "b", "--", "srv"])).toEqual(bad('unexpected argument "b"'));
  });

  test("list takes no options", () => {
    expect(parseCliArgs(["mcp", "list", "--force"])).toEqual(bad('option "--force" does not apply to "mcp list"'));
  });
});

describe("parseCliArgs: marcsh stats", () => {
  test("--days and --json", () => {
    expect(parseCliArgs(["stats"])).toEqual({ kind: "stats", json: false });
    expect(parseCliArgs(["stats", "--days", "7", "--json"])).toEqual({ kind: "stats", days: 7, json: true });
    expect(parseCliArgs(["stats", "--days=30"])).toEqual({ kind: "stats", days: 30, json: false });
    expect(parseCliArgs(["stats", "--days", "0"])).toEqual(bad('invalid --days "0" (expected a positive whole number)'));
    expect(parseCliArgs(["stats", "--days", "x"])).toEqual(bad('invalid --days "x" (expected a positive whole number)'));
    expect(parseCliArgs(["stats", "--days", "1.5"])).toEqual(bad('invalid --days "1.5" (expected a positive whole number)'));
    expect(parseCliArgs(["stats", "--help"])).toEqual({ kind: "help", command: "stats" });
  });
});

describe("parseCliArgs: marcsh upgrade", () => {
  test("--version takes a value here and is not the version flag", () => {
    expect(parseCliArgs(["upgrade"])).toEqual({ kind: "upgrade" });
    expect(parseCliArgs(["upgrade", "--version", "v0.2.0"])).toEqual({ kind: "upgrade", version: "0.2.0" });
    expect(parseCliArgs(["upgrade", "--version=0.3.1-beta.1"])).toEqual({ kind: "upgrade", version: "0.3.1-beta.1" });
    expect(parseCliArgs(["upgrade", "--version"])).toEqual(bad('option "--version" needs a value'));
    expect(parseCliArgs(["upgrade", "--version", "latest"])).toEqual(bad('invalid --version "latest" (expected a version like v0.2.0)'));
    expect(parseCliArgs(["upgrade", "--help"])).toEqual({ kind: "help", command: "upgrade" });
    expect(parseCliArgs(["upgrade", "now"])).toEqual(bad('unexpected argument "now"'));
  });
});

describe("parseCliArgs: usage", () => {
  test("the usage lists every command and starts with Usage: marcsh", () => {
    expect(USAGE.startsWith("Usage: marcsh")).toBe(true);
    for (const word of ["session", "models", "mcp", "stats", "upgrade"]) expect(USAGE).toContain(`marcsh ${word}`);
  });

  test("every command has its own help", () => {
    for (const command of ["session", "models", "mcp", "stats", "upgrade"] as const) {
      expect(COMMAND_USAGE[command]).toStartWith(`Usage: marcsh ${command}`);
    }
  });
});
