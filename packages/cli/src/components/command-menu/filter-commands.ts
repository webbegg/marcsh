import type { Command } from "./types";
import { COMMANDS } from "./commands";
import { mergeCommands, type ClaudeCommand } from "../../lib/claude-commands";
import type { UserCommand } from "../../lib/user-commands";

/**
 * Marcsh's commands, then the user's and the given engine's commands (marcsh wins name clashes, then the user's own).
 * Commands without a source are Claude's. The commands on the open session (`scope: "session"`) are left out with `inSession` false.
 */
export function getMenuCommands(claude: ClaudeCommand[], user: UserCommand[] = [], inSession = true): Command[] {
  const own = new Set(user.map((command) => command.name));
  const fromUser = user.map((command) => ({ name: command.name, description: command.description, argumentHint: "", source: command.source }));
  const merged = mergeCommands(COMMANDS, [...fromUser, ...claude.filter((command) => !own.has(command.name))], (command) => ({
    name: command.name,
    description: command.description,
    value: `/${command.name}`,
    source: command.source ?? "claude",
    argumentHint: command.argumentHint,
  }));
  // Left out of the menu only: their names stay taken, so neither a user's nor an engine's command can claim one.
  return inSession ? merged : merged.filter((command) => command.scope !== "session");
}

const WORD_BOUNDARY = /[:\-_/. ]/;

/**
 * Fuzzy score of `query` against `text`: the query's characters must appear in order.
 * Prefix, word-start (after `:`, `-`, `_`, `/`, `.`, space) and consecutive matches score higher;
 * gaps between matches cost a point each. Returns null when the characters are not all present.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let best: number | null = null;

  // Try each occurrence of the first character as the start, matching the rest greedily.
  for (let start = t.indexOf(q[0]!); start !== -1; start = t.indexOf(q[0]!, start + 1)) {
    let score = 0;
    let previous = -1;
    let position = start;

    for (let i = 0; i < q.length; i++) {
      position = i === 0 ? start : t.indexOf(q[i]!, previous + 1);
      if (position === -1) break;

      score += 1;
      if (position === 0) score += 8;
      else if (WORD_BOUNDARY.test(t[position - 1]!)) score += 6;
      if (previous !== -1) {
        if (position === previous + 1) score += 4;
        else score -= position - previous - 1;
      }
      previous = position;
    }

    if (position !== -1 && (best === null || score > best)) best = score;
  }

  return best;
}

export function getFilteredCommands(query: string, commands: Command[] = COMMANDS): Command[] {
  if (query.length === 0) return commands;
  return commands
    .map((command, index) => ({ command, index, score: fuzzyScore(query, command.name) }))
    .filter((entry): entry is typeof entry & { score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.command);
};
