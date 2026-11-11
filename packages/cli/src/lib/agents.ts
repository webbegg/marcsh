import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { Mode, type ModeType } from "./modes";
import { listPacks, packAgentsDir, packPluginDir, packsRoot, printable } from "./packs";

/** An agent file larger than this is not read (a pack is third-party content). */
export const MAX_AGENT_BYTES = 256 * 1024;

/**
 * A selectable agent: Tab cycles them and `/agents` lists them. Build and Plan are built in; the rest are markdown files with
 * OpenCode-style frontmatter. `mode` is the permission profile both engines already understand: PLAN only reads, BUILD asks
 * before it writes or runs.
 */
export type Agent = {
  /** "build" and "plan" for the built-ins, "<pack>/<file stem>" for the rest. */
  id: string;
  name: string;
  description?: string;
  mode: ModeType;
  /** Appended to the engine's own system prompt, never in place of it. */
  prompt?: string;
  /** The model this agent asks for; the session model is used when absent or unusable on the engine. */
  model?: string;
  /** Where the agent comes from: "user" for ~/.marcsh/agents, "owner/repo" for an installed pack; undefined for the built-ins. */
  pack?: string;
  /** A pack agent's generated plugin view (its skills and commands): loaded by the engines only while this agent is selected. */
  pluginDir?: string;
  /** Frontmatter fields marcsh reads but does not apply. */
  ignored: string[];
};

export const BUILTIN_AGENTS: readonly Agent[] = [
  { id: "build", name: "Build", description: "Edits files and runs commands, asking first", mode: Mode.BUILD, ignored: [] },
  { id: "plan", name: "Plan", description: "Reads and plans; changes nothing", mode: Mode.PLAN, ignored: [] },
];

const BUILD_AGENT = BUILTIN_AGENTS[0]!;

/** Where the user's own agents live; global only, never inside a project. */
export function agentsDir() {
  return process.env.MARCSH_AGENTS_DIR?.trim() || join(homedir(), ".marcsh", "agents");
}

type Frontmatter = { fields: Map<string, string | null>; body: string; unclosed: boolean };

// A small reader for flat frontmatter: `key: value` lines, quoted values, and `|`/`>` blocks. An indented block under a key
// is a nested map or list, which marcsh never applies, so it is recorded as null.
function readFrontmatter(text: string): Frontmatter {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const fields = new Map<string, string | null>();
  if (lines[0]?.trim() !== "---") return { fields, body: text, unclosed: false };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  // An opening line with no closing one: the whole file stays the prompt, and the caller reports it.
  if (end < 0) return { fields, body: text, unclosed: true };

  let key: string | undefined;
  let block: { style: string; lines: string[] } | undefined;
  const closeBlock = () => {
    if (key && block) fields.set(key, block.lines.join(block.style.startsWith("|") ? "\n" : " ").trim());
    block = undefined;
  };
  for (const line of lines.slice(1, end)) {
    const top = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (top) {
      closeBlock();
      key = top[1]!;
      const value = top[2]!.trim();
      if (/^[|>][-+]?$/.test(value)) block = { style: value, lines: [] };
      fields.set(key, value.replace(/^(["'])(.*)\1$/, "$2"));
    } else if (key && /^[ \t]/.test(line) && line.trim()) {
      if (block) block.lines.push(line.trim());
      else fields.set(key, null);
    }
  }
  closeBlock();
  return { fields, body: lines.slice(end + 1).join("\n"), unclosed: false };
}

const KNOWN_FIELDS = new Set(["name", "description", "mode", "permission", "model"]);

function slug(text: string) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "");
}

/** The ID part of an agent file: its slug, else (a name with no letters or digits) a short hash of the file name, which is stable. */
const idPart = (stem: string, file: string) => slug(stem) || createHash("sha1").update(file).digest("hex").slice(0, 8);

/** Parses one agent file; null when it is a subagent (not selectable). */
export function parseAgentFile(text: string, { pack, file }: { pack: string; file: string }): Agent | null {
  const { fields, body, unclosed } = readFrontmatter(text);
  const ignored = [...fields.keys()].filter((key) => !KNOWN_FIELDS.has(key));
  if (unclosed) ignored.push("frontmatter");

  const kind = fields.get("mode");
  if (kind === "subagent") return null;
  if (kind !== undefined && kind !== "primary" && kind !== "all") ignored.push("mode");

  const permission = fields.get("permission");
  if (permission !== undefined && permission !== "read-only" && permission !== "build") ignored.push("permission");

  const stem = basename(file, extname(file));
  const field = (key: string) => fields.get(key)?.trim() || undefined;
  const prompt = body.trim();
  return {
    id: `${pack}/${idPart(stem, file)}`,
    name: field("name") ?? stem,
    description: field("description"),
    mode: permission === "read-only" ? Mode.PLAN : Mode.BUILD,
    prompt: prompt || undefined,
    model: field("model"),
    pack,
    ignored,
  };
}

function readAgentDir(dir: string, pack: string, { untrusted }: { untrusted: boolean }): Agent[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const loaded: Agent[] = [];
  for (const file of files) {
    try {
      const path = join(dir, file);
      // A pack's file is read only when it is a regular file in the clone: a link could point at any file of the user's.
      const stat = untrusted ? lstatSync(path) : statSync(path);
      if (!stat.isFile() || (untrusted && stat.size > MAX_AGENT_BYTES)) continue;
      const agent = parseAgentFile(readFileSync(path, "utf8"), { pack, file });
      if (!agent) continue;
      // A pack's names are shown in the status line and the menus: no escape sequence may get through.
      loaded.push(
        untrusted
          ? {
              ...agent,
              name: printable(agent.name),
              description: agent.description && printable(agent.description),
              model: agent.model && printable(agent.model),
              ignored: agent.ignored.map(printable),
            }
          : agent,
      );
    } catch {}
  }
  return loaded;
}

/**
 * The built-ins, then the selectable agents in `dir` (sorted by file name), then those of every installed pack (by pack ID).
 * Unreadable files are skipped.
 */
export function loadAgents(dir = agentsDir(), packsDir = packsRoot()): Agent[] {
  const user = readAgentDir(dir, "user", { untrusted: false });
  const packs = listPacks({ root: packsDir })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .flatMap((pack) => {
      const agentsPath = packAgentsDir(pack.id, packsDir);
      // A symlinked agents/ directory would read files outside the pack.
      try {
        if (!lstatSync(agentsPath).isDirectory()) return [];
      } catch {
        return [];
      }
      const pluginDir = packPluginDir(pack.id, packsDir);
      return readAgentDir(agentsPath, pack.id, { untrusted: true }).map((agent) => ({ ...agent, pluginDir }));
    });
  // Two files can slug to the same ID ("My Agent.md", "my-agent.md"), which would trap Tab and repeat a key. Files are sorted, so the
  // first one keeps the ID.
  const taken = new Set<string>();
  return [...BUILTIN_AGENTS, ...user, ...packs].filter((agent) => {
    if (taken.has(agent.id)) return false;
    taken.add(agent.id);
    return true;
  });
}

/** The agent with this ID, else Build. */
export function findAgent(agents: readonly Agent[], id: string | undefined): Agent {
  return agents.find((agent) => agent.id === id) ?? agents[0] ?? BUILD_AGENT;
}

/** The agent Tab moves to: the next one, wrapping around. */
export function nextAgent(agents: readonly Agent[], currentId: string): Agent {
  const index = agents.findIndex((agent) => agent.id === currentId);
  return agents[(index + 1) % agents.length] ?? BUILD_AGENT;
}

/** The short name, or "<pack>/<name>" when another agent has the same name. Built-ins always keep their name. */
export function agentLabel(agent: Agent, agents: readonly Agent[]): string {
  if (!agent.pack) return agent.name;
  const name = agent.name.toLowerCase();
  const clash = agents.some((other) => other !== agent && other.name.toLowerCase() === name);
  return clash ? `${agent.pack}/${agent.name}` : agent.name;
}

const PI_MODEL_REF = /^[^/\s]+\/\S+$/;
// Claude Code's model aliases, with the optional `[1m]`-style suffix.
const CLAUDE_ALIAS = /^(?:default|opus|sonnet|haiku|opusplan)(?:\[[^\]\s/]*\])?$/i;

/** Whether `engineId` can use the agent's model: pi takes "provider/id", Claude takes `claude-*` names and its aliases. */
export function agentModelFits(model: string, engineId: string) {
  if (engineId === "pi") return PI_MODEL_REF.test(model);
  return !model.includes("/") && (/^claude/i.test(model) || CLAUDE_ALIAS.test(model));
}

/** One line per part of the agent that the engine will not apply; shown when the agent is selected. */
export function agentWarnings(agent: Agent, engineId: string): string[] {
  const warnings: string[] = [];
  if (agent.ignored.length > 0) warnings.push(`${agent.name}: ignored ${agent.ignored.join(", ")}`);
  if (agent.model && !agentModelFits(agent.model, engineId)) {
    warnings.push(`${agent.name}: model "${agent.model}" is ignored on ${engineId}; the session model is used`);
  }
  return warnings;
}
