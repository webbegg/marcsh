/** A Claude Code command or skill as the `/` menu shows it (the SDK's `SlashCommand`, minus what the menu doesn't use). */
export type ClaudeCommand = {
  /** Without the leading slash. */
  name: string;
  description: string;
  argumentHint: string;
};

const text = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * Turns the SDK's `SlashCommand[]` (or what was persisted) into menu entries.
 * Unusable entries are skipped; rows that share a name collapse to the builtin row, else the first.
 */
export function normalizeClaudeCommands(raw: unknown): ClaudeCommand[] {
  if (!Array.isArray(raw)) return [];

  const byName = new Map<string, { command: ClaudeCommand; builtin: boolean }>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const name = text(row.name).trim().replace(/^\/+/, "");
    if (name === "") continue;

    const builtin = row.builtin === true;
    const known = byName.get(name);
    if (known && (known.builtin || !builtin)) continue;
    byName.set(name, {
      command: { name, description: text(row.description), argumentHint: text(row.argumentHint) },
      builtin,
    });
  }
  return [...byName.values()].map((entry) => entry.command);
}

/** The cached list plus the bundled plugin's entries it lacks; a cached entry wins on the same name (exact CLI text). */
export function combineClaudeCommands(cached: ClaudeCommand[], bundled: ClaudeCommand[]): ClaudeCommand[] {
  const known = new Set(cached.map((command) => command.name));
  return [...cached, ...bundled.filter((command) => !known.has(command.name))];
}

/**
 * Marcsh's own commands first, in their order, then Claude's sorted by name.
 * A Claude command whose name matches a marcsh one (any case) is dropped: marcsh wins.
 */
export function mergeCommands<T extends { name: string }>(
  own: T[],
  claude: ClaudeCommand[],
  toEntry: (command: ClaudeCommand) => T,
): T[] {
  const taken = new Set(own.map((command) => command.name.toLowerCase()));
  const extra = claude
    .filter((command) => !taken.has(command.name.toLowerCase()))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(toEntry);
  return [...own, ...extra];
}

/**
 * How a submitted text is handled: `marcsh` runs marcsh's own command (arguments are ignored),
 * `claude` is sent to `query()` verbatim as a Claude Code command or skill, `text` is a normal prompt.
 */
export function slashInputKind(input: string, ownNames: string[]): "marcsh" | "claude" | "text" {
  const match = /^\/(\S+)/.exec(input);
  if (!match) return "text";
  return ownNames.includes(match[1]!) ? "marcsh" : "claude";
}
