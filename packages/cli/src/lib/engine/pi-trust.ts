import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { Storage } from "../storage";

/*
 * Project trust on pi (1.5.0). pi loads a project's own files only when its SettingsManager says the project is trusted
 * (`SettingsManager.create(cwd, agentDir, { projectTrusted })`, default true). Untrusted means: `<project>/.pi/settings.json`
 * is not read (so no project packages, `shellCommandPrefix` or `defaultTools`), and the project's extensions, skills, prompt
 * templates, themes, `SYSTEM.md` / `APPEND_SYSTEM.md`, `.agents/skills` (in the project or any parent folder) and
 * `.pi/mcp.json` are not loaded. `AGENTS.md` / `CLAUDE.md` context files are not gated by pi. The same flag reaches
 * extensions through `ctx.isProjectTrusted()`, which is how pi's MCP extension decides to read `.pi/mcp.json`.
 *
 * pi's own list of gated resources is `hasTrustRequiringProjectResources` (core/trust-manager.js); this module mirrors it
 * without importing pi, so the app can ask before pi is ever loaded (a test keeps the two in step).
 */

/** pi's project config folder (`piConfig.configDir` in its package.json). */
const CONFIG_DIR = ".pi";

/** What a project holds that pi would load or run once the project is trusted. */
export type ProjectResource = {
  /** Relative to the project folder, e.g. `.pi/extensions/foo.ts`. */
  path: string;
  /** What it does when loaded, e.g. an MCP server's command. */
  detail?: string;
};

/** Answer to the prompt: remember it either way, or leave this one turn untrusted without remembering. */
export type TrustAnswer = "trust" | "distrust" | "skip";

/** What the host shows when it asks. */
export type ProjectTrustAsk = {
  /** The project folder. */
  cwd: string;
  resources: ProjectResource[];
};

export type ProjectTrustRecords = Pick<Storage, "getProjectTrust" | "setProjectTrust">;

const MAX_CHILDREN = 20;
const MAX_DETAIL = 200;

const canonical = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

const clip = (text: string) => (text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A byte order mark, which pi's own readers strip.
const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

function readJson(path: string): unknown {
  try {
    return JSON.parse(stripBom(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

/** `command arg arg` or the URL of one `mcp.json` server. */
function describeServer(name: string, config: unknown): string {
  if (!isRecord(config)) return `server ${name}`;
  if (typeof config.command === "string") {
    const args = Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === "string") : [];
    return clip(`server ${name}: ${[config.command, ...args].join(" ")}`);
  }
  if (typeof config.url === "string") return clip(`server ${name}: ${config.url}`);
  return `server ${name}`;
}

function mcpResources(file: string, path: string): ProjectResource[] {
  const parsed = readJson(file);
  const servers = isRecord(parsed) && isRecord(parsed.mcpServers) ? Object.entries(parsed.mcpServers) : [];
  if (servers.length === 0) return [{ path, detail: parsed === undefined ? "could not be read" : "no servers" }];
  return servers.map(([name, config]) => ({ path, detail: describeServer(name, config) }));
}

function settingsResource(file: string, path: string): ProjectResource {
  const parsed = readJson(file);
  if (!isRecord(parsed)) return { path, detail: parsed === undefined ? "could not be read" : undefined };
  const keys = Object.keys(parsed);
  const prefix = typeof parsed.shellCommandPrefix === "string" ? `shellCommandPrefix: ${parsed.shellCommandPrefix}` : undefined;
  const others = keys.filter((key) => key !== "shellCommandPrefix").slice(0, 8);
  const detail = [prefix, others.length > 0 ? `sets ${others.join(", ")}` : undefined].filter(Boolean).join("; ");
  return { path, detail: detail ? clip(detail) : undefined };
}

/** The entries of a resource folder, one per child; an empty folder is itself the resource. */
function folderResources(dir: string, path: string): ProjectResource[] {
  let children: string[];
  try {
    children = readdirSync(dir, { withFileTypes: true })
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort();
  } catch {
    return [{ path: `${path}/` }];
  }
  if (children.length === 0) return [{ path: `${path}/` }];
  const shown = children.slice(0, MAX_CHILDREN).map((child) => ({ path: `${path}/${child}` }));
  return children.length > MAX_CHILDREN ? [...shown, { path: `${path}/`, detail: `and ${children.length - MAX_CHILDREN} more` }] : shown;
}

/** Folders named `.agents/skills` in the project and its parents, except the user's own (`~/.agents/skills`). */
function agentsSkillDirs(project: string): string[] {
  const userDir = join(canonical(process.env.HOME || homedir()), ".agents", "skills");
  const found: string[] = [];
  for (let dir = project; ; dir = dirname(dir)) {
    const skills = join(dir, ".agents", "skills");
    if (skills !== userDir && existsSync(skills)) found.push(skills);
    if (dirname(dir) === dir) return found;
  }
}

/**
 * What the project at `cwd` holds that pi gates behind project trust, as pi's `hasTrustRequiringProjectResources`
 * sees it: entries under `.pi`, and `.agents/skills` in the project or a parent folder. Empty when there is none.
 */
export function findProjectResources(cwd: string): ProjectResource[] {
  const project = canonical(cwd);
  const config = join(project, CONFIG_DIR);
  const has = (entry: string) => existsSync(join(config, entry));
  const resources: ProjectResource[] = [];

  if (has("extensions")) resources.push(...folderResources(join(config, "extensions"), `${CONFIG_DIR}/extensions`));
  if (has("mcp.json")) resources.push(...mcpResources(join(config, "mcp.json"), `${CONFIG_DIR}/mcp.json`));
  if (has("settings.json")) resources.push(settingsResource(join(config, "settings.json"), `${CONFIG_DIR}/settings.json`));
  for (const folder of ["skills", "prompts", "themes"]) {
    if (has(folder)) resources.push(...folderResources(join(config, folder), `${CONFIG_DIR}/${folder}`));
  }
  for (const file of ["SYSTEM.md", "APPEND_SYSTEM.md"]) {
    if (has(file)) resources.push({ path: `${CONFIG_DIR}/${file}`, detail: "changes the system prompt" });
  }
  for (const dir of agentsSkillDirs(project)) resources.push(...folderResources(dir, relative(project, dir)));
  return resources;
}

export type ResolveProjectTrustOptions = {
  cwd: string;
  /** Where decisions are kept; only opened when the project has files to decide about. */
  records: () => ProjectTrustRecords;
  /** Asks the user; absent means nobody can be asked. */
  ask?: (ask: ProjectTrustAsk, signal: AbortSignal) => Promise<TrustAnswer>;
  signal: AbortSignal;
};

/**
 * Whether pi may load the project's own files for this turn.
 *
 * - No project files: false, nothing is asked or stored (there is nothing to load).
 * - A stored decision: that decision.
 * - Undecided: the user is asked once; "trust" and "distrust" are stored, "skip" (Esc, no host to ask, an aborted turn)
 *   is untrusted for this turn only and stores nothing.
 *
 * A store that cannot be read or written never trusts: reading fails closed, and a decision that cannot be saved still applies to this turn.
 */
export async function resolveProjectTrust({ cwd, records, ask, signal }: ResolveProjectTrustOptions): Promise<boolean> {
  const resources = findProjectResources(cwd);
  if (resources.length === 0) return false;

  let store: ProjectTrustRecords;
  try {
    store = records();
    const stored = store.getProjectTrust(cwd);
    if (stored) return stored === "trusted";
  } catch {
    return false;
  }

  if (!ask || signal.aborted) return false;
  const answer = await ask({ cwd: canonical(cwd), resources }, signal);
  if (signal.aborted || answer === "skip") return false;
  try {
    store.setProjectTrust(cwd, answer === "trust" ? "trusted" : "untrusted");
  } catch {
    // The answer still holds for this turn; it will be asked again next time.
  }
  return answer === "trust";
}

/** Whether pi may load the project's own files without asking anyone (a stored "trusted"), as warm-up needs. */
export function isProjectTrusted(cwd: string, records: () => ProjectTrustRecords): boolean {
  if (findProjectResources(cwd).length === 0) return false;
  try {
    return records().getProjectTrust(cwd) === "trusted";
  } catch {
    return false;
  }
}
