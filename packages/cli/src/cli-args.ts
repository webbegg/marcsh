// The command line, parsed before anything else loads: `marcsh --version` and `--help` only print, so they must not
// start the UI or touch ~/.marcsh. That is why this file imports nothing from the app.

export const USAGE = `Usage: marcsh [dir] [options]
       marcsh run [message...] [options]

  marcsh [dir]   Start the interface in dir (default: the current folder)
  marcsh run     Run one turn without the interface and print the reply

Options for the interface:
  -c, --continue          Open the most recent session of this folder
  -s, --session <id>      Open the session with this id
      --engine <engine>   The engine new sessions use on this launch: claude or pi

Options for run:
  -c, --continue          Continue the most recent session of this folder
  -s, --session <id>      Continue the session with this id
  -m, --model <model>     The model to use
      --agent <name>      The agent to use (its id or name)
      --engine <engine>   The engine of a new session: claude or pi
      --format <format>   text (the final reply, default) or json (one JSON object per line)
  Text on standard input is added to the message. Exit codes: 0 done, 1 the turn failed, 2 wrong usage, 130 interrupted.

Other options:
  --version  Print the version and exit
  --help     Show this help and exit
`;

/** The engines the options accept. Kept here (not read from lib/engine, which loads the app); a test keeps the two lists equal. */
export const LAUNCH_ENGINE_IDS = ["claude", "pi"] as const;
export type LaunchEngineId = (typeof LAUNCH_ENGINE_IDS)[number];

const FORMATS = ["text", "json"] as const;
export type RunFormat = (typeof FORMATS)[number];

/** Start the interface. `dir` is as typed (not checked here). */
export type TuiArgs = { kind: "tui"; dir?: string; continue: boolean; session?: string; engine?: LaunchEngineId };

/** `marcsh run`: one turn without the interface. */
export type RunArgs = {
  kind: "run";
  message: string;
  continue: boolean;
  session?: string;
  model?: string;
  agent?: string;
  engine?: LaunchEngineId;
  format: RunFormat;
};

export type CliArgs = TuiArgs | RunArgs | { kind: "version" } | { kind: "help" } | { kind: "error"; message: string };

type Flag = { long: string; short?: string; value: boolean };

const CONTINUE: Flag = { long: "continue", short: "c", value: false };
const SESSION: Flag = { long: "session", short: "s", value: true };
const ENGINE: Flag = { long: "engine", value: true };
const TUI_FLAGS = [CONTINUE, SESSION, ENGINE];
const RUN_FLAGS = [CONTINUE, SESSION, ENGINE, { long: "model", short: "m", value: true }, { long: "agent", value: true }, { long: "format", value: true }];

const error = (message: string): CliArgs => ({ kind: "error", message });

function oneOf<T extends string>(values: readonly T[], value: string): T | undefined {
  return values.find((candidate) => candidate === value);
}

/**
 * `argv` is the arguments after the script name. `run` is a command only as the first word; any other first word is the
 * directory to start in. The first `--version`, `--help` or unknown option decides; `--` makes everything after it a word.
 */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  const running = argv[0] === "run";
  const flags = running ? RUN_FLAGS : TUI_FLAGS;
  const words: string[] = [];
  const values = new Map<string, string>();
  let continuing = false;
  let literal = false;

  for (let i = running ? 1 : 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (literal || !arg.startsWith("-") || arg === "-") {
      words.push(arg);
      continue;
    }
    if (arg === "--") {
      literal = true;
      continue;
    }
    if (arg === "--version") return { kind: "version" };
    if (arg === "--help") return { kind: "help" };

    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const flag = flags.find((f) => name === `--${f.long}` || (f.short !== undefined && name === `-${f.short}`));
    if (!flag) return error(`unknown option "${arg}"`);

    if (!flag.value) {
      if (equals !== -1) return error(`option "--${flag.long}" takes no value`);
      continuing = true;
      continue;
    }
    const value = equals === -1 ? argv[++i] : arg.slice(equals + 1);
    if (!value) return error(`option "--${flag.long}" needs a value`);
    values.set(flag.long, value);
  }

  const session = values.get("session");
  if (continuing && session !== undefined) return error("--continue and --session cannot be used together");

  const engineText = values.get("engine");
  const engine = engineText === undefined ? undefined : oneOf(LAUNCH_ENGINE_IDS, engineText);
  if (engineText !== undefined && !engine) return error(`invalid --engine "${engineText}" (expected ${LAUNCH_ENGINE_IDS.join(" or ")})`);

  const shared = { continue: continuing, ...(session !== undefined ? { session } : {}), ...(engine ? { engine } : {}) };

  if (running) {
    const formatText = values.get("format") ?? "text";
    const format = oneOf(FORMATS, formatText);
    if (!format) return error(`invalid --format "${formatText}" (expected ${FORMATS.join(" or ")})`);
    const model = values.get("model");
    const agent = values.get("agent");
    return { kind: "run", message: words.join(" "), ...shared, ...(model !== undefined ? { model } : {}), ...(agent !== undefined ? { agent } : {}), format };
  }

  if (words.length > 1) return error(`unexpected argument "${words[1]}"`);
  return { kind: "tui", ...(words[0] !== undefined ? { dir: words[0] } : {}), ...shared };
}
