import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_AGENT_BYTES, parseAgentFile, type Agent } from "./agent-file";
import { unsupportedGroups } from "./agent-tools";
import { Mode, type ModeType } from "./modes";
import { hookEngines, hookEvents } from "./pack-hooks";
import { inspectPackHooks, listPacks, packAgentsDir, packPluginDir, packsRoot, packViewLocation } from "./packs";
import { printable } from "./safe-text";

// Other modules import the agent type and the file parser from here.
export { parseAgentFile, type Agent };

export const BUILD_AGENT_ID = "build";
export const PLAN_AGENT_ID = "plan";

export const BUILTIN_AGENTS: readonly Agent[] = [
  { id: BUILD_AGENT_ID, name: "Build", description: "Edits files and runs commands, asking first", mode: Mode.BUILD, ignored: [] },
  { id: PLAN_AGENT_ID, name: "Plan", description: "Reads and plans; changes nothing", mode: Mode.PLAN, ignored: [] },
];

const BUILD_AGENT = BUILTIN_AGENTS[0]!;

/** The ID of the built-in agent that runs in `mode`. */
export const builtinAgentId = (mode: ModeType) => (mode === Mode.PLAN ? PLAN_AGENT_ID : BUILD_AGENT_ID);

/** Where the user's own agents live; global only, never inside a project. */
export function agentsDir() {
  return process.env.MARCSH_AGENTS_DIR?.trim() || join(homedir(), ".marcsh", "agents");
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
              ...(agent.unknownTools ? { unknownTools: agent.unknownTools.map(printable) } : {}),
              ...(agent.toolNotes ? { toolNotes: agent.toolNotes.map(printable) } : {}),
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

/** What the engine will not do with the hooks of the agent's pack : events it cannot run, or consent that no longer covers the files. */
async function hookWarnings(agent: Agent, engineId: string): Promise<string[]> {
  const location = agent.pack && agent.pluginDir ? packViewLocation(agent.pluginDir) : null;
  if (!location) return [];
  try {
    const info = await inspectPackHooks(location.id, { root: location.root });
    if (info.state === "off" && info.changed) {
      return [`${location.id}: hooks are off because their files changed since you approved them; review them with /agents hooks ${location.id}`];
    }
    if (info.state !== "on" || engineId !== "pi") return [];
    // pi runs the tool-call events itself; the rest are Claude's.
    const { claudeOnly } = hookEngines(hookEvents(info.config));
    return claudeOnly.length > 0 ? [`${location.id}: hooks for ${claudeOnly.join(", ")} run on Claude only`] : [];
  } catch {
    return [];
  }
}

/** One line per part of the agent that the engine will not apply; shown when the agent is selected. */
export async function agentWarnings(agent: Agent, engineId: string): Promise<string[]> {
  const warnings: string[] = [];
  if (agent.ignored.length > 0) warnings.push(`${agent.name}: ignored ${agent.ignored.join(", ")}`);
  if (agent.unknownTools && agent.unknownTools.length > 0) warnings.push(`${agent.name}: unknown tools ${agent.unknownTools.join(", ")}`);
  for (const note of agent.toolNotes ?? []) warnings.push(`${agent.name}: ${note}`);
  // pi has no web tools to take away: say so only when the agent asked for it by name (a list or `*` never does).
  for (const group of unsupportedGroups(agent.tools?.deny ?? [], engineId)) {
    if (agent.tools?.named?.includes(group)) warnings.push(`${agent.name}: ${group} tools are not available on ${engineId}, so \`${group}: false\` changes nothing`);
  }
  if (agent.model && !agentModelFits(agent.model, engineId)) {
    warnings.push(`${agent.name}: model "${agent.model}" is ignored on ${engineId}; the session model is used`);
  }
  warnings.push(...(await hookWarnings(agent, engineId)));
  return warnings;
}
