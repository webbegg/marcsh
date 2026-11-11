import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Storage, StoredReview } from "../storage";

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
 *
 * Trusting also lets `<project>/.pi/settings.json` send pi to files anywhere: `extensions`, `skills`, `prompts` and `themes`
 * paths, local `packages`, and the packages pi installs into the project (`.pi/npm`, `.pi/git`). Those are listed and
 * reviewed like the project's own files, resolved the way pi's package manager resolves them (see `settingsTargets`).
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

/** A resource as found on disk, before its strings are escaped: where its contents are (`source`), or their digest when the listing already read them. */
type RawResource = ProjectResource & { source?: string; digest?: string; skipGit?: true };

const unreadableEntry = (path: string, reason: string): RawResource => ({ path, detail: `could not be read: ${reason}`, unreadable: true });

/** Answer to the prompt: remember it either way, or leave this one turn untrusted without remembering. */
export type TrustAnswer = "trust" | "distrust" | "skip";

/** What the host shows when it asks. */
export type ProjectTrustAsk = {
  /** The project folder. */
  cwd: string;
  resources: ProjectResource[];
  /** Set when the project was trusted before: what differs from what the user reviewed then. */
  changes?: ProjectChanges;
};

/** Where decisions and the reviews they were made on are kept. A store without `getProjectReview` has no reviews, so it never counts a "trusted". */
export type ProjectTrustRecords = Pick<Storage, "getProjectTrust" | "setProjectTrust"> & Partial<Pick<Storage, "getProjectReview">>;

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

type BytesRead = { bytes: Buffer } | { unreadable: string };

/**
 * The file's bytes, or why it cannot be read: over the size cap, not a regular file, or unreadable.
 * The project controls the path, so a symlink is followed but the target must be a regular file: a FIFO would block the
 * read forever and a device like /dev/zero would never end. The check is on the opened file, not the path, so it cannot be swapped in between.
 */
function readBytes(path: string): BytesRead {
  let fd: number | undefined;
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
    return { bytes: buffer.subarray(0, length) };
  } catch {
    return { unreadable: "cannot be opened or read" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const sha256 = (...parts: (string | Uint8Array)[]) => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
};
const fileDigest = (bytes: Uint8Array) => sha256("file\0", bytes);

/** `digest` hashes the bytes the value was parsed from, so what is shown and what is hashed come from one read. */
type JsonRead = { value: unknown; digest: string } | { unreadable: string };

/** The parsed JSON file, or why it cannot be listed: not JSON, or any reason of `readBytes`. (A missing file is the caller's check.) */
function readJson(path: string): JsonRead {
  const read = readBytes(path);
  if ("unreadable" in read) return read;
  try {
    return { value: JSON.parse(stripBom(read.bytes.toString("utf8"))), digest: fileDigest(read.bytes) };
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

function mcpResources(file: string, path: string): RawResource[] {
  const read = readJson(file);
  if ("unreadable" in read) return [unreadableEntry(path, read.unreadable)];
  const { value: parsed, digest } = read;
  const servers = isRecord(parsed) && isRecord(parsed.mcpServers) ? Object.entries(parsed.mcpServers) : [];
  if (servers.length === 0) return [{ path, detail: "no servers", digest }];
  return servers.flatMap(([name, config]) => describeServer(name, config).map((detail) => ({ path, detail, digest })));
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

/** A file or folder a project's settings (or a package manifest) makes pi load: where it is, and why it is listed. */
type Target = {
  path: string;
  via: string;
  /** Look in it for a package.json that points pi further: as a package (all four kinds), or as an extension folder. */
  scan?: "package" | "extensions";
  /** A folder of git clones: their `.git` folders are not code pi loads and are left out of the review. */
  skipGit?: true;
};
type SettingsTargets = { code: Target[]; others: Target[] };

const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;
const SETTINGS_FILE = `${CONFIG_DIR}/settings.json`;

const isInside = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

const isFolder = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** A path as the listing names it: relative to the project folder, or the resolved path when it lies outside. */
const displayPath = (project: string, path: string) => (path === project ? "." : isInside(project, path) ? relative(project, path) : path);

/** pi's `resolvePath` (utils/paths.js): trimmed, `~` is the home folder (`$HOME` first), `file://` is a path, a relative path starts at `base`. */
function resolveFrom(input: string, base: string): string | undefined {
  let path = input.trim();
  const home = process.env.HOME || homedir();
  if (path === "~") path = home;
  else if (path.startsWith("~/")) path = join(home, path.slice(2));
  if (/^file:\/\//.test(path)) {
    try {
      path = fileURLToPath(path);
    } catch {
      return undefined;
    }
  }
  return isAbsolute(path) ? resolve(path) : resolve(base, path);
}

// pi's `isPattern`: these entries filter the files found, they do not name any.
const isPattern = (entry: string) => /^[!+-]/.test(entry) || /[*?]/.test(entry);

// pi's `isLocalPath`: a source that is not an `npm:`, git or URL source is a path.
const isLocalSource = (source: string) => !/^(npm|git|github|http|https|ssh|builtin):/.test(source.trim());

// pi's `parseNpmSpec`: the package name of `name`, `name@version`, `@scope/name@version`.
const npmName = (spec: string) => spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/)?.[1] ?? spec;

/**
 * What `<project>/.pi/settings.json` makes pi load, resolved as pi's package manager does (core/package-manager.js `resolve`):
 * - `extensions`, `skills`, `prompts`, `themes`: each plain entry (not a filter) is a path from the `.pi` folder.
 * - `packages`: an `npm:` source is installed at `.pi/npm/node_modules/<name>` (`getManagedNpmInstallPath`); any other source is
 *   a path from the `.pi` folder, and one that is not a path (a git or URL source) is cloned under `.pi/git` (`getGitInstallPath`).
 *   (pi reads a source it cannot parse as git as a path, so both are listed.)
 * Missing paths are skipped, as pi skips them: one created later is listed then, as added. A package that is not installed yet is
 * covered by its settings entry.
 */
function settingsTargets(settings: Record<string, unknown>, project: string): SettingsTargets {
  const base = join(project, CONFIG_DIR);
  const targets: SettingsTargets = { code: [], others: [] };
  for (const key of RESOURCE_FIELDS) {
    // The old `skills: { customDirectories }` format is read as the list (settings-manager.js `migrateSettings`).
    const value = key === "skills" && isRecord(settings.skills) ? settings.skills.customDirectories : settings[key];
    for (const entry of Array.isArray(value) ? value : []) {
      if (typeof entry !== "string" || isPattern(entry)) continue;
      const path = resolveFrom(entry, base);
      if (path) (key === "extensions" ? targets.code : targets.others).push({ path, via: `named by ${SETTINGS_FILE} (${key}: ${entry})`, ...(key === "extensions" ? { scan: "extensions" as const } : {}) });
    }
  }
  for (const entry of Array.isArray(settings.packages) ? settings.packages : []) {
    const source = typeof entry === "string" ? entry : isRecord(entry) && typeof entry.source === "string" ? entry.source : undefined;
    if (source === undefined) continue;
    const via = `named by ${SETTINGS_FILE} (packages: ${source})`;
    if (source.startsWith("npm:")) {
      targets.code.push({ path: join(base, "npm", "node_modules", npmName(source.slice("npm:".length).trim())), via, scan: "package" });
      continue;
    }
    const local = resolveFrom(source, base);
    if (local) targets.code.push({ path: local, via, scan: "package" });
    if (!isLocalSource(source)) targets.code.push({ path: join(base, "git"), via, skipGit: true });
  }
  return targets;
}

/** The folder part of a glob, which is where pi's `expandPackageGlob` looks. */
const globBase = (pattern: string) => {
  const segments = pattern.split("/");
  return segments.slice(0, segments.findIndex((segment) => /[*?]/.test(segment))).join("/") || ".";
};

/** Where the `pi` manifest of `<root>/package.json` points for these kinds of file (pi-manifest.js `readPiManifest`; filters excluded), from `root`. */
function manifestTargets(root: string, fields: readonly string[]): string[] {
  const file = join(root, "package.json");
  if (!existsSync(file)) return [];
  const read = readJson(file);
  if ("unreadable" in read || !isRecord(read.value) || !isRecord(read.value.pi)) return [];
  const found: string[] = [];
  for (const field of fields) {
    const entries = read.value.pi[field];
    if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === "string")) continue;
    for (const entry of entries as string[]) if (!/^[!+-]/.test(entry)) found.push(resolve(root, /[*?]/.test(entry) ? globBase(entry) : entry));
  }
  return found;
}

/** The folders directly inside `dir` that pi looks into (not hidden, not `node_modules`). */
function childFolders(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => !name.startsWith(".") && name !== "node_modules" && isFolder(join(dir, name)))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/**
 * What a package.json inside `dir` points pi at beyond `dir`, which hashing `dir` does not cover: for a package, the four kinds of
 * file its manifest lists (package-manager.js `collectPackageResources`) and those of its `extensions` folder; for an extension
 * folder, `dir` and the folders directly in it (`resolveExtensionEntries`).
 */
function manifestEscapes(project: string, dir: string, scan: "package" | "extensions"): Target[] {
  const found: Target[] = [];
  for (const root of scan === "package" ? [dir] : [dir, ...childFolders(dir)]) {
    const via = `named by ${displayPath(project, join(root, "package.json"))}`;
    for (const path of manifestTargets(root, scan === "package" ? RESOURCE_FIELDS : ["extensions"])) {
      if (!isInside(dir, path)) found.push({ path, via, scan: "extensions" });
    }
  }
  const extensions = join(dir, "extensions");
  if (scan === "package" && isFolder(extensions)) found.push(...manifestEscapes(project, extensions, "extensions"));
  return found;
}

// How far package.json files may point at one another.
const MAX_TARGET_DEPTH = 4;

/** The listing for targets: a file is one entry; a folder is listed like the project's own resource folders, an empty one by itself. */
function targetResources(project: string, targets: Target[]): RawResource[] {
  const resources: RawResource[] = [];
  const seen = new Set<string>();
  const queue = targets.map((target) => ({ target, depth: 0 }));
  for (let i = 0; i < queue.length; i++) {
    const { target, depth } = queue[i]!;
    if (seen.has(target.path) || !existsSync(target.path)) continue;
    seen.add(target.path);
    const path = displayPath(project, target.path);
    let folder: boolean;
    try {
      folder = statSync(target.path).isDirectory();
    } catch {
      resources.push(unreadableEntry(path, "cannot be opened or read"));
      continue;
    }
    if (!folder) {
      resources.push({ path, detail: target.via, source: target.path });
      continue;
    }
    resources.push(...folderResources(target.path, path, target.via, target.skipGit));
    if (target.scan && depth < MAX_TARGET_DEPTH) queue.push(...manifestEscapes(project, target.path, target.scan).map((next) => ({ target: next, depth: depth + 1 })));
  }
  return resources;
}

/** `.pi/settings.json`: executable settings go first (they run on trust), the rest after the extensions. */
function settingsResources(file: string, path: string, project: string): { runs: RawResource[]; others: RawResource[]; targets: SettingsTargets } {
  const none: SettingsTargets = { code: [], others: [] };
  const read = readJson(file);
  if ("unreadable" in read) return { runs: [], others: [unreadableEntry(path, read.unreadable)], targets: none };
  const { value: parsed, digest } = read;
  if (!isRecord(parsed)) return { runs: [], others: [{ path, digest }], targets: none };
  const rowsFor = (keys: string[]): RawResource[] =>
    keys.filter((key) => key in parsed).flatMap((key) => describeSettingValue(key, parsed[key]).map((value) => ({ path, detail: `${key}: ${value}`, digest })));
  const listed = new Set([...EXECUTABLE_SETTINGS, ...PATH_SETTINGS]);
  const rest = Object.keys(parsed).filter((key) => !listed.has(key));
  const others = [...rowsFor(PATH_SETTINGS), ...(rest.length > 0 ? [{ path, detail: `sets ${rest.join(", ")}`, digest }] : [])];
  const runs = rowsFor(EXECUTABLE_SETTINGS);
  return { runs, others: runs.length + others.length === 0 ? [{ path, digest }] : others, targets: settingsTargets(parsed, project) };
}

/** The entries of a resource folder, one per child; an empty folder is itself the resource. */
function folderResources(dir: string, path: string, detail?: string, skipGit?: true): RawResource[] {
  let children: string[];
  try {
    children = readdirSync(dir, { withFileTypes: true })
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort();
  } catch {
    return [unreadableEntry(`${path}/`, "cannot be listed")];
  }
  const extra = { ...(detail === undefined ? {} : { detail }), ...(skipGit ? { skipGit } : {}) };
  if (children.length === 0) return [{ path: `${path}/`, source: dir, ...extra }];
  return children.map((child) => ({ path: path === "." ? child : `${path}/${child}`, source: join(dir, child.replace(/\/$/, "")), ...extra }));
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

/** The listing as found, strings not yet escaped. */
function listResources(cwd: string): RawResource[] {
  const project = canonical(cwd);
  const config = join(project, CONFIG_DIR);
  const has = (entry: string) => existsSync(join(config, entry));
  const settings = has("settings.json")
    ? settingsResources(join(config, "settings.json"), SETTINGS_FILE, project)
    : { runs: [], others: [], targets: { code: [], others: [] } as SettingsTargets };
  const resources: RawResource[] = [];

  if (has("mcp.json")) resources.push(...mcpResources(join(config, "mcp.json"), `${CONFIG_DIR}/mcp.json`));
  resources.push(...settings.runs);
  if (has("extensions")) resources.push(...folderResources(join(config, "extensions"), `${CONFIG_DIR}/extensions`));
  const extensionEscapes = has("extensions") ? manifestEscapes(project, join(config, "extensions"), "extensions") : [];
  resources.push(...targetResources(project, [...extensionEscapes, ...settings.targets.code]));
  resources.push(...settings.others);
  for (const folder of ["skills", "prompts", "themes"]) {
    if (has(folder)) resources.push(...folderResources(join(config, folder), `${CONFIG_DIR}/${folder}`));
  }
  resources.push(...targetResources(project, settings.targets.others));
  for (const file of ["SYSTEM.md", "APPEND_SYSTEM.md"]) {
    if (has(file)) resources.push({ path: `${CONFIG_DIR}/${file}`, detail: "changes the system prompt", source: join(config, file) });
  }
  for (const dir of agentsSkillDirs(project)) resources.push(...folderResources(dir, relative(project, dir)));
  return resources;
}

const escapeResource = ({ path, detail, unreadable }: ProjectResource): ProjectResource => ({
  path: escapeProjectText(path),
  ...(detail === undefined ? {} : { detail: escapeProjectText(detail) }),
  ...(unreadable ? { unreadable } : {}),
});

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
  return listResources(cwd).map(escapeResource);
}

/**
 * What the user reviewed when trusting a project: one entry per listed path, sorted by path, with a hash of the details shown
 * for it and a hash of its contents (a folder: of every file in it). Only paths and hashes, so nothing the project holds is kept.
 */
export type ReviewRecord = StoredReview;

/** The listing together with the record of it, both from one pass over the project. */
export type ProjectReview = { resources: ProjectResource[]; record: ReviewRecord };

// The most one review reads across a project. An entry past these is unreadable (so never trusted), not hashed in part:
// a change in the part that was not read would go unseen. The entry count covers every listed entry and every file and folder
// inside them, however small, so the work and the stored record stay bounded.
const MAX_REVIEW_ENTRIES = 1000;
const MAX_REVIEW_BYTES = 16 * 1024 * 1024;
const MAX_REVIEW_DEPTH = 8;

type Budget = { entries: number; bytes: number };
type Digest = { digest: string } | { unreadable: string; at?: string };

/**
 * A hash of the file at `path`, or of the folder with everything in it; symlinks are followed (pi follows them). Reads regular files
 * only, within the caps. `skipGit` leaves out folders named `.git`.
 */
function digestPath(path: string, budget: Budget, skipGit: boolean, depth = 0): Digest {
  let isFolder: boolean;
  try {
    isFolder = statSync(path).isDirectory();
  } catch {
    return { unreadable: "cannot be opened or read" };
  }
  if (!isFolder) {
    const read = readBytes(path);
    if ("unreadable" in read) return read;
    budget.bytes += read.bytes.length;
    if (budget.bytes > MAX_REVIEW_BYTES) return { unreadable: "more than 16 MB to review in all" };
    return { digest: fileDigest(read.bytes) };
  }
  if (depth >= MAX_REVIEW_DEPTH) return { unreadable: "folders nested too deep to review" };
  let names: string[];
  try {
    names = readdirSync(path).sort().filter((name) => !(skipGit && name === ".git"));
  } catch {
    return { unreadable: "cannot be listed" };
  }
  budget.entries += names.length;
  if (budget.entries > MAX_REVIEW_ENTRIES) return { unreadable: `more than ${MAX_REVIEW_ENTRIES} files to review` };
  const children: [string, string][] = [];
  for (const name of names) {
    const child = digestPath(join(path, name), budget, skipGit, depth + 1);
    if ("unreadable" in child) return { unreadable: child.unreadable, at: child.at === undefined ? name : `${name}/${child.at}` };
    children.push([name, child.digest]);
  }
  return { digest: sha256("folder\0", JSON.stringify(children)) };
}

const byPath = <T extends { path: string }>(a: T, b: T) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * `findProjectResources` plus the record of what it lists. Contents are read with the same safe, size-capped reader the
 * listing uses (regular files only), so a file or folder entry marcsh cannot read in full is listed as unreadable too: trust
 * is never offered for what cannot be compared later.
 */
export function reviewProject(cwd: string): ProjectReview {
  const budget: Budget = { entries: 0, bytes: 0 };
  const digests = new Map<string, Digest>();
  const digestOf = (source: string, skipGit = false) => {
    const key = `${skipGit ? "skip-git" : "all"}\0${source}`;
    let digest = digests.get(key);
    if (!digest) digests.set(key, (digest = digestPath(source, budget, skipGit)));
    return digest;
  };
  const hashed = listResources(cwd).map((raw): { resource: ProjectResource; digest: string } => {
    // Each listed entry counts once here; what is inside a folder is counted as the folder is read.
    budget.entries += 1;
    if (raw.unreadable) return { resource: raw, digest: "unreadable" };
    // Past the cap nothing more is read: the entry is unreadable, as a folder past it is.
    const found: Digest =
      budget.entries > MAX_REVIEW_ENTRIES
        ? { unreadable: `more than ${MAX_REVIEW_ENTRIES} files to review` }
        : raw.digest !== undefined
          ? { digest: raw.digest }
          : raw.source !== undefined
            ? digestOf(raw.source, raw.skipGit)
            : { digest: "none" };
    if ("unreadable" in found) return { resource: unreadableEntry(raw.path, `${found.at === undefined ? "" : `${found.at}: `}${found.unreadable}`), digest: "unreadable" };
    return { resource: raw, digest: found.digest };
  });
  const resources = hashed.map(({ resource }) => escapeResource(resource));
  // A path listed on several rows (an MCP server's command and its env) is one entry.
  const groups = new Map<string, { details: (string | null)[]; digests: string[] }>();
  hashed.forEach(({ digest }, i) => {
    const { path, detail } = resources[i]!;
    const group = groups.get(path) ?? { details: [], digests: [] };
    group.details.push(detail ?? null);
    group.digests.push(digest);
    groups.set(path, group);
  });
  const record = [...groups]
    .map(([path, { details, digests }]) => ({ path, shown: sha256(JSON.stringify(details)), content: sha256(JSON.stringify(digests)) }))
    .sort(byPath);
  return { resources, record };
}

/** Whether two records are the same review. */
export const sameReview = (a: ReviewRecord, b: ReviewRecord) =>
  a.length === b.length && a.every((entry, i) => entry.path === b[i]!.path && entry.shown === b[i]!.shown && entry.content === b[i]!.content);

export type EntryChange = "added" | "changed" | "unchanged";

/** How the project differs from what the user reviewed when trusting it. */
export type ProjectChanges = {
  /** False when there is no earlier review to compare with (the trust was stored before reviews were kept): `status` and `removed` are then empty. */
  known: boolean;
  /** Per listed path (as `findProjectResources` names it). */
  status: Map<string, EntryChange>;
  /** Paths that were reviewed and are no longer there. */
  removed: string[];
};

export function diffReview(reviewed: ReviewRecord | null, current: ReviewRecord): ProjectChanges {
  if (!reviewed) return { known: false, status: new Map(), removed: [] };
  const before = new Map(reviewed.map((entry) => [entry.path, entry]));
  const status = new Map<string, EntryChange>();
  for (const entry of current) {
    const old = before.get(entry.path);
    status.set(entry.path, !old ? "added" : old.shown === entry.shown && old.content === entry.content ? "unchanged" : "changed");
  }
  return { known: true, status, removed: reviewed.filter((entry) => !status.has(entry.path)).map((entry) => entry.path) };
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
 * - A stored "untrusted": untrusted, without asking.
 * - A stored "trusted": trusted only while the project is as the user reviewed it (`reviewProject`'s record equals the stored
 *   one). If anything was added, removed or changed, or the row has no record (it predates reviews), the user is asked again,
 *   with `changes` saying what differs.
 * - Undecided (or a trusted that must be asked again): the user is asked; "trust" (with the record of what was shown) and
 *   "distrust" are stored, "skip" (Esc, no host to ask, an aborted turn) is untrusted for this turn only and stores nothing.
 *   A "trust" is also dropped when the project changed while the question was open: what was shown is not what would load.
 *
 * A store that cannot be read or written never trusts: reading fails closed, and a decision that cannot be saved still applies to this turn.
 */
export async function resolveProjectTrust({ cwd, records, ask, signal }: ResolveProjectTrustOptions): Promise<boolean> {
  const { resources, record } = reviewProject(cwd);
  if (resources.length === 0) return false;
  const reviewable = unreadableResources(resources).length === 0;

  let store: ProjectTrustRecords;
  let changes: ProjectChanges | undefined;
  try {
    store = records();
    const stored = store.getProjectTrust(cwd);
    if (stored === "untrusted") return false;
    if (stored === "trusted" && reviewable) {
      const reviewed = store.getProjectReview?.(cwd) ?? null;
      if (reviewed && sameReview(reviewed, record)) return true;
      changes = diffReview(reviewed, record);
    }
  } catch {
    return false;
  }

  if (!ask || signal.aborted) return false;
  const answer = await ask({ cwd: canonical(cwd), resources, ...(changes ? { changes } : {}) }, signal);
  if (signal.aborted || answer === "skip" || (answer === "trust" && !reviewable)) return false;
  if (answer === "trust" && !sameReview(reviewProject(cwd).record, record)) return false;
  try {
    if (answer === "trust") store.setProjectTrust(cwd, "trusted", record);
    else store.setProjectTrust(cwd, "untrusted");
  } catch {
    // The answer still holds for this turn; it will be asked again next time.
  }
  return answer === "trust";
}

/**
 * Whether pi may load the project's own files without asking anyone, as warm-up needs: a stored "trusted" whose review still
 * equals the project's files, and nothing unreadable.
 */
export function isProjectTrusted(cwd: string, records: () => ProjectTrustRecords): boolean {
  const { resources, record } = reviewProject(cwd);
  if (resources.length === 0 || unreadableResources(resources).length > 0) return false;
  try {
    const store = records();
    if (store.getProjectTrust(cwd) !== "trusted") return false;
    const reviewed = store.getProjectReview?.(cwd);
    return !!reviewed && sameReview(reviewed, record);
  } catch {
    return false;
  }
}
