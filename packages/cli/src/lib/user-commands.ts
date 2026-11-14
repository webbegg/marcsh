import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentModelFits, type Agent } from "./agents";
import { MAX_AGENT_BYTES, readFrontmatter } from "./agent-file";
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
  /** `personal` for `~/.marcsh/commands`, `project` for `<project>/.marcsh/commands`. */
  source: "personal" | "project";
};

/** Where the user's own commands live: global, next to the agents. */
export function userCommandsDir() {
  return process.env.MARCSH_COMMANDS_DIR?.trim() || join(homedir(), ".marcsh", "commands");
}

const firstLine = (text: string) => text.split("\n").find((line) => line.trim() !== "")?.trim().slice(0, 80) ?? "";

function readCommandDir(dir: string, source: UserCommand["source"]): UserCommand[] {
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
      // A project is third-party content: a link in it must not pull in a file from elsewhere.
      const info = source === "project" ? lstatSync(path) : statSync(path);
      if (!info.isFile() || info.size > MAX_AGENT_BYTES) continue;
      const { fields, body } = readFrontmatter(readFileSync(path, "utf8"));
      const template = body.trim();
      if (template === "") continue;
      const field = (key: string) => fields.get(key)?.trim() || undefined;
      commands.push({
        name,
        description: field("description") ?? firstLine(template),
        template,
        agent: field("agent"),
        model: field("model"),
        source,
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
};

/**
 * The user's commands, sorted by name: `~/.marcsh/commands/*.md`, then the project's `.marcsh/commands/*.md`, which replace
 * a personal command of the same name. A project's commands are loaded only when the project is trusted. A name
 * that is one of marcsh's own is never a user command.
 */
export function loadUserCommands({ cwd, builtinNames = [], trusted }: LoadOptions): UserCommand[] {
  const byName = new Map<string, UserCommand>();
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

/** The turn for `input` when it is one of the user's commands (`/name args`); null when it is not, so it is sent as typed. */
export function userCommandTurn(input: string, { engine, agents, ...load }: TurnOptions): CommandTurn | null {
  const invocation = parseInvocation(input.trim());
  if (!invocation) return null;
  const command = loadUserCommands(load).find((candidate) => candidate.name === invocation.name);
  if (!command) return null;

  const turn: CommandTurn = { text: expandCommand(command.template, invocation.args) };
  const warnings: string[] = [];
  if (command.agent) {
    const wanted = command.agent.toLowerCase();
    const agent = agents.find((candidate) => candidate.id === command.agent) ?? agents.find((candidate) => candidate.name.toLowerCase() === wanted);
    if (agent) turn.agent = agent;
    else warnings.push(`/${command.name}: no agent named “${command.agent}”; the selected agent is used.`);
  }
  if (command.model) {
    if (agentModelFits(command.model, engine)) turn.model = command.model;
    else warnings.push(`/${command.name}: the model “${command.model}” does not fit this engine; the session model is used.`);
  }
  if (warnings.length > 0) turn.warning = warnings.join(" ");
  return turn;
}
