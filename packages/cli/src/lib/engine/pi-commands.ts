import { resolve, sep } from "node:path";
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

/**
 * The text pi should get for what the user typed: a command listed under another name than pi's own (the
 * plugin's `/marcsh:feature`) is renamed to the one pi expands (`/feature`). Everything else, including the
 * arguments, is sent exactly as typed.
 */
export function resolvePiInvocation(text: string, commands: readonly PiCommand[]): string {
  const match = /^\/(\S+)/.exec(text);
  if (!match) return text;
  const command = commands.find((candidate) => candidate.name === match[1] && candidate.invoke !== candidate.name);
  return command ? `/${command.invoke}${text.slice(match[0].length)}` : text;
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
