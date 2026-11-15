import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentModelFits, type Agent } from "./agents";
import { MAX_AGENT_BYTES, agentFileSlug, readFrontmatter } from "./agent-file";
import { listPacks, packPluginDir, packPluginName, packsRoot } from "./pack-lock";
import { printable } from "./safe-text";
import { getStorage } from "./storage";

/** A command name: the file name without `.md`. */
const NAME = /^[a-z0-9][a-z0-9\-_:]*$/;

/** A user's slash command: a markdown file whose body is a prompt template. */
export type UserCommand = {
  /** Without the leading slash. */
  name: string;
  description: string;
  /** The prompt, with `$ARGUMENTS` and `$1`..`$9` still in it. */
  template: string;
  /** The agent (ID or name) the turn runs as; the selected agent when absent. */
  agent?: string;
  /** The model the turn runs on; the session's when absent or unusable on the engine. */
  model?: string;
  /** What the menu shows after the name (`argument-hint`), when the file gives one. */
  argumentHint?: string;
  /** `personal` for `~/.marcsh/commands`, `project` for `<project>/.marcsh/commands`, `pack` for an installed pack's `commands/` that names an agent. */
  source: "personal" | "project" | "pack";
  /** A pack command's pack ID. Its `agent` is one of that pack's agents or a built-in. */
  pack?: string;
  /** A pack command's name as the engine lists its copy in the pack's view on Claude (`<plugin name>:<name>`): marcsh runs it under that name too. */
  engineName?: string;
};

/** Where the user's own commands live: global, next to the agents. */
export function userCommandsDir() {
  return process.env.MARCSH_COMMANDS_DIR?.trim() || join(homedir(), ".marcsh", "commands");
}

const firstLine = (text: string) => text.split("\n").find((line) => line.trim() !== "")?.trim().slice(0, 80) ?? "";

/** The commands in `dir`. A pack's (`pack` given) are only those that name an agent: the rest are the engine's, as before. */
function readCommandDir(dir: string, source: UserCommand["source"], pack?: string): UserCommand[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const commands: UserCommand[] = [];
  for (const file of files) {
    const name = file.slice(0, -".md".length);
    if (!NAME.test(name)) continue;
    const path = join(dir, file);
    try {
      // A project or a pack is third-party content: a link in it must not pull in a file from elsewhere.
      const info = source === "personal" ? statSync(path) : lstatSync(path);
      if (!info.isFile() || info.size > MAX_AGENT_BYTES) continue;
      const { fields, body } = readFrontmatter(readFileSync(path, "utf8"));
      const template = body.trim();
      if (template === "") continue;
      // A pack's texts are shown in the menu and the warnings: no escape sequence may get through.
      const field = (key: string) => {
        const value = fields.get(key)?.trim() || undefined;
        return value && pack ? printable(value) : value;
      };
      const agent = field("agent");
      if (pack && !agent) continue;
      const argumentHint = field("argument-hint");
      commands.push({
        name,
        description: field("description") ?? (pack ? printable(firstLine(template)) : firstLine(template)),
        template,
        agent,
        model: field("model"),
        ...(argumentHint ? { argumentHint } : {}),
        source,
        ...(pack ? { pack, engineName: `${packPluginName(pack)}:${name}` } : {}),
      });
    } catch {
      // An unreadable file is not a command.
    }
  }
  return commands;
}

const isTrusted = (cwd: string) => {
  try {
    return getStorage().getProjectTrust(cwd) === "trusted";
  } catch {
    return false;
  }
};

export type LoadOptions = {
  /** The project the prompt works in. */
  cwd: string;
  /** Marcsh's own command names: they win a name clash. */
  builtinNames?: readonly string[];
  /** Whether the project is trusted; read from the trust store when not given. */
  trusted?: boolean;
  /** Where the installed packs are. Default: marcsh's packs folder. */
  packsDir?: string;
};

/** The commands of every installed pack (by pack ID) that name an agent, read from the pack's generated view: what was scanned at install. */
function loadPackCommands(packsDir: string): UserCommand[] {
  let packs;
  try {
    packs = listPacks({ root: packsDir });
  } catch {
    return [];
  }
  return packs
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .flatMap((pack) => {
      const dir = join(packPluginDir(pack.id, packsDir), "commands");
      // A symlinked commands/ would read files outside the view.
      try {
        if (!lstatSync(dir).isDirectory()) return [];
      } catch {
        return [];
      }
      return readCommandDir(dir, "pack", pack.id);
    });
}

/**
 * The user's commands, sorted by name: the installed packs' commands that name an agent (the first pack by ID keeps a name), then
 * `~/.marcsh/commands/*.md`, which replace a pack's command of the same name, then the project's `.marcsh/commands/*.md`, which replace
 * a personal command of the same name. A project's commands are loaded only when the project is trusted. A name
 * that is one of marcsh's own is never a user command.
 */
export function loadUserCommands({ cwd, builtinNames = [], trusted, packsDir = packsRoot() }: LoadOptions): UserCommand[] {
  const byName = new Map<string, UserCommand>();
  for (const command of loadPackCommands(packsDir)) if (!byName.has(command.name)) byName.set(command.name, command);
  const project = (trusted ?? isTrusted(cwd)) ? readCommandDir(join(cwd, ".marcsh", "commands"), "project") : [];
  for (const command of [...readCommandDir(userCommandsDir(), "personal"), ...project]) byName.set(command.name, command);
  for (const name of builtinNames) byName.delete(name);
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Fills the template: `$ARGUMENTS` is all of `args`, `$1`..`$9` its whitespace-separated words (empty when missing). */
export function expandCommand(template: string, args: string): string {
  const words = args.split(/\s+/).filter((word) => word !== "");
  // One pass over the template, so a placeholder inside the arguments stays as typed.
  return template.replace(/\$ARGUMENTS|\$([1-9])/g, (_match, digit?: string) => (digit ? (words[Number(digit) - 1] ?? "") : args.trim()));
}

/** `/name rest of the line` → the name and what follows it (trimmed); null when the text does not start with a command name. */
export function parseInvocation(text: string): { name: string; args: string } | null {
  const match = /^\/([a-z0-9][a-z0-9\-_:]*)(?:\s+([\s\S]*))?$/.exec(text);
  return match ? { name: match[1]!, args: (match[2] ?? "").trim() } : null;
}

/** What to send for a typed user command, and what it asks of the turn. */
export type CommandTurn = {
  /** The expanded prompt: what the chat shows and the engine receives. */
  text: string;
  /** The agent the command names, for this turn only. */
  agent?: Agent;
  /** The model the command names, when the engine can use it, for this turn only. */
  model?: string;
  /** Something in the command's frontmatter that was not applied. */
  warning?: string;
};

export type TurnOptions = LoadOptions & {
  engine: string;
  agents: readonly Agent[];
};

/** A user's command may name any agent, by ID or by name (any case). */
function namedAgent(wanted: string, agents: readonly Agent[]): Agent | undefined {
  const name = wanted.toLowerCase();
  return agents.find((candidate) => candidate.id === wanted) ?? agents.find((candidate) => candidate.name.toLowerCase() === name);
}

/**
 * A pack's command may name a built-in (by ID or name) or one of its own pack's primary agents: by file name without `.md` or by name, in any
 * case. Never another pack's agent, one of the user's or a subagent: the pack's skills and hooks would not be the ones its command was written for.
 */
function packCommandAgent(wanted: string, pack: string, agents: readonly Agent[]): Agent | undefined {
  const name = wanted.toLowerCase();
  const builtin = agents.find((candidate) => !candidate.pack && (candidate.id === name || candidate.name.toLowerCase() === name));
  if (builtin) return builtin;
  const own = agents.filter((candidate) => candidate.pack === pack);
  const file = agentFileSlug(wanted);
  return (file ? own.find((candidate) => candidate.id === `${pack}/${file}`) : undefined) ?? own.find((candidate) => candidate.name.toLowerCase() === name);
}

/** The turn for `input` when it is one of the user's commands (`/name args`); null when it is not, so it is sent as typed. */
export function userCommandTurn(input: string, { engine, agents, ...load }: TurnOptions): CommandTurn | null {
  const invocation = parseInvocation(input.trim());
  if (!invocation) return null;
  // A pack command answers to the name of the engine's copy too, so typing that never runs the copy as the selected agent.
  const command = loadUserCommands(load).find((candidate) => candidate.name === invocation.name || candidate.engineName === invocation.name);
  if (!command) return null;

  const turn: CommandTurn = { text: expandCommand(command.template, invocation.args) };
  const warnings: string[] = [];
  if (command.agent) {
    const agent = command.pack ? packCommandAgent(command.agent, command.pack, agents) : namedAgent(command.agent, agents);
    if (agent) turn.agent = agent;
    else if (command.pack) warnings.push(`/${command.name}: ${command.pack} has no agent “${command.agent}”; the selected agent is used.`);
    else warnings.push(`/${command.name}: no agent named “${command.agent}”; the selected agent is used.`);
  }
  if (command.model) {
    if (agentModelFits(command.model, engine)) turn.model = command.model;
    else warnings.push(`/${command.name}: the model “${command.model}” does not fit this engine; the session model is used.`);
  }
  if (warnings.length > 0) turn.warning = warnings.join(" ");
  return turn;
}
