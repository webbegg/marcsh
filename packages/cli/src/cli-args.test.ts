import { describe, expect, test } from "bun:test";
import { ENGINE_IDS } from "./lib/engine";
import { LAUNCH_ENGINE_IDS, parseCliArgs, USAGE, type RunArgs, type TuiArgs } from "./cli-args";

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
