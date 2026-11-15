import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentModelFits, type Agent } from "./agents";
import { Mode } from "./modes";
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
  /** The agent (ID or name) the turn runs as; the selected agent when absent. A pack command's empty `agent:` is "" (it warns). */
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
      // A pack command with an empty `agent:` stays marcsh's (it warns when run) rather than going back to the engine's copy unnoticed.
      const agent = field("agent") ?? (pack && fields.has("agent") ? "" : undefined);
      if (pack && agent === undefined) continue;
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
  /** The engine's command names as marcsh knows them (Claude's or pi's built-ins, plugins, templates): they win a clash with a pack's command. */
  engineNames?: readonly string[];
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

/** The clashes of hidden pack commands already said, so each is said once per run. */
const noticedClashes = new Set<string>();
let pendingNotices: string[] = [];

/** What was hidden since the last call, each clash once per run: the screen that lists the commands says so in a toast. */
export function takePackCommandNotices(): string[] {
  const notices = pendingNotices;
  pendingNotices = [];
  return notices;
}

/** The name a pack command that lost a clash is reachable by: `<repo>:<name>` (`flows:review` for acme/flows' `review`). */
const prefixedName = (command: UserCommand) => `${(command.pack!.split("/")[1] ?? command.pack!).toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}:${command.name}`;

/**
 * The user's commands, sorted by name: `~/.marcsh/commands/*.md`, then the project's `.marcsh/commands/*.md`, which replace a personal
 * command of the same name, then the installed packs' commands that name an agent. A project's commands are loaded only when the project
 * is trusted. A name that is one of marcsh's own is never a user command.
 *
 * A pack's command keeps its name only when no other command has it: marcsh's, the engine's (`engineNames`, the pack's own copy aside),
 * the user's, or an earlier pack's (by ID). One that loses is listed as `<repo>:<name>` instead, and is hidden, with a notice (see
 * `takePackCommandNotices`), when that name is taken too.
 */
export function loadUserCommands(options: LoadOptions): UserCommand[] {
  return loadCommandSet(options).commands;
}

/**
 * The listed commands (`loadUserCommands`) and the pack commands hidden by a clash. A hidden command's engine copy (Claude's
 * `<plugin name>:<name>`) is not listed in the menu either, and typing that name runs marcsh's command, never the raw copy.
 */
export function loadCommandSet({ cwd, builtinNames = [], engineNames = [], trusted, packsDir = packsRoot() }: LoadOptions): { commands: UserCommand[]; hidden: UserCommand[] } {
  const byName = new Map<string, UserCommand>();
  const project = (trusted ?? isTrusted(cwd)) ? readCommandDir(join(cwd, ".marcsh", "commands"), "project") : [];
  for (const command of [...readCommandDir(userCommandsDir(), "personal"), ...project]) byName.set(command.name, command);
  for (const name of builtinNames) byName.delete(name);

  const packCommands = loadPackCommands(packsDir);
  const copies = new Set(packCommands.map((command) => command.engineName!.toLowerCase()));
  const taken = new Set([...builtinNames, ...engineNames].map((name) => name.toLowerCase()).filter((name) => !copies.has(name)));
  for (const name of byName.keys()) taken.add(name);
  const lost: UserCommand[] = [];
  const hidden: UserCommand[] = [];
  for (const command of packCommands) {
    if (taken.has(command.name)) lost.push(command);
    else {
      taken.add(command.name);
      byName.set(command.name, command);
    }
  }
  for (const command of lost) {
    const name = prefixedName(command);
    if (NAME.test(name) && !taken.has(name)) {
      taken.add(name);
      byName.set(name, { ...command, name });
      continue;
    }
    hidden.push(command);
    const clash = `${command.pack}'s /${command.name} is hidden: /${command.name} and /${name} are already other commands.`;
    if (!noticedClashes.has(clash)) {
      noticedClashes.add(clash);
      pendingNotices.push(clash);
    }
  }
  return { commands: [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)), hidden };
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
  /** What the turn does differently from what the command asks, to tell the user (a pack command kept read-only by the selected agent). */
  notice?: string;
};

export type TurnOptions = LoadOptions & {
  engine: string;
  agents: readonly Agent[];
  /** The selected agent. A read-only one (Plan) keeps a pack command's build agent read-only for the turn. */
  selected?: Agent;
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
export function userCommandTurn(input: string, { engine, agents, selected, ...load }: TurnOptions): CommandTurn | null {
  const invocation = parseInvocation(input.trim());
  if (!invocation) return null;
  // A pack command answers to the name of the engine's copy too (also when the command itself is hidden), so typing that never runs the
  // copy as the selected agent.
  const { commands, hidden } = loadCommandSet(load);
  const command =
    commands.find((candidate) => candidate.name === invocation.name || candidate.engineName === invocation.name) ??
    hidden.find((candidate) => candidate.engineName === invocation.name);
  if (!command) return null;

  const turn: CommandTurn = { text: expandCommand(command.template, invocation.args) };
  const warnings: string[] = [];
  if (command.agent === "") warnings.push(`/${command.name}: ${command.pack} names no agent (its agent: is empty); the selected agent is used.`);
  else if (command.agent) {
    const agent = command.pack ? packCommandAgent(command.agent, command.pack, agents) : namedAgent(command.agent, agents);
    // L6: a pack command never relaxes a read-only selected agent. Its agent's prompt, skills and subagents answer, under plan's rules.
    if (agent && command.pack && selected?.mode === Mode.PLAN && agent.mode !== Mode.PLAN) {
      turn.agent = { ...agent, mode: Mode.PLAN };
      turn.notice = `/${command.name} runs as ${agent.name} in ${selected.name} (read-only): switch to Build to let it change files.`;
    } else if (agent) turn.agent = agent;
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
