import { describe, expect, test } from "bun:test";
import { parseCliArgs, USAGE } from "./cli-args";

describe("parseCliArgs", () => {
  test("no arguments starts the app", () => {
    expect(parseCliArgs([])).toEqual({ kind: "run" });
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

  test("a stray word is an error too", () => {
    expect(parseCliArgs(["session"])).toEqual({ kind: "error", message: 'unexpected argument "session"' });
  });

  test("the first of --version, --help or an unknown option decides", () => {
    expect(parseCliArgs(["--help", "--bogus"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["--version", "--help"])).toEqual({ kind: "version" });
    expect(parseCliArgs(["--bogus", "--version"])).toEqual({ kind: "error", message: 'unknown option "--bogus"' });
  });

  test("the usage lists --version and --help", () => {
    expect(USAGE).toContain("Usage: marcsh");
    expect(USAGE).toContain("--version");
    expect(USAGE).toContain("--help");
  });
});
