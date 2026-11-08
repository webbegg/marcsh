import type { Command } from "./types";
import { COMMANDS } from "./commands";
import { mergeCommands, type ClaudeCommand } from "../../lib/claude-commands";

/** Marcsh's commands, then the given Claude Code commands (marcsh wins name clashes). */
export function getMenuCommands(claude: ClaudeCommand[]): Command[] {
  return mergeCommands(COMMANDS, claude, (command) => ({
    name: command.name,
    description: command.description,
    value: `/${command.name}`,
    source: "claude",
    argumentHint: command.argumentHint,
  }));
}

export function getFilteredCommands(query: string, commands: Command[] = COMMANDS): Command[] {
  if (query.length === 0) return commands;
  return commands
    .filter((cmd) => cmd.name.toLowerCase().startsWith(query.toLowerCase()));
};
