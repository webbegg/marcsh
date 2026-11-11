import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { Mode, type ModeType } from "./modes";

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
  /** Where the agent comes from: "user" for ~/.marcsh/agents; undefined for the built-ins. */
  pack?: string;
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

type Frontmatter = { fields: Map<string, string | null>; body: string };

// A small reader for flat frontmatter: `key: value` lines, quoted values, and `|`/`>` blocks. An indented block under a key
// is a nested map or list, which marcsh never applies, so it is recorded as null.
function readFrontmatter(text: string): Frontmatter {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const fields = new Map<string, string | null>();
  if (lines[0]?.trim() !== "---") return { fields, body: text };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return { fields, body: text };

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
  return { fields, body: lines.slice(end + 1).join("\n") };
}

const KNOWN_FIELDS = new Set(["name", "description", "mode", "permission", "model"]);

function slug(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Parses one agent file; null when it is a subagent (not selectable). */
export function parseAgentFile(text: string, { pack, file }: { pack: string; file: string }): Agent | null {
  const { fields, body } = readFrontmatter(text);
  const ignored = [...fields.keys()].filter((key) => !KNOWN_FIELDS.has(key));

  const kind = fields.get("mode");
  if (kind === "subagent") return null;
  if (kind !== undefined && kind !== "primary" && kind !== "all") ignored.push("mode");

  const permission = fields.get("permission");
  if (permission !== undefined && permission !== "read-only" && permission !== "build") ignored.push("permission");

  const stem = basename(file, extname(file));
  const field = (key: string) => fields.get(key)?.trim() || undefined;
  const prompt = body.trim();
  return {
    id: `${pack}/${slug(stem)}`,
    name: field("name") ?? stem,
    description: field("description"),
    mode: permission === "read-only" ? Mode.PLAN : Mode.BUILD,
    prompt: prompt || undefined,
    model: field("model"),
    pack,
    ignored,
  };
}

/** The built-ins, then the selectable agents in `dir` (sorted by file name). Unreadable files are skipped. */
export function loadAgents(dir = agentsDir()): Agent[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".md")).sort();
  } catch {
    return [...BUILTIN_AGENTS];
  }
  const loaded: Agent[] = [];
  for (const file of files) {
    try {
      const path = join(dir, file);
      if (!statSync(path).isFile()) continue;
      const agent = parseAgentFile(readFileSync(path, "utf8"), { pack: "user", file });
      if (agent) loaded.push(agent);
    } catch {}
  }
  return [...BUILTIN_AGENTS, ...loaded];
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

/** Whether `engineId` can use the agent's model: pi takes "provider/id", Claude takes its own names. */
export function agentModelFits(model: string, engineId: string) {
  return engineId === "pi" ? PI_MODEL_REF.test(model) : !model.includes("/");
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
