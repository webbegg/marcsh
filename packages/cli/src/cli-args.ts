// The command line, parsed before anything else loads: `marcsh --version` and `--help` only print, so they must not
// start the UI or touch ~/.marcsh. That is why this file imports nothing from the app.

export const USAGE = `Usage: marcsh [dir] [options]
       marcsh run [message...] [options]
       marcsh session list|delete|export ...
       marcsh models [--engine claude|pi]
       marcsh mcp list|add ...
       marcsh stats [--days N] [--json]
       marcsh upgrade [--version vX]

  marcsh [dir]     Start the interface in dir (default: the current folder)
  marcsh run       Run one turn without the interface and print the reply
  marcsh session   List, delete or export saved sessions
  marcsh models    List the models of the engines
  marcsh mcp       List or add MCP servers of the pi engine
  marcsh stats     Show sessions, messages, tokens and cost per model
  marcsh upgrade   Run the official installer again to update marcsh

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
  --help     Show this help and exit (after a command: the help of that command)
`;

export const COMMAND_NAMES = ["session", "models", "mcp", "stats", "upgrade"] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

/** What `marcsh <command> --help` prints. */
export const COMMAND_USAGE: Record<CommandName, string> = {
  session: `Usage: marcsh session list [--json]
       marcsh session delete <id>
       marcsh session export <id> [--format md|json] [-o file] [--force]

  list                 Print the saved sessions, newest first (--json: a JSON array)
  delete <id>          Delete that one session for good
  export <id>          Print the session as a transcript, or write it to a file with -o
      --format <fmt>   md (default) or json
  -o, --output <file>  Write to this file (a folder gets marcsh-<id>-<date>.<fmt>). It refuses to replace a file
      --force          Replace the file that -o names
`,
  models: `Usage: marcsh models [--engine claude|pi]

Lists the models the engines offer: the Claude aliases, and pi's models (marked * when their provider has credentials).
Without --engine both engines are listed.

      --engine <engine>   Only this engine: claude or pi
`,
  mcp: `Usage: marcsh mcp list
       marcsh mcp add <name> [--force] -- <command...>

  list                    Print the MCP servers pi reads: ~/.marcsh/agent/mcp.json and, when present, the project's .pi/mcp.json
  add <name> -- <command> Add a local server to ~/.marcsh/agent/mcp.json; everything after -- is the command and its arguments
      --force             Replace a server of that name
`,
  stats: `Usage: marcsh stats [--days N] [--json]

Shows sessions, messages, tokens and cost per model, and the totals.

      --days <N>   Only sessions updated in the last N days (default: all)
      --json       Print JSON instead of a table
`,
  upgrade: `Usage: marcsh upgrade [--version vX]

Downloads the official installer (install.sh), prints where it came from and runs it. MARCSH_INSTALLER_URL replaces the address.

      --version <vX>   Install this version (for example v0.2.0) instead of the latest
`,
};

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

const TRANSCRIPT_FORMATS = ["md", "json"] as const;
export type SessionExportFormat = (typeof TRANSCRIPT_FORMATS)[number];

/** `marcsh session`: list, delete or export saved sessions. */
export type SessionArgs =
  | { kind: "session"; action: "list"; json: boolean }
  | { kind: "session"; action: "delete"; id: string }
  | { kind: "session"; action: "export"; id: string; format: SessionExportFormat; output?: string; force: boolean };

export type ModelsArgs = { kind: "models"; engine?: LaunchEngineId };

export type McpArgs =
  | { kind: "mcp"; action: "list" }
  | { kind: "mcp"; action: "add"; name: string; command: string[]; force: boolean };

export type StatsArgs = { kind: "stats"; days?: number; json: boolean };

/** `version` is without a leading "v", as the installer takes it. */
export type UpgradeArgs = { kind: "upgrade"; version?: string };

export type CliArgs =
  | TuiArgs
  | RunArgs
  | SessionArgs
  | ModelsArgs
  | McpArgs
  | StatsArgs
  | UpgradeArgs
  | { kind: "version" }
  | { kind: "help"; command?: CommandName }
  | { kind: "error"; message: string };

type Flag = { long: string; short?: string; value: boolean };

const CONTINUE: Flag = { long: "continue", short: "c", value: false };
const SESSION: Flag = { long: "session", short: "s", value: true };
const ENGINE: Flag = { long: "engine", value: true };
const FORMAT: Flag = { long: "format", value: true };
const JSON_OUTPUT: Flag = { long: "json", value: false };
const FORCE: Flag = { long: "force", value: false };
const TUI_FLAGS = [CONTINUE, SESSION, ENGINE];
const RUN_FLAGS = [CONTINUE, SESSION, ENGINE, { long: "model", short: "m", value: true }, { long: "agent", value: true }, FORMAT];
const COMMAND_FLAGS: Record<CommandName, Flag[]> = {
  session: [JSON_OUTPUT, FORMAT, { long: "output", short: "o", value: true }, FORCE],
  models: [ENGINE],
  mcp: [FORCE],
  stats: [{ long: "days", value: true }, JSON_OUTPUT],
  // Here `--version` is the version to install, not the flag that prints marcsh's own.
  upgrade: [{ long: "version", value: true }],
};
/** The options each action of `session` and `mcp` accepts; the flag tables above are shared by the actions. */
const ACTION_FLAGS: Record<string, string[]> = {
  "session list": ["json"],
  "session delete": [],
  "session export": ["format", "output", "force"],
  "mcp list": [],
  "mcp add": ["force"],
};
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
/** The installer's own pattern for MARCSH_VERSION. */
const INSTALLER_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

const error = (message: string): CliArgs => ({ kind: "error", message });

function oneOf<T extends string>(values: readonly T[], value: string): T | undefined {
  return values.find((candidate) => candidate === value);
}

const isCommand = (word: string | undefined): word is CommandName => COMMAND_NAMES.some((name) => name === word);

type Scanned = {
  /** Every word, those after `--` included. */
  words: string[];
  /** How many of the words came before `--` (all of them when there was none). */
  beforeDash: number;
  dashed: boolean;
  values: Map<string, string>;
  present: Set<string>;
};

/**
 * Reads the words and options of `argv` from `start`. The first `--version` (unless the command takes it), `--help` or unknown
 * option decides and is returned as the result; `--` makes everything after it a word.
 */
function scan(argv: readonly string[], start: number, flags: readonly Flag[], command?: CommandName): Scanned | CliArgs {
  const scanned: Scanned = { words: [], beforeDash: -1, dashed: false, values: new Map(), present: new Set() };
  const { words, values, present } = scanned;

  for (let i = start; i < argv.length; i++) {
    const arg = argv[i]!;
    if (scanned.dashed || !arg.startsWith("-") || arg === "-") {
      words.push(arg);
      continue;
    }
    if (arg === "--") {
      scanned.dashed = true;
      scanned.beforeDash = words.length;
      continue;
    }

    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const flag = flags.find((f) => name === `--${f.long}` || (f.short !== undefined && name === `-${f.short}`));
    if (!flag) {
      if (arg === "--version") return { kind: "version" };
      if (arg === "--help") return command ? { kind: "help", command } : { kind: "help" };
      return error(`unknown option "${arg}"`);
    }

    if (!flag.value) {
      if (equals !== -1) return error(`option "--${flag.long}" takes no value`);
      present.add(flag.long);
      continue;
    }
    const value = equals === -1 ? argv[++i] : arg.slice(equals + 1);
    if (!value) return error(`option "--${flag.long}" needs a value`);
    values.set(flag.long, value);
  }

  if (!scanned.dashed) scanned.beforeDash = words.length;
  return scanned;
}

const isScanned = (result: Scanned | CliArgs): result is Scanned => "words" in result;

/** An error for the first option the action does not take (the flag tables of `session` and `mcp` are shared by their actions). */
function foreignOption(command: string, action: string, scanned: Scanned): CliArgs | undefined {
  const allowed = ACTION_FLAGS[`${command} ${action}`] ?? [];
  const stray = [...scanned.present, ...scanned.values.keys()].find((name) => !allowed.includes(name));
  return stray === undefined ? undefined : error(`option "--${stray}" does not apply to "${command} ${action}"`);
}

function parseSession(scanned: Scanned): CliArgs {
  const [action, ...rest] = scanned.words;
  if (action === undefined) return error("session needs a command: list, delete or export");
  if (action !== "list" && action !== "delete" && action !== "export") {
    return error(`unknown session command "${action}" (expected list, delete or export)`);
  }
  const foreign = foreignOption("session", action, scanned);
  if (foreign) return foreign;

  if (action === "list") {
    return rest.length > 0 ? error(`unexpected argument "${rest[0]}"`) : { kind: "session", action, json: scanned.present.has("json") };
  }
  const [id, ...extra] = rest;
  if (id === undefined) return error(`session ${action} needs a session id`);
  if (extra.length > 0) return error(`unexpected argument "${extra[0]}"`);
  if (action === "delete") return { kind: "session", action, id };

  const formatText = scanned.values.get("format") ?? "md";
  const format = oneOf(TRANSCRIPT_FORMATS, formatText);
  if (!format) return error(`invalid --format "${formatText}" (expected ${TRANSCRIPT_FORMATS.join(" or ")})`);
  const output = scanned.values.get("output");
  return { kind: "session", action, id, format, ...(output !== undefined ? { output } : {}), force: scanned.present.has("force") };
}

function parseMcp(scanned: Scanned): CliArgs {
  const [action] = scanned.words;
  if (action === undefined) return error("mcp needs a command: list or add");
  if (action !== "list" && action !== "add") return error(`unknown mcp command "${action}" (expected list or add)`);
  const foreign = foreignOption("mcp", action, scanned);
  if (foreign) return foreign;

  const before = scanned.words.slice(1, scanned.beforeDash);
  if (action === "list") {
    return scanned.words.length > 1 ? error(`unexpected argument "${scanned.words[1]}"`) : { kind: "mcp", action };
  }
  const [name, ...extra] = before;
  if (name === undefined) return error("mcp add needs a server name");
  if (!SERVER_NAME.test(name)) return error(`invalid server name "${name}" (use letters, digits, "_" and "-")`);
  if (extra.length > 0) {
    return error(scanned.dashed ? `unexpected argument "${extra[0]}"` : 'mcp add needs "--" before the command: marcsh mcp add <name> -- <command...>');
  }
  const command = scanned.words.slice(scanned.beforeDash);
  if (command.length === 0) return error('mcp add needs a command after "--": marcsh mcp add <name> -- <command...>');
  return { kind: "mcp", action, name, command, force: scanned.present.has("force") };
}

function parseCommand(command: CommandName, argv: readonly string[]): CliArgs {
  const scanned = scan(argv, 1, COMMAND_FLAGS[command], command);
  if (!isScanned(scanned)) return scanned;
  const { words, values, present } = scanned;

  switch (command) {
    case "session":
      return parseSession(scanned);
    case "mcp":
      return parseMcp(scanned);
    case "models": {
      if (words.length > 0) return error(`unexpected argument "${words[0]}"`);
      const engineText = values.get("engine");
      const engine = engineText === undefined ? undefined : oneOf(LAUNCH_ENGINE_IDS, engineText);
      if (engineText !== undefined && !engine) return error(`invalid --engine "${engineText}" (expected ${LAUNCH_ENGINE_IDS.join(" or ")})`);
      return { kind: "models", ...(engine ? { engine } : {}) };
    }
    case "stats": {
      if (words.length > 0) return error(`unexpected argument "${words[0]}"`);
      const daysText = values.get("days");
      const days = daysText === undefined ? undefined : Number(daysText);
      if (daysText !== undefined && !(/^[0-9]+$/.test(daysText) && Number.isSafeInteger(days) && days! > 0)) {
        return error(`invalid --days "${daysText}" (expected a positive whole number)`);
      }
      return { kind: "stats", ...(days !== undefined ? { days } : {}), json: present.has("json") };
    }
    case "upgrade": {
      if (words.length > 0) return error(`unexpected argument "${words[0]}"`);
      const versionText = values.get("version");
      if (versionText === undefined) return { kind: "upgrade" };
      const version = versionText.replace(/^v/, "");
      if (!INSTALLER_VERSION.test(version)) return error(`invalid --version "${versionText}" (expected a version like v0.2.0)`);
      return { kind: "upgrade", version };
    }
  }
}

/**
 * `argv` is the arguments after the script name. `run` and the other commands (`session`, `models`, `mcp`, `stats`, `upgrade`)
 * are commands only as the first word; any other first word is the directory to start in. The first `--version`, `--help` or
 * unknown option decides; `--` makes everything after it a word.
 */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  if (isCommand(argv[0])) return parseCommand(argv[0], argv);

  const running = argv[0] === "run";
  const scanned = scan(argv, running ? 1 : 0, running ? RUN_FLAGS : TUI_FLAGS);
  if (!isScanned(scanned)) return scanned;
  const { words, values } = scanned;
  const continuing = scanned.present.has("continue");

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
