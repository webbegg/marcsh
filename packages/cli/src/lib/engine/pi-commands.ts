import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { ExtensionAPI, InlineExtension, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { ClaudeCommand } from "../claude-commands";
import { readPluginEntries } from "../plugin";

const PLUGIN_PREFIX = "marcsh:";

/** A command as the `/` menu lists it, plus the name pi knows it by when it differs (the plugin's commands). */
export type PiCommand = ClaudeCommand & { source: string; invoke: string };

// When two commands share a name pi runs the extension command first, then expands a template, then a skill.
const SOURCE_RANK: Record<string, number> = { extension: 0, prompt: 1, skill: 2 };

const isInside = (path: string, directory: string) => {
  const root = resolve(directory);
  const target = resolve(path);
  return target === root || target.startsWith(root + sep);
};

/**
 * Turns pi's command list (`SlashCommandInfo`: extension commands, prompt templates, skills; never pi's
 * interactive-only built-ins) into menu entries tagged with their pi source. The marcsh plugin's template and
 * skill, loaded from `pluginPath`, are listed under their Claude names (`marcsh:feature`, `marcsh:workflow`).
 * Entries without a name or with an unknown source are skipped; on a repeated name the one pi runs wins.
 */
export function normalizePiCommands(infos: readonly SlashCommandInfo[], pluginPath?: string | null): PiCommand[] {
  const seen = new Set<string>();
  const commands: PiCommand[] = [];
  const usable = infos
    .filter((item) => typeof item === "object" && item !== null && item.source in SOURCE_RANK)
    .map((item, index) => ({ item, index }))
    .sort((a, b) => SOURCE_RANK[a.item.source]! - SOURCE_RANK[b.item.source]! || a.index - b.index);

  for (const { item } of usable) {
    const invoke = String(item.name ?? "").trim().replace(/^\/+/, "");
    if (invoke === "") continue;

    const fromPlugin = pluginPath && item.sourceInfo?.path && isInside(item.sourceInfo.path, pluginPath);
    const name = fromPlugin ? `${PLUGIN_PREFIX}${invoke.replace(/^skill:/, "")}` : invoke;
    if (seen.has(name)) continue;
    seen.add(name);
    commands.push({ name, invoke, description: item.description ?? "", argumentHint: "", source: item.source });
  }
  return commands;
}

/** What the cache and the menu keep of a command. */
export function toMenuCommands(commands: readonly PiCommand[]): ClaudeCommand[] {
  return commands.map(({ name, description, argumentHint, source }) => ({ name, description, argumentHint, source }));
}

/**
 * The marcsh plugin's entries as pi lists them, read from disk, so the menu has them before any pi session
 * has listed its commands: `marcsh:feature` is a template, `marcsh:workflow` a skill.
 */
export function bundledPiCommands(pluginPath: string): ClaudeCommand[] {
  return readPluginEntries(pluginPath).map((entry) => ({
    name: `${PLUGIN_PREFIX}${entry.id}`,
    description: entry.description,
    argumentHint: entry.argumentHint,
    source: entry.kind === "command" ? "prompt" : "skill",
  }));
}

// pi 1.5.0 does not export its template expansion (`core/prompt-templates.js`: parseCommandArgs, substituteArgs,
// expandPromptTemplate are not in `dist/index.js`), so its rules are mirrored here.

/** Bash-style argument split with quotes; mirrors pi's `parseCommandArgs` (prompt-templates.js:11). */
function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  // A token has started even when it is a quoted empty string.
  let hasToken = false;
  let inQuote: string | null = null;
  for (const char of argsString) {
    if (inQuote) {
      if (char === inQuote) inQuote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      inQuote = char;
      hasToken = true;
    } else if (/\s/.test(char)) {
      if (hasToken) {
        args.push(current);
        current = "";
        hasToken = false;
      }
    } else {
      current += char;
      hasToken = true;
    }
  }
  if (hasToken) args.push(current);
  return args;
}

/**
 * `$1`, `$@`, `$ARGUMENTS`, `${N:-default}`, `${@:-default}`, `${@:N}` and `${@:N:L}` in a template; mirrors pi's
 * `substituteArgs` (prompt-templates.js:61). Values are never substituted again.
 */
function substituteArgs(content: string, args: string[]): string {
  const allArgs = args.join(" ");
  return content.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_match, defaultTarget?: string, defaultValue?: string, sliceStart?: string, sliceLength?: string, simple?: string) => {
      if (defaultTarget) {
        const value = defaultTarget === "@" || defaultTarget === "ARGUMENTS" ? allArgs : args[parseInt(defaultTarget, 10) - 1];
        return value ? value : defaultValue!;
      }
      if (sliceStart) {
        // The user counts from 1; 0 is read as 1, as in bash.
        const start = Math.max(0, parseInt(sliceStart, 10) - 1);
        return (sliceLength ? args.slice(start, start + parseInt(sliceLength, 10)) : args.slice(start)).join(" ");
      }
      if (simple === "ARGUMENTS" || simple === "@") return allArgs;
      return args[parseInt(simple!, 10) - 1] ?? "";
    },
  );
}

const readFile = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/**
 * What `/marcsh:feature args` and `/marcsh:workflow args` send to the model on pi, built here from the plugin's
 * own files so that a user or project resource with pi's plain name (`feature`, `skill:workflow`) cannot take
 * their place. A command is expanded like pi expands a prompt template (`expandPromptTemplate`,
 * prompt-templates.js:252: body without frontmatter, then `substituteArgs` over `parseCommandArgs`); a skill like
 * pi's `/skill:<name> args` (`AgentSession._expandSkillCommand`, agent-session.js:1745): a `<skill>` block with
 * the body, then the trimmed arguments. Unlike pi, whitespace of any kind (not only a space) may separate the
 * name from the arguments, for skills too. Any other text, or a plugin entry that cannot be read, comes back as typed.
 *
 * `stripFrontmatter` is pi's own (loaded lazily by the caller), so frontmatter is cut exactly as pi cuts it.
 */
export function expandPluginInvocation(text: string, pluginPath: string | null, stripFrontmatter: (content: string) => string): string {
  if (!pluginPath) return text;
  const match = /^\/marcsh:([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return text;
  const entry = readPluginEntries(pluginPath).find((candidate) => candidate.id === match[1]);
  if (!entry) return text;
  const content = readFile(entry.file);
  if (content === null) return text;

  const argsString = match[2] ?? "";
  if (entry.kind === "command") return substituteArgs(stripFrontmatter(content), parseCommandArgs(argsString));

  const block = `<skill name="${entry.id}" location="${entry.file}">\nReferences are relative to ${dirname(entry.file)}.\n\n${stripFrontmatter(content).trim()}\n</skill>`;
  const args = argsString.trim();
  return args ? `${block}\n\n${args}` : block;
}

/** An inline extension that remembers pi's extension API, so the session's command list can be read later. */
export function createCommandLister(): { extension: InlineExtension; list(): SlashCommandInfo[] } {
  let api: ExtensionAPI | undefined;
  return {
    extension: {
      name: "marcsh-commands",
      hidden: true,
      factory: (pi) => {
        api = pi;
      },
    },
    list() {
      try {
        return api?.getCommands() ?? [];
      } catch {
        return [];
      }
    },
  };
}
