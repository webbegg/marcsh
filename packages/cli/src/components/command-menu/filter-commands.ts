import type { Command } from "./types";
import { COMMANDS } from "./commands";
import { mergeCommands, type ClaudeCommand } from "../../lib/claude-commands";
import type { UserCommand } from "../../lib/user-commands";

/** The menu's tag for a user command: where it comes from, a pack's command by the pack's repository name. */
const userSource = (command: UserCommand) => (command.pack ? (command.pack.split("/")[1] ?? command.pack) : command.source);

export const GROUP_MARCSH = "marcsh";
export const GROUP_USER = "packs & custom";
// The `source` words the engines tag their commands with (Claude's, and pi's extension, prompt template and skill).
const PI_SOURCES = new Set(["extension", "prompt", "skill"]);

/** The group the `/` menu lists a command under: marcsh's own (no source), the user's packs and files, or the engine it comes from. */
export function groupOf(command: Pick<Command, "source">): string {
  const source = command.source;
  if (!source) return GROUP_MARCSH;
  if (source === "claude") return "claude";
  if (PI_SOURCES.has(source)) return "pi";
  return GROUP_USER;
}

const groupRank = (command: Command) => {
  const group = groupOf(command);
  return group === GROUP_MARCSH ? 0 : group === GROUP_USER ? 1 : 2;
};

/**
 * Marcsh's commands, then the user's (packs' included) and the given engine's commands (marcsh wins name clashes, then the user's own).
 * The engine's copy of a pack command marcsh runs (Claude's `<plugin>:<name>`) is not listed a second time, nor that of a pack command
 * hidden by a clash (`hidden`). Commands without a source are Claude's. The commands on the open session (`scope: "session"`) are left
 * out with `inSession` false. Given an `engine`, the commands that do not work on it (`engines` without it) are left out too; no engine, no
 * filtering. The list is kept in group order (see `groupOf`) so the `/` menu can head the groups: marcsh's own in their usual order, the others by name.
 */
export function getMenuCommands(
  claude: ClaudeCommand[],
  user: UserCommand[] = [],
  inSession = true,
  hidden: readonly UserCommand[] = [],
  engine?: string,
): Command[] {
  const own = new Set([
    ...user.flatMap((command) => (command.engineName ? [command.name, command.engineName] : [command.name])),
    ...hidden.flatMap((command) => (command.engineName ? [command.engineName] : [])),
  ]);
  const fromUser = user.map((command) => ({ name: command.name, description: command.description, argumentHint: command.argumentHint ?? "", source: userSource(command) }));
  const merged = mergeCommands(COMMANDS, [...fromUser, ...claude.filter((command) => !own.has(command.name))], (command) => ({
    name: command.name,
    description: command.description,
    value: `/${command.name}`,
    source: command.source ?? "claude",
    argumentHint: command.argumentHint,
  }));
  // Left out of the menu only: their names stay taken, so neither a user's nor an engine's command can claim one.
  const listed = merged.filter(
    (command) => (inSession || command.scope !== "session") && (engine === undefined || !command.engines || (command.engines as readonly string[]).includes(engine)),
  );
  // Array.prototype.sort is stable: inside a group the merge's order (marcsh's as written, the rest by name) stays.
  return listed.sort((a, b) => groupRank(a) - groupRank(b));
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
