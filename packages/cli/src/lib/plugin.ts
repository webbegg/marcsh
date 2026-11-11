import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { readFrontmatter } from "./agent-file";
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

/** A plugin command or skill: the menu entry, what it is, and the name its file or folder gives it outside Claude. */
export type PluginEntry = ClaudeCommand & {
  kind: "command" | "skill";
  /** A command's file name without `.md`; a skill's `name` field, else its folder name. */
  id: string;
  /** The `.md` file the entry was read from: the command's file or the skill's `SKILL.md`. */
  file: string;
};

function entry(file: string, kind: PluginEntry["kind"], fallbackName: string): PluginEntry | null {
  try {
    const { fields } = readFrontmatter(readFileSync(file, "utf8"));
    // A key with a nested block has no text value.
    const text = (key: string) => fields.get(key) ?? "";
    return {
      name: `marcsh:${text("name") || fallbackName}`,
      description: text("description"),
      argumentHint: text("argument-hint"),
      kind,
      id: kind === "command" ? fallbackName : text("name") || fallbackName,
      file,
    };
  } catch {
    return null;
  }
}

export function listDir(path: string) {
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
