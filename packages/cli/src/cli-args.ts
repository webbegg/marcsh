// The command line, parsed before anything else loads: `marcsh --version` and `--help` only print, so they must not
// start the UI or touch ~/.marcsh.

export const USAGE = `Usage: marcsh [options]

Options:
  --version  Print the version and exit
  --help     Show this help and exit
`;

export type CliArgs =
  | { kind: "run" }
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "error"; message: string };

/** `argv` is the arguments after the script name. The first `--version`, `--help` or unknown argument decides. */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  for (const arg of argv) {
    if (arg === "--version") return { kind: "version" };
    if (arg === "--help") return { kind: "help" };
    if (arg.startsWith("-")) return { kind: "error", message: `unknown option "${arg}"` };
    return { kind: "error", message: `unexpected argument "${arg}"` };
  }
  return { kind: "run" };
}
