import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ClaudeCommand } from "./claude-commands";

// From src/lib (bin/marcsh runs the sources) or from dist (the built bundle), relative to the running file's directory.
const CANDIDATES = ["../../plugin", "../plugin"];

/** Absolute path of the bundled marcsh Claude Code plugin, or null when it cannot be found. */
export function marcshPluginPath(baseDir: string = import.meta.dir): string | null {
  for (const candidate of CANDIDATES) {
    const path = join(baseDir, candidate);
    if (existsSync(join(path, ".claude-plugin", "plugin.json"))) return path;
  }
  return null;
}

const unquote = (value: string) => value.replace(/^(["'])(.*)\1$/, "$2");

// The `key: value` lines of a leading `---` block; anything else (nested YAML, no block) is ignored.
function frontmatter(file: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const match = readFileSync(file, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return fields;
  for (const line of match[1]!.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at > 0) fields[line.slice(0, at).trim()] = unquote(line.slice(at + 1).trim());
  }
  return fields;
}

/** A plugin command or skill: the menu entry, what it is, and the name its file or folder gives it outside Claude. */
export type PluginEntry = ClaudeCommand & {
  kind: "command" | "skill";
  /** A command's file name without `.md`; a skill's `name` field, else its folder name. */
  id: string;
};

function entry(file: string, kind: PluginEntry["kind"], fallbackName: string): PluginEntry | null {
  try {
    const fields = frontmatter(file);
    return {
      name: `marcsh:${fields.name || fallbackName}`,
      description: fields.description ?? "",
      argumentHint: fields["argument-hint"] ?? "",
      kind,
      id: kind === "command" ? fallbackName : fields.name || fallbackName,
    };
  } catch {
    return null;
  }
}

function listDir(path: string) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** The plugin's commands (`commands/*.md`) then skills (`skills/<dir>/SKILL.md`), read from disk. A missing or unreadable directory yields []. */
export function readPluginEntries(pluginPath: string): PluginEntry[] {
  const commands = listDir(join(pluginPath, "commands"))
    .filter((item) => item.isFile() && item.name.endsWith(".md"))
    .map((item) => entry(join(pluginPath, "commands", item.name), "command", basename(item.name, ".md")));
  const skills = listDir(join(pluginPath, "skills"))
    .filter((item) => item.isDirectory())
    .map((item) => entry(join(pluginPath, "skills", item.name, "SKILL.md"), "skill", item.name));
  return [...commands, ...skills].filter((found): found is PluginEntry => found !== null);
}

/**
 * The plugin's slash entries as the `/` menu shows Claude commands: `marcsh:<file>` for `commands/*.md`
 * and `marcsh:<skill>` for `skills/<dir>/SKILL.md`, read from disk. A missing or unreadable directory yields [].
 */
export function readPluginCommands(pluginPath: string): ClaudeCommand[] {
  return readPluginEntries(pluginPath).map(({ name, description, argumentHint }) => ({ name, description, argumentHint }));
}
