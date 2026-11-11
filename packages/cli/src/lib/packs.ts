import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { MAX_AGENT_BYTES, parseAgentFile } from "./agents";
import { Mode } from "./modes";

/*
 * Packs: a GitHub repo in the Claude plugin layout plus `agents/*.md`, installed under ~/.marcsh/packs.
 *
 * A pack is third-party content, so nothing of it ever runs: git runs without hooks, submodules, LFS or prompts; the
 * clone is scanned before anything is moved into place (no symlink may leave it); and the Claude/pi plugin loaders are
 * pointed at a generated `plugin/` view that holds only links to `skills/` and `commands/`: pack hooks, MCP servers and
 * agent files are not in it. Installing and updating need the user's consent after a preview; nothing is automatic.
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
  if (ref !== undefined && (!REF.test(ref) || ref.includes("..") || ref.endsWith("/") || ref.endsWith(".lock"))) {
    throw bad("the ref is not a plain branch, tag or commit name");
  }
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
    return parsed.packs.filter(
      (item): item is PackEntry =>
        !!item && isPackId(item.id) && typeof item.url === "string" && typeof item.commit === "string" && typeof item.installedAt === "string",
    );
  } catch {
    if (strict) throw new PackError(`${lockPath(root)} cannot be read; fix or delete it`);
    return [];
  }
}

function writeLock(root: string, packs: PackEntry[]) {
  mkdirSync(root, { recursive: true });
  const temp = `${lockPath(root)}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ packs }, null, 2)}\n`);
  renameSync(temp, lockPath(root));
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
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_EXTERNAL_DIFF"]) delete env[name];
  const hardened = [
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
      const why = signal ? `timed out after ${Math.round(timeoutMs / 1000)} s` : err.trim() || `exited with ${code}`;
      fail(new PackError(`git ${args[0]} failed: ${why}`));
    });
  });
}

type Fetched = { staging: string; src: string; commit: string };

/** Fetches `url` at `ref` (else HEAD) into a fresh staging directory under `root`: one commit, no hooks, no submodules, no LFS. */
export async function fetchPack({
  url,
  ref,
  root = packsRoot(),
  timeoutMs = FETCH_TIMEOUT_MS,
}: { url: string; ref?: string } & RootOption & { timeoutMs?: number }): Promise<Fetched> {
  const stagingRoot = join(root, ".staging");
  mkdirSync(stagingRoot, { recursive: true });
  const staging = mkdtempSync(join(stagingRoot, "pack-"));
  const src = join(staging, "src");
  try {
    mkdirSync(src);
    const run = (...args: string[]) => git(src, args, { url, timeoutMs });
    await run("init", "-q", "--template=");
    await run("fetch", "-q", "--depth", "1", "--no-tags", "--no-recurse-submodules", url, ref ?? "HEAD");
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

/** The files under `dir` ending in `.md`, as paths relative to `base`; symlinks are not followed. */
function markdownUnder(base: string, dir: string): string[] {
  const found: string[] = [];
  for (const item of listDir(join(base, dir))) {
    const rel = `${dir}/${item.name}`;
    if (item.isDirectory()) found.push(...markdownUnder(base, rel));
    else if (item.isFile() && item.name.endsWith(".md")) found.push(rel);
  }
  return found;
}

function frontmatterKeys(text: string): Set<string> {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const keys = new Set<string>();
  if (lines[0]?.trim() !== "---") return keys;
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") break;
    const key = /^([A-Za-z0-9_-]+)[ \t]*:/.exec(line)?.[1];
    if (key) keys.add(key.toLowerCase());
  }
  return keys;
}

const skillAndCommandFiles = (src: string) => [...markdownUnder(src, "skills"), ...markdownUnder(src, "commands")];

function agentFiles(src: string) {
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

/** Throws unless the clone is safe to keep: no symlink leaves it, it has a primary agent, no agent file is huge, no skill or command declares hooks. */
export function scanPack(src: string) {
  const outside: string[] = [];
  walkForLinks(src, src, realpathSync(src), outside);
  if (outside.length > 0) {
    throw new PackError(`Pack rejected: ${outside[0]} is a symlink that points outside the pack${outside.length > 1 ? ` (and ${outside.length - 1} more)` : ""}`);
  }

  let primary = 0;
  for (const file of agentFiles(src)) {
    const path = join(src, "agents", file);
    if (lstatSync(path).size > MAX_AGENT_BYTES) throw new PackError(`Pack rejected: agents/${file} is larger than ${MAX_AGENT_BYTES / 1024} KB`);
    if (parseAgentFile(readFileSync(path, "utf8"), { pack: "pack", file })) primary++;
  }
  if (primary === 0) throw new PackError("Pack rejected: it has no primary agent in agents/*.md");

  for (const file of skillAndCommandFiles(src)) {
    if (frontmatterKeys(head(join(src, file))).has("hooks")) {
      throw new PackError(`Pack rejected: ${file} declares hooks, which marcsh never runs`);
    }
  }
}

function pluginManifestKeys(src: string): Set<string> {
  try {
    const manifest = JSON.parse(head(join(src, ".claude-plugin", "plugin.json"), 262144));
    return new Set(manifest && typeof manifest === "object" ? Object.keys(manifest) : []);
  } catch {
    return new Set();
  }
}

/** Text from a pack as it may reach the terminal: every control character (ESC sequences start with one) is removed. */
export const printable = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

/** What the pack holds and what marcsh will not use of it, read without running or following anything. */
export function previewPack(src: string, { id, commit }: { id: string; commit: string }): PackPreview {
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

  const skills = listDir(join(src, "skills"))
    .filter((item) => item.isDirectory() && existsSync(join(src, "skills", item.name, "SKILL.md")))
    .map((item) => item.name)
    .sort();
  const commands = listDir(join(src, "commands"))
    .filter((item) => item.isFile() && item.name.endsWith(".md"))
    .map((item) => basename(item.name, extname(item.name)))
    .sort();

  const manifest = pluginManifestKeys(src);
  const ignored = [
    ...(listDir(src).some((item) => item.name === "hooks" && item.isDirectory()) ? ["hooks/"] : []),
    ...(listDir(src).some((item) => item.name === ".mcp.json") ? [".mcp.json"] : []),
    ...(manifest.has("hooks") ? [".claude-plugin hooks"] : []),
    ...(manifest.has("mcpServers") ? [".claude-plugin mcpServers"] : []),
    ...subagents.map((file) => `subagent ${file}`),
  ];

  const warnings = skillAndCommandFiles(src)
    .filter((file) => frontmatterKeys(head(join(src, file))).has("allowed-tools"))
    .map((file) => `${file} pre-approves tools (allowed-tools)`);

  const clean = (items: string[]) => items.map(printable);
  return {
    id,
    commit,
    agents: agents.map((agent) => ({ ...agent, name: printable(agent.name), ...(agent.model ? { model: printable(agent.model) } : {}) })),
    skills: clean(skills),
    commands: clean(commands),
    ignored: clean(ignored),
    warnings: clean(warnings),
  };
}

// ---- install, update, remove ----

/** Writes `<staging>/plugin`: a manifest and links to the pack's skills and commands, nothing else. */
function writePluginView(staging: string, id: string) {
  const view = join(staging, "plugin");
  mkdirSync(join(view, ".claude-plugin"), { recursive: true });
  const name = id.replace(/\//g, "-").replace(/[^A-Za-z0-9-]+/g, "-");
  writeFileSync(join(view, ".claude-plugin", "plugin.json"), `${JSON.stringify({ name, description: `Skills and commands of the marcsh pack ${id}` }, null, 2)}\n`);
  for (const part of ["skills", "commands"]) {
    if (existsSync(join(staging, "src", part))) symlinkSync(`../src/${part}`, join(view, part));
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
    scanPack(src);
    const preview = previewPack(src, { id: spec.id, commit });
    if (!(await confirm(preview))) return { status: "cancelled" };

    writePluginView(staging, spec.id);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(staging, target);
    const pack: PackEntry = { id: spec.id, url: spec.url, ...(spec.ref ? { ref: spec.ref } : {}), commit, installedAt: new Date().toISOString() };
    try {
      writeLock(root, [...existing, pack]);
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
  const packs = readLock(root, true);
  const current = packs.find((pack) => pack.id === id);
  if (!current) throw new PackError(`${id} is not installed`);

  const { staging, src, commit } = await fetchPack({ url: current.url, ref: current.ref, root });
  const retired = join(root, ".staging", `old-${basename(staging)}`);
  try {
    if (commit === current.commit) return { status: "up-to-date", pack: current };
    scanPack(src);
    const preview = { ...previewPack(src, { id, commit }), previousCommit: current.commit };
    if (!(await confirm(preview))) return { status: "cancelled" };

    writePluginView(staging, id);
    const target = packDir(id, root);
    const hadOld = existsSync(target);
    if (hadOld) renameSync(target, retired);
    renameSync(staging, target);
    const pack: PackEntry = { ...current, commit, installedAt: new Date().toISOString() };
    try {
      writeLock(root, packs.map((item) => (item.id === id ? pack : item)));
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
  const packs = readLock(root, true);
  if (!packs.some((pack) => pack.id === id)) throw new PackError(`${id} is not installed`);
  writeLock(root, packs.filter((pack) => pack.id !== id));
  discard(packDir(id, root));
  try {
    // The owner's folder goes with its last pack; rmdir refuses a folder that still holds one.
    rmdirSync(dirname(packDir(id, root)));
  } catch {}
}
