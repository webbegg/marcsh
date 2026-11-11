import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { MAX_AGENT_BYTES, parseAgentFile } from "./agents";
import { Mode } from "./modes";

/*
 * Packs: a GitHub repo in the Claude plugin layout plus `agents/*.md`, installed under ~/.marcsh/packs.
 *
 * A pack is third-party content, so nothing of it ever runs: git runs without hooks, submodules, LFS or prompts; the
 * clone is scanned before anything is moved into place (no symlink may leave it); and the Claude/pi plugin loaders are
 * pointed at a generated `plugin/` view that holds COPIES of the regular files under `skills/` and `commands/` that the scan
 * read, and nothing else: no links, no pack hooks, MCP servers or agent files, so what the engines can load is what was scanned
 * and previewed. Installing and updating need the user's consent after a preview; nothing is automatic.
 *
 *   <root>/packs.json              the lockfile: every pack pinned to the commit that was previewed and accepted
 *   <root>/<owner>/<repo>/src      the clone at that commit
 *   <root>/<owner>/<repo>/plugin   the generated view
 *   <root>/.staging/               fetches in progress; always removed
 *
 * MARCSH_PACKS_DIR moves the root (tests). MARCSH_PACK_URL_BASE replaces `https://github.com` (tests, with `file://`).
 */

export class PackError extends Error {}

export type PackEntry = {
  id: string;
  url: string;
  ref?: string;
  /** The full SHA that was previewed and accepted. */
  commit: string;
  installedAt: string;
};

export type PackSpec = { id: string; url: string; ref?: string };

export type PackPreview = {
  id: string;
  commit: string;
  /** Set on an update: the commit being replaced. */
  previousCommit?: string;
  agents: { name: string; permission: "read-only" | "build"; model?: string }[];
  skills: string[];
  commands: string[];
  /** Parts of the pack that marcsh does not use (it never runs hooks or MCP servers). */
  ignored: string[];
  /** Parts marcsh does use that deserve a look before consenting. */
  warnings: string[];
};

type Confirm = (preview: PackPreview) => boolean | Promise<boolean>;
type RootOption = { root?: string };

const FETCH_TIMEOUT_MS = 120_000;
const FORMS = "Use owner/repo, owner/repo@ref or https://github.com/owner/repo";

export function packsRoot() {
  return process.env.MARCSH_PACKS_DIR?.trim() || join(homedir(), ".marcsh", "packs");
}

const OWNER = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const REPO = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
const REF = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
// What git is given as the repository: https (GitHub) or file (tests), and nothing that could be read as an option.
const URL_FORM = /^(?:https|file):\/\/[^\s\u0000-\u001f\u007f]+$/;

const isRef = (ref: string) => REF.test(ref) && !ref.includes("..") && !ref.endsWith("/") && !ref.endsWith(".lock");

function isName(owner: string, repo: string) {
  return OWNER.test(owner) && REPO.test(repo) && !repo.includes("..") && repo !== ".";
}

const isPackId = (id: unknown): id is string => {
  if (typeof id !== "string") return false;
  const [owner, repo, ...rest] = id.split("/");
  return rest.length === 0 && owner !== undefined && repo !== undefined && isName(owner, repo);
};

function assertPackId(id: string) {
  if (!isPackId(id)) throw new PackError(`"${id}" is not a pack ID. ${FORMS}`);
}

/** `owner/repo[@ref]` or a github.com URL (+ `@ref`); anything else is rejected. */
export function parsePackSpec(text: string, { urlBase }: { urlBase?: string } = {}): PackSpec {
  const bad = (why: string) => new PackError(`Cannot install "${text.trim()}": ${why}. ${FORMS}`);
  const input = text.trim();
  const form = /^(?:https:\/\/github\.com\/)?([^/@\s]+)\/([^/@\s]+?)(?:\.git)?(?:@(.*))?$/.exec(input);
  if (!form) throw bad("not a GitHub repository");
  const [, owner, repo, ref] = form as unknown as [string, string, string, string | undefined];
  if (!isName(owner, repo)) throw bad("the owner or repository name has characters GitHub does not allow");
  if (ref !== undefined && !isRef(ref)) throw bad("the ref is not a plain branch, tag or commit name");
  const id = `${owner}/${repo}`.toLowerCase();
  const base = (urlBase ?? process.env.MARCSH_PACK_URL_BASE?.trim()) || undefined;
  const url = base ? `${base.replace(/\/+$/, "")}/${id}` : `https://github.com/${id}.git`;
  return ref === undefined ? { id, url } : { id, url, ref };
}

const packDir = (id: string, root: string) => join(root, ...id.split("/"));

/** The generated plugin view of an installed pack: what the engines load while one of its agents is selected. */
export function packPluginDir(id: string, root = packsRoot()) {
  assertPackId(id);
  return join(packDir(id, root), "plugin");
}

/** Where an installed pack's `agents/*.md` are read from. */
export function packAgentsDir(id: string, root = packsRoot()) {
  assertPackId(id);
  return join(packDir(id, root), "src", "agents");
}

const lockPath = (root: string) => join(root, "packs.json");

/** A lock entry's url and ref are held to the rules an install applies, every time they are read: they end up on git's command line. */
const isSafeEntry = (item: PackEntry) => URL_FORM.test(item.url) && (item.ref === undefined || (typeof item.ref === "string" && isRef(item.ref)));

function readLock(root: string, strict: boolean): PackEntry[] {
  let text: string;
  try {
    text = readFileSync(lockPath(root), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || !strict) return [];
    throw new PackError(`${lockPath(root)} cannot be read; fix or delete it`);
  }
  try {
    const parsed = JSON.parse(text) as { packs?: unknown };
    if (!Array.isArray(parsed.packs)) throw new Error("no packs list");
    const entries = parsed.packs.filter(
      (item): item is PackEntry =>
        !!item && isPackId(item.id) && typeof item.url === "string" && typeof item.commit === "string" && typeof item.installedAt === "string",
    );
    const unsafe = entries.find((item) => !isSafeEntry(item));
    // Listing skips an entry git must not be handed; a command that would use or rewrite the lockfile stops instead of dropping it.
    if (unsafe && strict) throw new PackError(`${lockPath(root)}: the entry for ${unsafe.id} has a url or ref that is not valid; fix or delete it`);
    return entries.filter(isSafeEntry);
  } catch (error) {
    if (strict) throw error instanceof PackError ? error : new PackError(`${lockPath(root)} cannot be read; fix or delete it`);
    return [];
  }
}

function writeLock(root: string, packs: PackEntry[]) {
  mkdirSync(root, { recursive: true });
  const temp = `${lockPath(root)}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ packs }, null, 2)}\n`);
  renameSync(temp, lockPath(root));
}

/** Reads the lockfile again right before writing it, so an entry added since the command began is kept. */
function changeLock(root: string, change: (packs: PackEntry[]) => PackEntry[]) {
  writeLock(root, change(readLock(root, true)));
}

/** The installed packs, in the order they were installed. An unreadable lockfile lists none. */
export function listPacks({ root = packsRoot() }: RootOption = {}): PackEntry[] {
  return readLock(root, false);
}

// ---- git ----

function git(cwd: string, args: string[], { url, timeoutMs }: { url: string; timeoutMs: number }): Promise<string> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_ALLOW_PROTOCOL: url.startsWith("file:") ? "https:file" : "https",
  };
  // No program of the user's environment is run to ask for or supply a credential.
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_EXTERNAL_DIFF", "GIT_ASKPASS", "SSH_ASKPASS"]) delete env[name];
  const hardened = [
    "-c", "core.askPass=",
    "-c", "credential.helper=",
    "-c", "core.hooksPath=/dev/null",
    "-c", "protocol.ext.allow=never",
    "-c", "core.fsmonitor=false",
    "-c", "submodule.recurse=false",
    "-c", "advice.detachedHead=false",
  ];
  return new Promise((done, fail) => {
    // An argv array, never a shell string: nothing in the URL or ref is interpreted.
    const child = spawn("git", [...hardened, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, killSignal: "SIGKILL" });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", (error) => fail(new PackError(`git could not run: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (code === 0) return done(out.trim());
      // The server's own words reach the toast: cleaned, and only the end of them (git puts the reason last).
      const why = signal ? `timed out after ${Math.round(timeoutMs / 1000)} s` : printable(err.trim()).slice(-MAX_GIT_MESSAGE) || `exited with ${code}`;
      fail(new PackError(`git ${args[0]} failed: ${why}`));
    });
  });
}

type Fetched = { staging: string; src: string; commit: string };

// A fetch waits for the user's answer before it moves anything, so the limit is generous: another process's directory must outlive that.
const STALE_STAGING_MS = 24 * 3600_000;
const MAX_GIT_MESSAGE = 500;

/** Marks a directory as in use now: a rename keeps the old mtime, and the stale cleanup of another process goes by it. */
function touch(path: string) {
  try {
    const now = new Date();
    utimesSync(path, now, now);
  } catch {}
}

/** Fetches that were killed leave their directory behind: those untouched for a day are deleted. */
function removeStaleStaging(stagingRoot: string) {
  for (const item of listDir(stagingRoot)) {
    if (!/^(?:old-)?pack-/.test(item.name)) continue;
    const path = join(stagingRoot, item.name);
    try {
      if (Date.now() - lstatSync(path).mtimeMs > STALE_STAGING_MS) rmSync(path, { recursive: true, force: true });
    } catch {}
  }
}

/** Fetches `url` at `ref` (else HEAD) into a fresh staging directory under `root`: one commit, no hooks, no submodules, no LFS. */
export async function fetchPack({
  url,
  ref,
  root = packsRoot(),
  timeoutMs = FETCH_TIMEOUT_MS,
}: { url: string; ref?: string } & RootOption & { timeoutMs?: number }): Promise<Fetched> {
  if (!URL_FORM.test(url) || (ref !== undefined && !isRef(ref))) throw new PackError("Pack rejected: the repository URL or ref is not valid");
  const stagingRoot = join(root, ".staging");
  mkdirSync(stagingRoot, { recursive: true });
  removeStaleStaging(stagingRoot);
  const staging = mkdtempSync(join(stagingRoot, "pack-"));
  const src = join(staging, "src");
  try {
    mkdirSync(src);
    const run = (...args: string[]) => git(src, args, { url, timeoutMs });
    await run("init", "-q", "--template=");
    // After `--`, so neither can be taken for an option.
    await run("fetch", "-q", "--depth", "1", "--no-tags", "--no-recurse-submodules", "--", url, ref ?? "HEAD");
    await run("checkout", "-q", "--detach", "--no-recurse-submodules", "FETCH_HEAD");
    // A detached HEAD file holds the commit itself.
    const commit = readFileSync(join(src, ".git", "HEAD"), "utf8").trim();
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) throw new PackError(`git did not check out a commit (${commit.slice(0, 40)})`);
    return { staging, src, commit };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

// ---- scan and preview ----

function listDir(path: string) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function head(path: string, bytes = 65536) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    return buffer.subarray(0, readSync(fd, buffer, 0, bytes, 0)).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

const rejected = (why: string) => new PackError(`Pack rejected: ${why}`);

const MAX_PART_BYTES = 1024 * 1024;

/**
 * Every file under `skills/` or `commands/`, as paths relative to the clone. Only real folders and regular files of at most 1 MB are
 * accepted: a link, a device or anything else rejects the pack, so the view can be built from exactly this list.
 */
function listPart(src: string, part: "skills" | "commands"): string[] {
  let top;
  try {
    top = lstatSync(join(src, part));
  } catch {
    return [];
  }
  if (!top.isDirectory()) throw rejected(`${part} is ${top.isSymbolicLink() ? "a symlink" : "not a folder"}; only real folders and files are used`);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(src, dir)).sort()) {
      const rel = `${dir}/${name}`;
      const stat = lstatSync(join(src, rel));
      if (stat.isDirectory()) walk(rel);
      else if (!stat.isFile()) throw rejected(`${printable(rel)} is ${stat.isSymbolicLink() ? "a symlink" : "not a regular file"}; ${part}/ may hold only regular files`);
      else if (stat.size > MAX_PART_BYTES) throw rejected(`${printable(rel)} is larger than 1 MB`);
      else files.push(rel);
    }
  };
  walk(part);
  return files;
}

/** `key:` as a YAML key in any spelling a line can start with: plain, quoted, indented, a list item or inside `{ }`. */
const keyAnywhere = (key: string) => new RegExp(`(?:^|[-?{,\\[])[ \\t]*["']?[ \\t]*${key}[ \\t]*["']?[ \\t]*:`, "im");

function collectKeys(value: unknown, keys: Set<string>, seen = new Set<object>()) {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  for (const [key, inner] of Object.entries(value)) {
    if (!Array.isArray(value)) keys.add(key.trim().toLowerCase());
    collectKeys(inner, keys, seen);
  }
}

/**
 * Whether a file's frontmatter declares `hooks` or `allowed-tools`, at any depth and however the key is written (plain, quoted,
 * indented, in a `{ }` mapping, upper case). It is read as YAML and ALSO searched as text, so a key the YAML reader would see
 * differently from Claude Code's or pi's reader still stops the pack. Throws when the frontmatter is not unambiguous: a marker
 * line with other text on it, no closing line, or YAML that does not parse.
 */
function declaredKeys(text: string): { hooks: boolean; allowedTools: boolean } {
  const lines = text.replace(/\r\n?/g, "\n").trimStart().split("\n");
  if (!lines[0]!.startsWith("---")) return { hooks: false, allowedTools: false };
  if (lines[0]!.trim() !== "---") throw new Error("the opening --- line has other text on it");
  const end = lines.findIndex((line, index) => index > 0 && line.startsWith("---"));
  if (end < 0) throw new Error("it is never closed");
  if (lines[end]!.trim() !== "---") throw new Error("the closing --- line has other text on it");
  // YAML ends a document at `...`, but the engines' readers disagree on what comes after it, so it could hide a key.
  if (lines.slice(1, end).some((line) => line.trim() === "...")) throw new Error("a ... line ends the YAML early");

  const yaml = lines.slice(1, end).join("\n");
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(yaml);
  } catch {
    throw new Error("it is not valid YAML");
  }
  const keys = new Set<string>();
  collectKeys(parsed, keys);
  return {
    hooks: keys.has("hooks") || keyAnywhere("hooks").test(yaml),
    allowedTools: keys.has("allowed-tools") || keyAnywhere("allowed-tools").test(yaml),
  };
}

/** The skills and commands of a clone: every regular file the generated view is copied from, and what the preview lists. */
type Parts = { files: string[]; skills: string[]; commands: string[]; warnings: string[] };

/** Lists `skills/` and `commands/` and reads every `.md` in them whole (any case of the extension). Throws if a file declares hooks. */
function readParts(src: string): Parts {
  const files = [...listPart(src, "skills"), ...listPart(src, "commands")];
  const warnings: string[] = [];
  for (const file of files) {
    if (!file.toLowerCase().endsWith(".md")) continue;
    let found;
    try {
      found = declaredKeys(readFileSync(join(src, file), "utf8"));
    } catch (error) {
      throw rejected(`the frontmatter of ${printable(file)} cannot be read unambiguously (${(error as Error).message})`);
    }
    if (found.hooks) throw rejected(`${printable(file)} declares hooks, which marcsh never runs`);
    if (found.allowedTools) warnings.push(`${file} pre-approves tools (allowed-tools)`);
  }
  // A skill is a folder with a SKILL.md (any case), or a .md directly in skills/ (pi loads those too); a command is any .md
  // under commands/, named by its path.
  const skills = files
    .filter((file) => file.startsWith("skills/") && basename(file).toLowerCase() === "skill.md")
    .map((file) => relative("skills", dirname(file)) || ".");
  const rootSkills = files
    .filter((file) => dirname(file) === "skills" && file.toLowerCase().endsWith(".md") && basename(file).toLowerCase() !== "skill.md")
    .map((file) => basename(file).slice(0, -3));
  skills.push(...rootSkills);
  const commands = files.filter((file) => file.startsWith("commands/") && file.toLowerCase().endsWith(".md")).map((file) => relative("commands", file).slice(0, -3));
  return { files, skills: skills.sort(), commands: commands.sort(), warnings };
}

// Like the loader, a pack's `agents` folder is not read through a link.
const agentsIsLink = (src: string) => {
  try {
    return lstatSync(join(src, "agents")).isSymbolicLink();
  } catch {
    return false;
  }
};

function agentFiles(src: string) {
  if (agentsIsLink(src)) return [];
  return listDir(join(src, "agents"))
    .filter((item) => item.isFile() && item.name.endsWith(".md"))
    .map((item) => item.name)
    .sort();
}

function walkForLinks(clone: string, dir: string, cloneReal: string, bad: string[]) {
  for (const item of listDir(dir)) {
    if (dir === clone && item.name === ".git") continue;
    const path = join(dir, item.name);
    if (item.isDirectory()) walkForLinks(clone, path, cloneReal, bad);
    else if (item.isSymbolicLink()) {
      let target: string;
      try {
        target = realpathSync(path);
      } catch {
        // A dangling link: judge where it points.
        target = resolve(realpathSync(dir), readlinkSync(path));
      }
      if (target !== cloneReal && !target.startsWith(cloneReal + sep)) bad.push(path.slice(clone.length + 1));
    }
  }
}

/**
 * Throws unless the clone is safe to keep: no symlink leaves it, `agents/`, `skills/` and `commands/` hold no links, it has a primary
 * agent, no agent file is huge, no skill or command declares hooks. Returns what the view is built from.
 */
export function scanPack(src: string): Parts {
  const outside: string[] = [];
  walkForLinks(src, src, realpathSync(src), outside);
  if (outside.length > 0) {
    throw new PackError(`Pack rejected: ${printable(outside[0]!)} is a symlink that points outside the pack${outside.length > 1 ? ` (and ${outside.length - 1} more)` : ""}`);
  }

  if (agentsIsLink(src)) throw rejected("agents is a symlink, so its files would not be read");
  let primary = 0;
  for (const file of agentFiles(src)) {
    const path = join(src, "agents", file);
    if (lstatSync(path).size > MAX_AGENT_BYTES) throw new PackError(`Pack rejected: agents/${printable(file)} is larger than ${MAX_AGENT_BYTES / 1024} KB`);
    const agent = parseAgentFile(readFileSync(path, "utf8"), { pack: "pack", file });
    // The loader keeps such a file as a Build agent whose prompt starts with the frontmatter; a pack fails closed instead.
    if (agent?.ignored.includes("frontmatter")) throw rejected(`agents/${printable(file)} has a frontmatter that is never closed`);
    if (agent) primary++;
  }
  if (primary === 0) throw new PackError("Pack rejected: it has no primary agent in agents/*.md");

  return readParts(src);
}

function pluginManifestKeys(src: string): Set<string> {
  try {
    const manifest = JSON.parse(head(join(src, ".claude-plugin", "plugin.json"), 262144));
    return new Set(manifest && typeof manifest === "object" ? Object.keys(manifest) : []);
  } catch {
    return new Set();
  }
}

/**
 * Text from a pack as it may reach the terminal: every control character (ESC sequences start with one) and every Unicode format
 * character (zero-width, bidi controls, word joiner, soft hyphen, tag characters...) is removed; those change how a line reads without showing.
 */
export const printable = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/\p{Cf}/gu, "");

/** What the pack holds and what marcsh will not use of it, read without running or following anything. `parts` is what `scanPack` read. */
export function previewPack(src: string, { id, commit }: { id: string; commit: string }, parts: Parts = readParts(src)): PackPreview {
  const agents: PackPreview["agents"] = [];
  const subagents: string[] = [];
  for (const file of agentFiles(src)) {
    let agent;
    try {
      agent = parseAgentFile(readFileSync(join(src, "agents", file), "utf8"), { pack: id, file });
    } catch {
      continue;
    }
    if (!agent) subagents.push(file);
    else agents.push({ name: agent.name, permission: agent.mode === Mode.PLAN ? "read-only" : "build", ...(agent.model ? { model: agent.model } : {}) });
  }

  const manifest = pluginManifestKeys(src);
  const ignored = [
    ...(listDir(src).some((item) => item.name === "hooks" && item.isDirectory()) ? ["hooks/"] : []),
    ...(listDir(src).some((item) => item.name === ".mcp.json") ? [".mcp.json"] : []),
    ...(manifest.has("hooks") ? [".claude-plugin hooks"] : []),
    ...(manifest.has("mcpServers") ? [".claude-plugin mcpServers"] : []),
    ...subagents.map((file) => `subagent ${file}`),
  ];

  const clean = (items: string[]) => items.map(printable);
  return {
    id,
    commit,
    agents: agents.map((agent) => ({ ...agent, name: printable(agent.name), ...(agent.model ? { model: printable(agent.model) } : {}) })),
    skills: clean(parts.skills),
    commands: clean(parts.commands),
    ignored: clean(ignored),
    warnings: clean(parts.warnings),
  };
}

// ---- install, update, remove ----

/**
 * Writes `<staging>/plugin`: a manifest and copies of the files `scanPack` read under skills/ and commands/, nothing else. Copies, not
 * links: what the engines can load is then exactly what was scanned and previewed, even if the clone is changed afterwards.
 */
function writePluginView(staging: string, id: string, { files }: Parts) {
  const view = join(staging, "plugin");
  mkdirSync(join(view, ".claude-plugin"), { recursive: true });
  const name = id.replace(/\//g, "-").replace(/[^A-Za-z0-9-]+/g, "-");
  writeFileSync(join(view, ".claude-plugin", "plugin.json"), `${JSON.stringify({ name, description: `Skills and commands of the marcsh pack ${id}` }, null, 2)}\n`);
  for (const file of files) {
    const from = join(staging, "src", file);
    if (!lstatSync(from).isFile()) throw rejected(`${printable(file)} changed while the pack was being installed`);
    mkdirSync(dirname(join(view, file)), { recursive: true });
    copyFileSync(from, join(view, file));
  }
}

const discard = (path: string) => rmSync(path, { recursive: true, force: true });

export type InstallResult = { status: "installed"; pack: PackEntry; preview: PackPreview } | { status: "cancelled" };

/** Fetches the pack, scans and previews it, and installs it only if `confirm` says yes. */
export async function installPack(
  text: string,
  { confirm, root = packsRoot(), urlBase }: { confirm: Confirm; urlBase?: string } & RootOption,
): Promise<InstallResult> {
  const spec = parsePackSpec(text, { urlBase });
  const existing = readLock(root, true);
  if (existing.some((pack) => pack.id === spec.id)) throw new PackError(`${spec.id} is already installed; use update to move it to a newer commit`);
  const target = packDir(spec.id, root);
  if (existsSync(target)) throw new PackError(`${target} exists but is not an installed pack; remove it first`);

  const { staging, src, commit } = await fetchPack({ url: spec.url, ref: spec.ref, root });
  try {
    const parts = scanPack(src);
    const preview = previewPack(src, { id: spec.id, commit }, parts);
    // The view is copied from what was just read, before the user is asked.
    writePluginView(staging, spec.id, parts);
    if (!(await confirm(preview))) return { status: "cancelled" };

    mkdirSync(dirname(target), { recursive: true });
    touch(staging);
    renameSync(staging, target);
    const pack: PackEntry = { id: spec.id, url: spec.url, ...(spec.ref ? { ref: spec.ref } : {}), commit, installedAt: new Date().toISOString() };
    try {
      changeLock(root, (latest) => {
        if (latest.some((item) => item.id === pack.id)) throw new PackError(`${pack.id} is already installed; use update to move it to a newer commit`);
        return [...latest, pack];
      });
    } catch (error) {
      discard(target);
      throw error;
    }
    return { status: "installed", pack, preview };
  } finally {
    discard(staging);
  }
}

export type UpdateResult =
  | { status: "updated"; pack: PackEntry; preview: PackPreview }
  | { status: "up-to-date"; pack: PackEntry }
  | { status: "cancelled" };

/** Fetches the commit the pack's ref (else HEAD) points at now; if it differs, previews old → new and swaps it in on consent. */
export async function updatePack(
  id: string,
  { confirm, root = packsRoot() }: { confirm: Confirm } & RootOption,
): Promise<UpdateResult> {
  assertPackId(id);
  const current = readLock(root, true).find((pack) => pack.id === id);
  if (!current) throw new PackError(`${id} is not installed`);

  const { staging, src, commit } = await fetchPack({ url: current.url, ref: current.ref, root });
  const retired = join(root, ".staging", `old-${basename(staging)}`);
  try {
    if (commit === current.commit) return { status: "up-to-date", pack: current };
    const parts = scanPack(src);
    const preview = { ...previewPack(src, { id, commit }, parts), previousCommit: current.commit };
    writePluginView(staging, id, parts);
    if (!(await confirm(preview))) return { status: "cancelled" };

    const target = packDir(id, root);
    const hadOld = existsSync(target);
    touch(staging);
    if (hadOld) {
      renameSync(target, retired);
      touch(retired);
    }
    try {
      renameSync(staging, target);
    } catch (error) {
      // The retired copy is the only one left: put it back instead of letting the cleanup below delete it.
      if (hadOld) renameSync(retired, target);
      throw error;
    }
    const pack: PackEntry = { ...current, commit, installedAt: new Date().toISOString() };
    try {
      changeLock(root, (latest) => {
        if (!latest.some((item) => item.id === id)) throw new PackError(`${id} was removed while it was being updated`);
        return latest.map((item) => (item.id === id ? pack : item));
      });
    } catch (error) {
      discard(target);
      if (hadOld) renameSync(retired, target);
      throw error;
    }
    return { status: "updated", pack, preview };
  } finally {
    discard(staging);
    discard(retired);
  }
}

/** Deletes the pack's directory and its lock entry. */
export async function removePack(id: string, { root = packsRoot() }: RootOption = {}): Promise<void> {
  assertPackId(id);
  changeLock(root, (packs) => {
    if (!packs.some((pack) => pack.id === id)) throw new PackError(`${id} is not installed`);
    return packs.filter((pack) => pack.id !== id);
  });
  discard(packDir(id, root));
  try {
    // The owner's folder goes with its last pack; rmdir refuses a folder that still holds one.
    rmdirSync(dirname(packDir(id, root)));
  } catch {}
}
