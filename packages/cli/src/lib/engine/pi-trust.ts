import { closeSync, constants, existsSync, fstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
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

/**
 * What a project holds that pi would load or run once the project is trusted. Both strings come from the project, so
 * `findProjectResources` returns them escaped (see `escapeProjectText`): each is one line of printable text.
 */
export type ProjectResource = {
  /** Relative to the project folder, e.g. `.pi/extensions/foo.ts`. */
  path: string;
  /** What it does when loaded, e.g. an MCP server's command. Whole, never shortened. */
  detail?: string;
  /**
   * Set when marcsh could not read the entry (over the size cap, not a regular file, not JSON, unreadable): `detail` says why.
   * pi would still load it once the project is trusted, so marcsh cannot show what trusting would run and never offers it.
   */
  unreadable?: true;
};

/** The entries marcsh could not read; while there is any, trust is not possible for the project. */
export const unreadableResources = (resources: ProjectResource[]) => resources.filter((resource) => resource.unreadable);

const unreadableEntry = (path: string, reason: string): ProjectResource => ({ path, detail: `could not be read: ${reason}`, unreadable: true });

/** Answer to the prompt: remember it either way, or leave this one turn untrusted without remembering. */
export type TrustAnswer = "trust" | "distrust" | "skip";

/** What the host shows when it asks. */
export type ProjectTrustAsk = {
  /** The project folder. */
  cwd: string;
  resources: ProjectResource[];
};

export type ProjectTrustRecords = Pick<Storage, "getProjectTrust" | "setProjectTrust">;

/** The project folder as decisions and prompts name it: symlinks resolved. */
export const canonical = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

// Control characters (C0, DEL, C1: ESC and the sequences it starts included), format characters (zero-width, bidi marks,
// embeddings, overrides and isolates, byte order mark, tags...), line and paragraph separators, lone surrogates
// and unassigned code points (U+2065 sits inside the invisible-operators block).
const UNSAFE_CHAR = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Cn}]/gu;
const NAMED_ESCAPES: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };

/**
 * Text from a project as the trust prompt may draw it: every character that could move the cursor, start a new row,
 * reorder or hide text is replaced by a visible escape (a newline becomes backslash and n, U+202E becomes backslash and u202e, a tag
 * character backslash and u{e0041}), nothing is dropped silently. Escaping twice changes nothing more, so a shown string is always one line.
 */
export function escapeProjectText(text: string): string {
  return text.replace(UNSAFE_CHAR, (char) => {
    const code = char.codePointAt(0)!;
    return NAMED_ESCAPES[char] ?? (code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A byte order mark, which pi's own readers strip.
const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

// The most a project's JSON file may hold to be listed; pi's own config files are far smaller.
const MAX_JSON_BYTES = 1024 * 1024;

type JsonRead = { value: unknown } | { unreadable: string };

/**
 * The parsed JSON file, or why it cannot be listed: not JSON, over the size cap, not a regular file, or unreadable.
 * (A missing file is the caller's check.)
 * The project controls the path, so a symlink is followed but the target must be a regular file: a FIFO would block the
 * read forever and a device like /dev/zero would never end. The check is on the opened file, not the path, so it cannot be swapped in between.
 */
function readJson(path: string): JsonRead {
  let fd: number | undefined;
  let text: string;
  try {
    // O_NONBLOCK: opening a FIFO must not wait for a writer.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    const size = info.size;
    if (!info.isFile()) return { unreadable: "not a regular file" };
    if (size > MAX_JSON_BYTES) return { unreadable: "larger than 1 MB" };
    // One byte more than the size: a file that grew since the check is refused too.
    const buffer = Buffer.alloc(size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > size) return { unreadable: "changed while being read" };
    text = buffer.toString("utf8", 0, length);
  } catch {
    return { unreadable: "cannot be opened or read" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  try {
    return { value: JSON.parse(stripBom(text)) };
  } catch {
    return { unreadable: "not valid JSON" };
  }
}

const show = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

/** `key=value` for each entry of a string map (an MCP server's `env`, its HTTP `headers`). */
const entries = (value: unknown, separator: string) =>
  isRecord(value) ? Object.entries(value).map(([key, entry]) => `${key}${separator}${show(entry)}`) : [];

/**
 * One row for what the server starts or connects to (`command arg arg`, or the URL), then one row per environment
 * entry, header and working folder: all of them change what runs or where it talks.
 */
function describeServer(name: string, config: unknown): string[] {
  if (!isRecord(config)) return [`server ${name}`];
  const rows: string[] = [];
  if (typeof config.command === "string") {
    const args = Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === "string") : [];
    rows.push(`server ${name}: ${[config.command, ...args].join(" ")}`);
  }
  if (typeof config.url === "string") rows.push(`server ${name}: ${config.url}`);
  if (rows.length === 0) rows.push(`server ${name}`);
  if (typeof config.cwd === "string") rows.push(`server ${name} runs in: ${config.cwd}`);
  for (const env of entries(config.env, "=")) rows.push(`server ${name} env: ${env}`);
  for (const header of entries(config.headers, ": ")) rows.push(`server ${name} header: ${header}`);
  return rows;
}

function mcpResources(file: string, path: string): ProjectResource[] {
  const read = readJson(file);
  if ("unreadable" in read) return [unreadableEntry(path, read.unreadable)];
  const parsed = read.value;
  const servers = isRecord(parsed) && isRecord(parsed.mcpServers) ? Object.entries(parsed.mcpServers) : [];
  if (servers.length === 0) return [{ path, detail: "no servers" }];
  return servers.flatMap(([name, config]) => describeServer(name, config).map((detail) => ({ path, detail })));
}

// Settings pi runs or installs from: a shell prefix and shell, the npm and self-update commands, the editor, proxy,
// packages (pi installs them on trust) and extension paths (pi loads them).
const EXECUTABLE_SETTINGS = ["shellCommandPrefix", "shellPath", "npmCommand", "selfUpdateCommand", "externalEditor", "httpProxy", "packages", "extensions"];
// Settings that point pi at more files to load.
const PATH_SETTINGS = ["skills", "prompts", "themes"];

/** A `packages` entry: `npm:x`, or an object with its source and the resources it narrows to. */
function describeSettingValue(key: string, value: unknown): string[] {
  if (Array.isArray(value) && key === "npmCommand" && value.every((part) => typeof part === "string")) return [value.join(" ")];
  if (Array.isArray(value)) return value.length === 0 ? ["(none)"] : value.map(describePackage);
  return [show(value)];
}

function describePackage(entry: unknown): string {
  if (!isRecord(entry) || typeof entry.source !== "string") return show(entry);
  const { source, ...rest } = entry;
  const options = Object.entries(rest).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.map(show).join(", ") : show(value)}`);
  return options.length > 0 ? `${source} (${options.join("; ")})` : source;
}

/** `.pi/settings.json`: executable settings go first (they run on trust), the rest after the extensions. */
function settingsResources(file: string, path: string): { runs: ProjectResource[]; others: ProjectResource[] } {
  const read = readJson(file);
  if ("unreadable" in read) return { runs: [], others: [unreadableEntry(path, read.unreadable)] };
  const parsed = read.value;
  if (!isRecord(parsed)) return { runs: [], others: [{ path }] };
  const rowsFor = (keys: string[]) =>
    keys.filter((key) => key in parsed).flatMap((key) => describeSettingValue(key, parsed[key]).map((value) => ({ path, detail: `${key}: ${value}` })));
  const listed = new Set([...EXECUTABLE_SETTINGS, ...PATH_SETTINGS]);
  const rest = Object.keys(parsed).filter((key) => !listed.has(key));
  const others = [...rowsFor(PATH_SETTINGS), ...(rest.length > 0 ? [{ path, detail: `sets ${rest.join(", ")}` }] : [])];
  const runs = rowsFor(EXECUTABLE_SETTINGS);
  return { runs, others: runs.length + others.length === 0 ? [{ path }] : others };
}

/** The entries of a resource folder, one per child; an empty folder is itself the resource. */
function folderResources(dir: string, path: string): ProjectResource[] {
  let children: string[];
  try {
    children = readdirSync(dir, { withFileTypes: true })
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort();
  } catch {
    return [unreadableEntry(`${path}/`, "cannot be listed")];
  }
  if (children.length === 0) return [{ path: `${path}/` }];
  return children.map((child) => ({ path: `${path}/${child}` }));
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
 *
 * Everything is listed, whole, most dangerous first: MCP servers (command, arguments, environment) and settings pi
 * executes or installs from, then extensions, then skills, prompt templates, themes and system prompt files.
 * Strings are escaped (`escapeProjectText`), so no entry can look like two rows or like the prompt itself.
 * An entry marcsh could not read is marked `unreadable` (see `ProjectResource`).
 */
export function findProjectResources(cwd: string): ProjectResource[] {
  const project = canonical(cwd);
  const config = join(project, CONFIG_DIR);
  const has = (entry: string) => existsSync(join(config, entry));
  const settings = has("settings.json") ? settingsResources(join(config, "settings.json"), `${CONFIG_DIR}/settings.json`) : { runs: [], others: [] };
  const resources: ProjectResource[] = [];

  if (has("mcp.json")) resources.push(...mcpResources(join(config, "mcp.json"), `${CONFIG_DIR}/mcp.json`));
  resources.push(...settings.runs);
  if (has("extensions")) resources.push(...folderResources(join(config, "extensions"), `${CONFIG_DIR}/extensions`));
  resources.push(...settings.others);
  for (const folder of ["skills", "prompts", "themes"]) {
    if (has(folder)) resources.push(...folderResources(join(config, folder), `${CONFIG_DIR}/${folder}`));
  }
  for (const file of ["SYSTEM.md", "APPEND_SYSTEM.md"]) {
    if (has(file)) resources.push({ path: `${CONFIG_DIR}/${file}`, detail: "changes the system prompt" });
  }
  for (const dir of agentsSkillDirs(project)) resources.push(...folderResources(dir, relative(project, dir)));
  return resources.map(({ path, detail, unreadable }) => ({
    path: escapeProjectText(path),
    ...(detail === undefined ? {} : { detail: escapeProjectText(detail) }),
    ...(unreadable ? { unreadable } : {}),
  }));
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
 * - An entry marcsh could not read (see `unreadableResources`): never true. Trusting would load what the user cannot be shown,
 *   and the file may have grown since an earlier "trusted", so that decision is not honored: the user is told again (the
 *   question offers only "distrust" and "skip"; a "trust" answer is ignored). A stored "untrusted" stays, without asking.
 * - A stored decision: that decision.
 * - Undecided: the user is asked once; "trust" and "distrust" are stored, "skip" (Esc, no host to ask, an aborted turn)
 *   is untrusted for this turn only and stores nothing.
 *
 * A store that cannot be read or written never trusts: reading fails closed, and a decision that cannot be saved still applies to this turn.
 */
export async function resolveProjectTrust({ cwd, records, ask, signal }: ResolveProjectTrustOptions): Promise<boolean> {
  const resources = findProjectResources(cwd);
  if (resources.length === 0) return false;
  const reviewable = unreadableResources(resources).length === 0;

  let store: ProjectTrustRecords;
  try {
    store = records();
    const stored = store.getProjectTrust(cwd);
    if (stored === "untrusted" || (stored && reviewable)) return stored === "trusted";
  } catch {
    return false;
  }

  if (!ask || signal.aborted) return false;
  const answer = await ask({ cwd: canonical(cwd), resources }, signal);
  if (signal.aborted || answer === "skip" || (answer === "trust" && !reviewable)) return false;
  try {
    store.setProjectTrust(cwd, answer === "trust" ? "trusted" : "untrusted");
  } catch {
    // The answer still holds for this turn; it will be asked again next time.
  }
  return answer === "trust";
}

/** Whether pi may load the project's own files without asking anyone (a stored "trusted" and nothing unreadable), as warm-up needs. */
export function isProjectTrusted(cwd: string, records: () => ProjectTrustRecords): boolean {
  const resources = findProjectResources(cwd);
  if (resources.length === 0 || unreadableResources(resources).length > 0) return false;
  try {
    return records().getProjectTrust(cwd) === "trusted";
  } catch {
    return false;
  }
}
