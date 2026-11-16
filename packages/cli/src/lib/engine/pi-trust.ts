import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_AGENT_BYTES, readFrontmatter } from "../agent-file";
import { PROJECT_COMMANDS_DIR, PROJECT_COMMANDS_PATH, commandFiles } from "../command-files";
import { readOnlyGitArgs, readOnlyGitEnv } from "../git-safe";
import type { ProjectTrust, ReviewKind, Storage, StoredReview } from "../storage";

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
 *
 * The review a trust is stored with (`reviewProject`) has three parts, each entry tagged with its `kind`: the pi files ("pi", the
 * above), the project's own marcsh commands ("command", `.marcsh/commands`) and the repo's git settings ("git": the filter drivers its
 * own config names, which `git status` may run, and the attribute files that pick the files they run on). There is one decision, but each consumer checks only its own
 * part (`partTrust`): pi's trust (the turn, warm-up, `marcsh mcp`) the pi part, the command loader the command part
 * (`trustedProjectCommands`), the status line's changed-file count the git part.
 */

/** A part of the review (see above). */
export type TrustPart = ReviewKind;

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
   * pi would still load a pi file once the project is trusted, so marcsh cannot show what trusting would run and never offers it.
   * An unreadable command or git settings file only keeps its own part off (see `partTrust`).
   */
  unreadable?: true;
  /** The part of the review the entry belongs to; absent for a pi file (see `kindOf`). */
  kind?: Exclude<TrustPart, "pi">;
};

/** The part an entry belongs to. */
export const kindOf = (entry: { kind?: TrustPart }): TrustPart => entry.kind ?? "pi";

/** The entries marcsh could not read. While a pi file is among them, trusting is not offered (see `unreadablePiFiles`). */
export const unreadableResources = (resources: ProjectResource[]) => resources.filter((resource) => resource.unreadable);

/** The pi files marcsh could not read: while there is any, pi's trust is not possible for the project, and trusting is not offered. */
export const unreadablePiFiles = (resources: ProjectResource[]) => resources.filter((resource) => resource.unreadable && kindOf(resource) === "pi");

/** A resource as found on disk, before its strings are escaped: where its contents are (`source`), or their digest when the listing already read them. */
type RawResource = ProjectResource & { source?: string; digest?: string; skipGit?: true };

const unreadableEntry = (path: string, reason: string, kind?: ProjectResource["kind"]): RawResource => ({
  path,
  detail: `could not be read: ${reason}`,
  unreadable: true,
  ...(kind ? { kind } : {}),
});

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

/** What `stat` says of a path, enough to tell it changed: missing, or its identity, size and times (and its target's for a link). */
function statSignature(path: string): { sign: string; mtimeMs: number } {
  const sign = (info: Stats) => `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  let link: Stats;
  try {
    link = lstatSync(path);
  } catch {
    return { sign: "missing", mtimeMs: 0 };
  }
  if (!link.isSymbolicLink()) return { sign: sign(link), mtimeMs: link.mtimeMs };
  try {
    const target = statSync(path);
    return { sign: `${sign(link)}>${sign(target)}`, mtimeMs: Math.max(link.mtimeMs, target.mtimeMs) };
  } catch {
    return { sign: `${sign(link)}>missing`, mtimeMs: link.mtimeMs };
  }
}

/** What kind of entry is at `path`, following a link. */
function entryKind(path: string): "dir" | "file" | "other" | "missing" {
  try {
    const info = statSync(path);
    return info.isDirectory() ? "dir" : info.isFile() ? "file" : "other";
  } catch {
    return "missing";
  }
}

/** What a review read at a path: a file's digest (or why it could not be read), or the names of a folder. */
type Probe = { type: "file" | "list"; value: string } | { type: "conflict" };

/**
 * A path a review looked at: its signature from before (`how`: its stat signature, or only what kind of entry it is), and what the
 * review read there (`probe`), which tells a change the signature cannot (see `remember`).
 */
type Seen = { sign: string; mtimeMs: number; how: "stat" | "kind"; probe?: Probe };

/**
 * While a review runs: every path it looks at (read, listed, or only checked for), with its stat signature from before it was
 * looked at. A later change to any of them (a file written, an entry added to or removed from a folder, a missing path created)
 * changes its signature, which is how a cached review is known to be out of date (see `currentProjectReview`).
 */
let touched: Map<string, Seen> | null = null;
const note = (path: string) => {
  if (touched && !touched.has(path)) touched.set(path, { ...statSignature(path), how: "stat" });
};
/** Notes only what kind of entry `path` is: for a folder whose times change all the time (`.git`) while what is reviewed in it does not. */
const noteKind = (path: string) => {
  const kind = entryKind(path);
  if (touched && !touched.has(path)) touched.set(path, { sign: `kind:${kind}`, mtimeMs: 0, how: "kind" });
  return kind;
};
const signatureOf = (path: string, how: Seen["how"]) => (how === "kind" ? `kind:${entryKind(path)}` : statSignature(path).sign);
/** What the review read at a noted path. Two different reads of one path leave no probe that can be trusted. */
const probe = (path: string, type: "file" | "list", value: string) => {
  const seen = touched?.get(path);
  if (!seen || seen.how !== "stat") return;
  const earlier = seen.probe;
  if (!earlier) seen.probe = { type, value };
  else if (earlier.type === "conflict" || earlier.type !== type || earlier.value !== value) seen.probe = { type: "conflict" };
};
const listDigest = (names: string[]) => sha256("list\0", JSON.stringify([...names].sort()));

/** The names in a folder, noted as what the review read there. */
function listNames(dir: string): string[] {
  try {
    const names = readdirSync(dir);
    probe(dir, "list", listDigest(names));
    return names;
  } catch (error) {
    probe(dir, "list", "unlistable");
    throw error;
  }
}

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

const sizeText = (bytes: number) => (bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MB` : `${bytes / 1024} KB`);

/**
 * The file's bytes, or why it cannot be read: over the size cap (`max`, 1 MB by default), not a regular file, or unreadable.
 * The project controls the path, so a symlink is followed (unless `noFollow`) but the target must be a regular file: a FIFO would block the
 * read forever and a device like /dev/zero would never end. The check is on the opened file, not the path, so it cannot be swapped in between.
 */
function readBytes(path: string, { max = MAX_JSON_BYTES, noFollow = false }: { max?: number; noFollow?: boolean } = {}): BytesRead {
  note(path);
  const read = readOnce(path, max, noFollow);
  probe(path, "file", "unreadable" in read ? `unreadable\0${read.unreadable}` : fileDigest(read.bytes));
  return read;
}

function readOnce(path: string, max: number, noFollow: boolean): BytesRead {
  let fd: number | undefined;
  try {
    // O_NONBLOCK: opening a FIFO must not wait for a writer. O_NOFOLLOW: a link swapped in is not opened.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (noFollow ? (constants.O_NOFOLLOW ?? 0) : 0));
    const info = fstatSync(fd);
    const size = info.size;
    if (!info.isFile()) return { unreadable: "not a regular file" };
    if (size > max) return { unreadable: `larger than ${sizeText(max)}` };
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
  note(path);
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
  note(file);
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
  note(dir);
  try {
    return listNames(dir)
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
    note(target.path);
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
  note(dir);
  let children: string[];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    probe(dir, "list", listDigest(entries.map((entry) => entry.name)));
    children = entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)).sort();
  } catch {
    probe(dir, "list", "unlistable");
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
    if (skills !== userDir) note(skills);
    if (skills !== userDir && existsSync(skills)) found.push(skills);
    if (dirname(dir) === dir) return found;
  }
}

/** The listing as found, strings not yet escaped. */
function listResources(cwd: string): RawResource[] {
  const project = canonical(cwd);
  const config = join(project, CONFIG_DIR);
  const has = (entry: string) => {
    note(join(config, entry));
    return existsSync(join(config, entry));
  };
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

const escapeResource = ({ path, detail, unreadable, kind }: ProjectResource): ProjectResource => ({
  path: escapeProjectText(path),
  ...(detail === undefined ? {} : { detail: escapeProjectText(detail) }),
  ...(unreadable ? { unreadable } : {}),
  ...(kind ? { kind } : {}),
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
  note(path);
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
    names = listNames(path).sort().filter((name) => !(skipGit && name === ".git"));
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

/** An entry with the digest of its contents ("unreadable" when they could not be read). */
type Hashed = { resource: RawResource; digest: string };

/** A project command as the review read it: the text the loader may use once its hash matches the review. */
export type ProjectCommandFile = { name: string; file: string; path: string; text: string };

/** `project command /name`, and the agent and model it sets: a trusted command can switch both for its turn. */
function commandDetail(name: string, text: string): string {
  let fields: Map<string, string | null>;
  try {
    fields = readFrontmatter(text).fields;
  } catch {
    return `project command /${name}`;
  }
  const set = ["agent", "model"].flatMap((key) => {
    const value = fields.get(key)?.trim();
    return value ? [`${key}: ${value}`] : [];
  });
  return set.length > 0 ? `project command /${name} (${set.join(", ")})` : `project command /${name}`;
}

/**
 * A project's own marcsh commands, exactly the files the command loader reads (`commandFiles`), one entry each after what pi
 * loads, each read once (regular files only, links not followed, at most `MAX_AGENT_BYTES`). They are prompt templates a turn
 * sends as your message, so they are reviewed like the rest. Their own caps: what they hold never makes a pi file unreadable.
 */
function hashCommands(project: string): (Hashed & { command?: ProjectCommandFile })[] {
  const dir = join(project, PROJECT_COMMANDS_DIR);
  note(dir);
  const budget: Budget = { entries: 0, bytes: 0 };
  const files = commandFiles(dir, false, { onEntry: note, onList: (names) => probe(dir, "list", listDigest(names)) });
  return files.map(({ name, file, path }) => {
    const shown = `${PROJECT_COMMANDS_PATH}/${file}`;
    const unreadable = (reason: string) => ({ resource: unreadableEntry(shown, reason, "command"), digest: "unreadable" });
    budget.entries += 1;
    if (budget.entries > MAX_REVIEW_ENTRIES) return unreadable(`more than ${MAX_REVIEW_ENTRIES} files to review`);
    const read = readBytes(path, { max: MAX_AGENT_BYTES, noFollow: true });
    if ("unreadable" in read) return unreadable(read.unreadable);
    budget.bytes += read.bytes.length;
    if (budget.bytes > MAX_REVIEW_BYTES) return unreadable("more than 16 MB to review in all");
    const text = read.bytes.toString("utf8");
    return { resource: { path: shown, detail: commandDetail(name, text), kind: "command" as const }, digest: fileDigest(read.bytes), command: { name, file, path, text } };
  });
}

const NO_FILTER_DRIVERS = "no filter drivers";
const FILTER_DRIVERS = "git filter drivers";
const GIT_ATTRIBUTES_DETAIL = "git attributes: which files go through the filter drivers";
// The most `git config` may print for one review, and how long it may take (an include can name a FIFO git would wait on).
const MAX_GIT_CONFIG_BYTES = MAX_JSON_BYTES;
const GIT_CONFIG_TIMEOUT_MS = 5000;

type GitConfigEntry = { scope: string; origin: string; key: string; value: string | null };

/**
 * The `filter.*` and `include*.path` settings git resolves for the repo at `root`, includes and includeIf followed, from the repo's
 * own config only (its config and a worktree's `config.worktree`, and what they include): not the user's global or the system
 * config, which are not the project's. Run hardened (`readOnlyGitArgs`, `readOnlyGitEnv`): reading config runs nothing.
 * `safe.directory=*` lets git read a repo it would refuse, so a repo the user's own config allows is never read as empty.
 */
function readGitConfig(root: string): { entries: GitConfigEntry[]; raw: string } | { unreadable: string } {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(
      ["git", ...readOnlyGitArgs(), "-c", "safe.directory=*", "config", "--includes", "--show-scope", "--show-origin", "--null", "--get-regexp", "^(filter|include|includeif)\\."],
      { cwd: root, env: { ...readOnlyGitEnv(), GIT_CONFIG_GLOBAL: "/dev/null" }, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: GIT_CONFIG_TIMEOUT_MS },
    );
  } catch {
    return { unreadable: "git could not be run" };
  }
  const out = result.stdout ?? Buffer.alloc(0);
  // 1 with nothing printed: no such setting.
  if (result.exitCode === 1 && out.length === 0) return { entries: [], raw: "" };
  if (result.exitCode !== 0) return { unreadable: result.exitCode === null ? "git config did not finish" : "git could not read the repo's config" };
  if (out.length > MAX_GIT_CONFIG_BYTES) return { unreadable: `more than ${sizeText(MAX_GIT_CONFIG_BYTES)} of git settings` };
  const raw = out.toString("utf8");
  // scope NUL origin NUL key LF value NUL, per setting (a setting without a value has no LF).
  const fields = raw.split("\0");
  if (fields.pop() !== "" || fields.length % 3 !== 0) return { unreadable: "git printed settings marcsh cannot read" };
  const entries: GitConfigEntry[] = [];
  for (let i = 0; i < fields.length; i += 3) {
    const pair = fields[i + 2]!;
    const lf = pair.indexOf("\n");
    entries.push({ scope: fields[i]!, origin: fields[i + 1]!, key: lf < 0 ? pair : pair.slice(0, lf), value: lf < 0 ? null : pair.slice(lf + 1) });
  }
  return { entries: entries.filter(({ scope }) => scope === "local" || scope === "worktree"), raw };
}

/** The files the repo's config includes (whether their condition holds now or not), as git resolves an include's path. */
function includedFiles(root: string, entries: GitConfigEntry[]): string[] {
  const home = process.env.HOME || homedir();
  return entries.flatMap(({ origin, key, value }) => {
    if (!value || !origin.startsWith("file:") || !/^include(if\..*)?\.path$/.test(key)) return [];
    if (value.startsWith("~/")) return [join(home, value.slice(2))];
    if (isAbsolute(value)) return [value];
    // Relative to the file the include is in.
    return [resolve(dirname(resolve(root, origin.slice("file:".length))), value)];
  });
}

/**
 * The filter drivers the repo's own config names (`readGitConfig`): what could make the status line's `git status` run a program,
 * since it is run with everything else that could off (see `git-safe.ts`). One entry, `git filter drivers: <names>` with one row
 * per setting (`filter <name> clean: <command>`), or `no filter drivers`, so a driver added later is a change. Settings git writes
 * itself (upstreams, remotes, `core.*`) are not part of it. The files git reads for it are noted (the config, a worktree's own,
 * `HEAD` for an include on a branch, every included file), so the review is read again when one of them changes.
 */
function hashFilterDrivers({ root, gitDir, commonDir }: { root: string; gitDir: string; commonDir: string }): Hashed[] {
  const unreadable = (reason: string): Hashed[] => [{ resource: unreadableEntry(FILTER_DRIVERS, reason, "git"), digest: "unreadable" }];
  // Noted before git reads them: a change while it reads shows on the next look.
  for (const file of new Set([join(commonDir, "config"), join(gitDir, "config.worktree"), join(gitDir, "HEAD")])) readBytes(file);
  const read = readGitConfig(root);
  if ("unreadable" in read) return unreadable(read.unreadable);
  const included = includedFiles(root, read.entries);
  if (included.length > 0) {
    // Only known once git has read the config: noted now, then read again, so what is kept is what was noted.
    for (const file of included) readBytes(file);
    const again = readGitConfig(root);
    if ("unreadable" in again) return unreadable(again.unreadable);
    if (again.raw !== read.raw) return unreadable("changed while being read");
  }
  const settings = read.entries.flatMap(({ key, value }) => {
    if (!key.startsWith("filter.")) return [];
    const rest = key.slice("filter.".length);
    const dot = rest.lastIndexOf(".");
    return [{ name: dot < 0 ? "" : rest.slice(0, dot), setting: rest.slice(dot + 1), value }];
  });
  const digest = sha256("filters\0", JSON.stringify(settings.map(({ name, setting, value }) => [name, setting, value])));
  if (settings.length === 0) return [{ resource: { path: NO_FILTER_DRIVERS, kind: "git" }, digest }];
  const path = `${FILTER_DRIVERS}: ${[...new Set(settings.map(({ name }) => name))].join(", ")}`;
  return settings.map(({ name, setting, value }) => ({
    resource: { path, detail: `filter ${name} ${setting}${value === null ? "" : `: ${value}`}`, kind: "git" as const },
    digest,
  }));
}

/** Where git keeps the repo the project is in, as git finds it: the first `.git` folder, or `.git` file (a worktree, a submodule), upward. */
function findGitDir(project: string): { root: string; gitDir: string; commonDir: string } | { unreadable: string; at: string } | null {
  for (let dir = project; ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    const kind = noteKind(dotGit);
    if (kind === "dir") return { root: dir, gitDir: dotGit, commonDir: dotGit };
    if (kind === "file") {
      const read = readBytes(dotGit);
      if ("unreadable" in read) return { unreadable: read.unreadable, at: dotGit };
      const link = /^gitdir:\s*(.+?)\s*$/m.exec(read.bytes.toString("utf8"))?.[1];
      if (!link) return { unreadable: "not a git link (gitdir: ...)", at: dotGit };
      const gitDir = resolve(dir, link);
      const commondir = join(gitDir, "commondir");
      note(commondir);
      if (!existsSync(commondir)) return { root: dir, gitDir, commonDir: gitDir };
      const common = readBytes(commondir);
      if ("unreadable" in common) return { unreadable: common.unreadable, at: commondir };
      return { root: dir, gitDir, commonDir: resolve(gitDir, common.bytes.toString("utf8").trim()) };
    }
    if (dirname(dir) === dir) return null;
  }
}

/**
 * The repo's git settings: what could make the status line's `git status` run programs. Its filter drivers (`hashFilterDrivers`),
 * then the attribute files that say which files go through them: the work tree's `.gitattributes` and `info/attributes`, when
 * they exist. A `.gitattributes` in a subfolder is not reviewed: finding a new one would mean listing the whole work tree on every
 * look, and it can only send files through a driver that is reviewed here (or the user's own). None outside a repo. Their own
 * caps, like the commands'.
 */
function hashGit(project: string): Hashed[] {
  const found = findGitDir(project);
  if (!found) return [];
  if ("unreadable" in found) return [{ resource: unreadableEntry(displayPath(project, found.at), found.unreadable, "git"), digest: "unreadable" }];
  const files: [string, string][] = [
    [join(found.root, ".gitattributes"), GIT_ATTRIBUTES_DETAIL],
    [join(found.commonDir, "info", "attributes"), GIT_ATTRIBUTES_DETAIL],
  ];
  const budget: Budget = { entries: 0, bytes: 0 };
  return [...hashFilterDrivers(found), ...files.flatMap(([file, detail]) => {
    note(file);
    if (!existsSync(file)) return [];
    const path = displayPath(project, file);
    budget.entries += 1;
    const read = digestPath(file, budget, false);
    if ("unreadable" in read) return [{ resource: unreadableEntry(path, `${read.at === undefined ? "" : `${read.at}: `}${read.unreadable}`, "git"), digest: "unreadable" }];
    return [{ resource: { path, detail, kind: "git" as const }, digest: read.digest }];
  })];
}

/**
 * Everything a trust covers, in its three parts: `findProjectResources` (the pi files), the project's commands (`.marcsh/commands`)
 * and the repo's git settings, plus the record of what they list. Contents are read with the same safe, size-capped reader the listing
 * uses (regular files only), so a file or folder entry marcsh cannot read in full is listed as unreadable too: its part is never
 * trusted, since it could not be compared later. Each part has its own caps.
 * Always reads the project afresh; the result is kept for `currentProjectReview`.
 */
export function reviewProject(cwd: string): ProjectReview {
  const started = Date.now();
  const seen: NonNullable<typeof touched> = new Map();
  const outer = touched;
  touched = seen;
  try {
    const review = reviewNow(cwd);
    remember(canonical(cwd), review, seen, started);
    return review;
  } finally {
    touched = outer;
  }
}

// A path changed this recently before a review is racy: on a file system with coarse times, a change made within the same tick
// right after the review would leave its signature as it was (git treats racily clean index entries the same way). The review is
// still kept, but what it read at each racy path is read again before it is reused, until that path is no longer racy.
const RACY_MS = 2000;
// Folders whose review is kept at once (the status line polls one; a few more are open in other sessions or tabs).
const MAX_KEPT_REVIEWS = 32;

type Racy = { path: string; mtimeMs: number; probe: Extract<Probe, { value: string }> };
type KeptReview = { home: string; touched: [path: string, sign: string, how: Seen["how"]][]; racy: Racy[]; review: ProjectReview };
const keptReviews = new Map<string, KeptReview>();

function remember(project: string, review: ProjectReview, seen: NonNullable<typeof touched>, started: number) {
  keptReviews.delete(project);
  const racy: Racy[] = [];
  for (const [path, { sign, mtimeMs, how, probe: read }] of seen) {
    if (how !== "stat" || sign === "missing" || mtimeMs < started - RACY_MS) continue;
    // A racy path whose contents the review did not read (only checked for), or read twice differently, cannot be re-checked.
    if (!read || read.type === "conflict") return;
    racy.push({ path, mtimeMs, probe: read });
  }
  keptReviews.set(project, { home: process.env.HOME ?? "", touched: [...seen].map(([path, { sign, how }]) => [path, sign, how]), racy, review });
  if (keptReviews.size > MAX_KEPT_REVIEWS) keptReviews.delete(keptReviews.keys().next().value!);
}

/** Whether a racy path still holds what the review read there. */
function readsTheSame({ path, probe: read }: Racy): boolean {
  if (read.type === "list") {
    try {
      return listDigest(readdirSync(path)) === read.value;
    } catch {
      return read.value === "unlistable";
    }
  }
  const now = readOnce(path, MAX_JSON_BYTES, false);
  return ("unreadable" in now ? `unreadable\0${now.unreadable}` : fileDigest(now.bytes)) === read.value;
}

/**
 * `reviewProject`, without reading the project again while nothing it looked at changed: the last review is reused while every
 * path it read, listed or checked for has the stat signature it had before it was looked at (identity, size, modified and
 * changed times; still missing for a path that was missing). A file edited in place, an entry added or removed anywhere in a
 * reviewed folder, or a missing file or folder created reads the project again. A path that was racy when it was reviewed (see
 * `RACY_MS`) is read again too, until a read finds it unchanged once it is no longer racy. Cheap enough for the status line's poll.
 */
export function currentProjectReview(cwd: string): ProjectReview {
  const kept = keptReviews.get(canonical(cwd));
  if (kept && kept.home === (process.env.HOME ?? "") && kept.touched.every(([path, sign, how]) => signatureOf(path, how) === sign)) {
    const checked = Date.now();
    if (kept.racy.every(readsTheSame)) {
      kept.racy = kept.racy.filter(({ mtimeMs }) => mtimeMs >= checked - RACY_MS);
      return kept.review;
    }
  }
  return reviewProject(cwd);
}

function reviewNow(cwd: string): ProjectReview {
  const budget: Budget = { entries: 0, bytes: 0 };
  const digests = new Map<string, Digest>();
  const digestOf = (source: string, skipGit = false) => {
    const key = `${skipGit ? "skip-git" : "all"}\0${source}`;
    let digest = digests.get(key);
    if (!digest) digests.set(key, (digest = digestPath(source, budget, skipGit)));
    return digest;
  };
  const pi = listResources(cwd).map((raw): Hashed => {
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
  const project = canonical(cwd);
  return finishReview([...pi, ...hashCommands(project), ...hashGit(project)]);
}

const byEntry = (a: ReviewRecord[number], b: ReviewRecord[number]) => byPath(a, b) || (kindOf(a) < kindOf(b) ? -1 : kindOf(a) > kindOf(b) ? 1 : 0);

/** The listing, escaped, and the record of it: one entry per part and path, sorted. */
function finishReview(hashed: Hashed[]): ProjectReview {
  const resources = hashed.map(({ resource }) => escapeResource(resource));
  // A path listed on several rows (an MCP server's command and its env) is one entry.
  const groups = new Map<string, { path: string; kind: TrustPart; details: (string | null)[]; digests: string[] }>();
  hashed.forEach(({ digest }, i) => {
    const resource = resources[i]!;
    const key = `${kindOf(resource)}\0${resource.path}`;
    const group = groups.get(key) ?? { path: resource.path, kind: kindOf(resource), details: [], digests: [] };
    group.details.push(resource.detail ?? null);
    group.digests.push(digest);
    groups.set(key, group);
  });
  const record = [...groups.values()]
    .map(({ path, kind, details, digests }) => ({ path, kind, shown: sha256(JSON.stringify(details)), content: sha256(JSON.stringify(digests)) }))
    .sort(byEntry);
  return { resources, record };
}

/** Whether two records are the same review. */
export const sameReview = (a: ReviewRecord, b: ReviewRecord) =>
  a.length === b.length &&
  a.every((entry, i) => entry.path === b[i]!.path && kindOf(entry) === kindOf(b[i]!) && entry.shown === b[i]!.shown && entry.content === b[i]!.content);

/** The entries of one part. */
export const partOf = (record: ReviewRecord, part: TrustPart) => record.filter((entry) => kindOf(entry) === part);

/**
 * The parts a stored review covers: none without one; only the pi files for one stored before marcsh reviewed commands and git
 * settings (no entry has a `kind`); all three otherwise.
 */
export function reviewedParts(reviewed: ReviewRecord | null): Set<TrustPart> {
  if (!reviewed) return new Set();
  if (reviewed.length > 0 && reviewed.every((entry) => entry.kind === undefined)) return new Set(["pi"]);
  return new Set(["pi", "command", "git"]);
}

/**
 * Where one part of a project's trust stands:
 * - "holds": the decision is "trusted" and the part is as the user reviewed it, with nothing unreadable in it;
 * - "undecided" / "untrusted": the decision (an untrusted project is never asked about or told again);
 * - "unreviewed": "trusted", but the stored review does not cover the part (stored before marcsh kept reviews, or before it
 *   reviewed commands and git settings);
 * - "stale": "trusted", but something in the part was added, changed or removed since, or cannot be read.
 */
export type PartTrust = "holds" | "undecided" | "untrusted" | "unreviewed" | "stale";

/** `PartTrust` for one part, from the stored decision and review and the project's review now (of all parts, or of this one). */
export function partState(decision: ProjectTrust | null, reviewed: ReviewRecord | null, now: ProjectReview, part: TrustPart): PartTrust {
  if (decision === null) return "undecided";
  if (decision === "untrusted") return "untrusted";
  if (!reviewedParts(reviewed).has(part)) return "unreviewed";
  if (now.resources.some((resource) => resource.unreadable && kindOf(resource) === part)) return "stale";
  const before = partOf(reviewed!, part);
  const after = partOf(now.record, part);
  // A stored entry without a kind is a pi file (`kindOf`), so a review from before the parts compares as the pi part.
  return sameReview(before, after) ? "holds" : "stale";
}

/** The stored decision and review; a store that cannot be read counts as "untrusted" (fails closed, and asks nothing). */
function storedTrust(records: ProjectTrustRecords | (() => ProjectTrustRecords), cwd: string): { decision: ProjectTrust | null; reviewed: ReviewRecord | null } {
  try {
    const store = typeof records === "function" ? records() : records;
    const decision = store.getProjectTrust(cwd);
    return { decision, reviewed: decision === "trusted" ? (store.getProjectReview?.(cwd) ?? null) : null };
  } catch {
    return { decision: "untrusted", reviewed: null };
  }
}

/**
 * Where the pi part or the git part of the project's trust stands now (`PartTrust`), never asking. The store is read first, so an
 * undecided or untrusted project costs no review; the review is `currentProjectReview` (cached). The command part is
 * `trustedProjectCommands`, which reads the commands themselves.
 */
export function partTrust(cwd: string, records: ProjectTrustRecords | (() => ProjectTrustRecords), part: "pi" | "git"): PartTrust {
  const { decision, reviewed } = storedTrust(records, cwd);
  if (decision !== "trusted") return decision === null ? "undecided" : "untrusted";
  try {
    return partState(decision, reviewed, currentProjectReview(cwd), part);
  } catch {
    return "stale";
  }
}

/** Whether the project has anything in that part now (`currentProjectReview`, cached). */
export const hasPart = (cwd: string, part: TrustPart) => currentProjectReview(cwd).resources.some((resource) => kindOf(resource) === part);

/**
 * The project's commands the loader may use, read once each, now (never from the stat cache): only while the command part of the
 * trust holds, that is the stored decision is "trusted" and the commands read now hash to what was reviewed. The texts returned
 * are the very bytes that were hashed, so a file swapped after the check is never what loads. `present` says whether the project
 * has commands at all (for the notice that they are not used).
 */
export function trustedProjectCommands(
  cwd: string,
  records: ProjectTrustRecords | (() => ProjectTrustRecords),
): { state: PartTrust; present: boolean; commands: ProjectCommandFile[] } {
  const { decision, reviewed } = storedTrust(records, cwd);
  const project = canonical(cwd);
  const outer = touched;
  touched = null;
  try {
    const hashed = hashCommands(project);
    const state = partState(decision, reviewed, finishReview(hashed), "command");
    const commands = state === "holds" ? hashed.flatMap((entry) => (entry.command ? [entry.command] : [])) : [];
    return { state, present: hashed.length > 0, commands };
  } finally {
    touched = outer;
  }
}

export type EntryChange = "added" | "changed" | "unchanged" | "unreviewed";

/** How the project differs from what the user reviewed when trusting it. */
export type ProjectChanges = {
  /** False when there is no earlier review to compare with (the trust was stored before reviews were kept): `status` and `removed` are then empty. */
  known: boolean;
  /**
   * Per listed path (as `findProjectResources` names it). "unreviewed": in a part the earlier review did not cover (commands and git
   * settings, for a review from before marcsh reviewed them), so not a change. A path listed in two parts gets the bigger change.
   */
  status: Map<string, EntryChange>;
  /** Paths that were reviewed and are no longer there. */
  removed: string[];
};

const CHANGE_WEIGHT: Record<EntryChange, number> = { unchanged: 0, unreviewed: 1, added: 2, changed: 3 };

/** Whether the changes hold any real one: something added, changed or removed since the review (or no review to compare with). */
export const hasRealChanges = (changes: ProjectChanges) =>
  !changes.known || changes.removed.length > 0 || [...changes.status.values()].some((change) => change === "added" || change === "changed");

export function diffReview(reviewed: ReviewRecord | null, current: ReviewRecord): ProjectChanges {
  if (!reviewed) return { known: false, status: new Map(), removed: [] };
  const parts = reviewedParts(reviewed);
  const key = (entry: ReviewRecord[number]) => `${kindOf(entry)}\0${entry.path}`;
  const before = new Map(reviewed.map((entry) => [key(entry), entry]));
  const status = new Map<string, EntryChange>();
  const seen = new Set<string>();
  for (const entry of current) {
    seen.add(key(entry));
    const old = before.get(key(entry));
    const change: EntryChange = !parts.has(kindOf(entry))
      ? "unreviewed"
      : !old
        ? "added"
        : old.shown === entry.shown && old.content === entry.content
          ? "unchanged"
          : "changed";
    const earlier = status.get(entry.path);
    if (earlier === undefined || CHANGE_WEIGHT[change] > CHANGE_WEIGHT[earlier]) status.set(entry.path, change);
  }
  return { known: true, status, removed: reviewed.filter((entry) => !seen.has(key(entry))).map((entry) => entry.path) };
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
 * Whether pi may load the project's own files for this turn: the pi part of the trust (`partState`). The question lists the whole
 * review (pi files, project commands, git settings) and a "trust" stores all of it, but only the pi part decides whether pi asks:
 * commands and git settings never make pi trusted, and a change to them does not ask (they wait for `/trust`).
 *
 * - No pi files: false, nothing is asked or stored (there is nothing for pi to load).
 * - A pi file marcsh could not read (see `unreadablePiFiles`): never true. Trusting would load what the user cannot be shown,
 *   and the file may have grown since an earlier "trusted", so that decision is not honored: the user is told again (the
 *   question offers only "distrust" and "skip"; a "trust" answer is ignored). A stored "untrusted" stays, without asking.
 * - A stored "untrusted": untrusted, without asking.
 * - A stored "trusted": trusted only while the pi part is as the user reviewed it (a review stored before marcsh reviewed commands
 *   and git settings is its pi part). If a pi file was added, removed or changed, or the row has no record (it predates reviews), the
 *   user is asked again, with `changes` saying what differs.
 * - Undecided (or a trusted that must be asked again): the user is asked; "trust" (with the record of what was shown) and
 *   "distrust" are stored, "skip" (Esc, no host to ask, an aborted turn) is untrusted for this turn only and stores nothing.
 *   A "trust" is also dropped when the project changed while the question was open: what was shown is not what would load.
 *
 * A store that cannot be read or written never trusts: reading fails closed, and a decision that cannot be saved still applies to this turn.
 */
export async function resolveProjectTrust({ cwd, records, ask, signal }: ResolveProjectTrustOptions): Promise<boolean> {
  const review = reviewProject(cwd);
  const { resources, record } = review;
  if (!resources.some((resource) => kindOf(resource) === "pi")) return false;
  const reviewable = unreadablePiFiles(resources).length === 0;

  let store: ProjectTrustRecords;
  let changes: ProjectChanges | undefined;
  try {
    store = records();
    const stored = store.getProjectTrust(cwd);
    if (stored === "untrusted") return false;
    if (stored === "trusted" && reviewable) {
      const reviewed = store.getProjectReview?.(cwd) ?? null;
      if (partState(stored, reviewed, review, "pi") === "holds") return true;
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
 * Whether the whole stored trust holds now, every part of it (what `/trust` shows as "Now: trusted"): the stored decision is
 * "trusted" and the review stored with it equals the project's review now (the empty one included), with nothing unreadable.
 * Consumers check only their own part (`partTrust`, `trustedProjectCommands`). Never asks; the review is `currentProjectReview`.
 */
export function projectTrustHolds(cwd: string, records: ProjectTrustRecords | (() => ProjectTrustRecords)): boolean {
  const { decision, reviewed } = storedTrust(records, cwd);
  if (decision !== "trusted") return false;
  try {
    const now = currentProjectReview(cwd);
    return (["pi", "command", "git"] as const).every((part) => partState(decision, reviewed, now, part) === "holds");
  } catch {
    return false;
  }
}

/**
 * Whether pi may load the project's own files without asking anyone, as warm-up and `marcsh mcp` need: the pi part holds
 * (`partTrust`), for a project that has pi files (otherwise false, and the store is not opened).
 */
export function isProjectTrusted(cwd: string, records: () => ProjectTrustRecords): boolean {
  if (!hasPart(cwd, "pi")) return false;
  return partTrust(cwd, records, "pi") === "holds";
}

/** What a run with nobody to ask says on stderr when a trusted project's pi part does not hold, so pi does not load its files. */
export function headlessPiNote(state: PartTrust): string | null {
  if (state === "stale") return "this project's pi files changed since you trusted them, so pi does not load them: run marcsh and /trust";
  if (state === "unreviewed") return "this project was trusted before marcsh kept reviews, so pi does not load its files: run marcsh and /trust";
  return null;
}
