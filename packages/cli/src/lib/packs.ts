import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  utimesSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { MAX_AGENT_BYTES, parseAgentFile } from "./agent-file";
import { describeTools } from "./agent-tools";
import {
  COMMANDS_FILE,
  HOOKS_DIR,
  HOOKS_FILE,
  claudeHookFiles,
  digestFiles,
  hookEvents,
  parseHooksConsent,
  readHookFiles,
  readHooksDir,
  type HookFile,
  type HooksConfig,
  type HooksConsent,
  type HooksRead,
} from "./pack-hooks";
import { Mode } from "./modes";
import { listDir, marcshPluginPath } from "./plugin";
import { printable } from "./safe-text";

/*
 * Packs: a GitHub repo in the Claude plugin layout plus `agents/*.md`, installed under ~/.marcsh/packs.
 *
 * A pack is third-party content, so nothing of it ever runs: git runs without hooks, submodules, LFS or prompts; the
 * clone is scanned before anything is moved into place (no symlink may leave it); and the Claude/pi plugin loaders are
 * pointed at a generated `plugin/` view that holds COPIES of the regular files under `skills/` and `commands/` that the scan
 * read, and nothing else: no links, no pack hooks, MCP servers or agent files, so what the engines can load is what was scanned
 * and previewed. Installing and updating need the user's consent after a preview; nothing is automatic.
 *
 * A pack's hooks (`hooks/`, see pack-hooks.ts) are the one exception to "nothing runs", and they are off until the user enables them
 * after reading the commands: the lock entry then holds `hooks` (the commit and a digest of the whole pack: its hooks/, skills/ and
 * commands/ files, since a hook may run any of them through ${CLAUDE_PLUGIN_ROOT}). The view then gets a copy of `hooks/` in which the
 * pack's `hooks.json` is replaced by marcsh's (every command runs through the filter that lets a hook block a call but never approve it,
 * the original commands being kept in COMMANDS_FILE), and the consent counts only while the clone and the whole view still match
 * (`inspectPackHooks`; `prepareViewForTurn` checks before every turn). An update that changes the commit turns them off.
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
  /** Present only while the user has enabled the pack's hooks: consent for this commit and these hook files. */
  hooks?: HooksConsent;
};

export type PackSpec = { id: string; url: string; ref?: string };

export type PackPreview = {
  id: string;
  commit: string;
  /** Set on an update: the commit being replaced. */
  previousCommit?: string;
  /** `tools` is what the agent's tools field takes away or leaves (see `describeTools`); absent when it restricts nothing. */
  agents: { name: string; permission: "read-only" | "build"; model?: string; tools?: string }[];
  skills: string[];
  commands: string[];
  /** The pack's `hooks/`, when it has one: off until the user enables it (`/agents hooks <id>`), or unusable and never enabled. */
  hooks?: { usable: true; events: string[] } | { usable: false; reason: string };
  /** Set on an update of a pack whose hooks were enabled: the new commit starts with them off. */
  hooksTurnedOff?: true;
  /** Parts of the pack that marcsh does not use (it never runs MCP servers, or hooks declared anywhere but `hooks/`). */
  ignored: string[];
  /** Parts marcsh does use that deserve a look before consenting. */
  warnings: string[];
};

type Confirm = (preview: PackPreview) => boolean | Promise<boolean>;
type RootOption = { root?: string };

/**
 * What a pack may hold, counted over the checked-out tree without `.git`: entries (files and folders) and bytes of regular files.
 * `maxDownloadBytes` is what a fetch may put on disk, `.git` included, before it is stopped.
 */
export type PackLimits = { maxEntries: number; maxBytes: number; maxDownloadBytes: number };
type LimitsOption = { limits?: Partial<PackLimits> };
type SignalOption = { signal?: AbortSignal };

export const MAX_PACK_ENTRIES = 5000;
export const MAX_PACK_BYTES = 50 * 1024 * 1024;
/** What a fetch may put on disk (the pack git downloads plus the files it checks out) before it is stopped. */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

const FETCH_TIMEOUT_MS = 120_000;
// How often a running git call has the size of its staging directory looked at.
const DOWNLOAD_POLL_MS = 250;
const MAX_PART_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;

/** The agent ID given to a file that is only being checked by `scanPack`: the result is not kept, so it needs no real pack. */
const SCAN_PACK_ID = "pack";

/** A size limit as the messages say it, so the text cannot drift from the constant. */
const formatLimit = (bytes: number) => (bytes % (1024 * 1024) === 0 ? `${bytes / 1024 / 1024} MB` : `${bytes / 1024} KB`);
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

const cancelled = () => new PackError("Cancelled");

/** A lock entry's url and ref are held to the rules an install applies, every time they are read: they end up on git's command line. */
const isSafeEntry = (item: PackEntry) => URL_FORM.test(item.url) && (item.ref === undefined || (typeof item.ref === "string" && isRef(item.ref)));

/** The entry with its `hooks` field kept only when it is exactly the consent shape: anything else reads as hooks off. */
function withValidConsent(item: PackEntry): PackEntry {
  const { hooks, ...rest } = item as PackEntry & { hooks?: unknown };
  const consent = parseHooksConsent(hooks);
  return consent ? { ...rest, hooks: consent } : rest;
}

type LockRead = { entries: PackEntry[]; unsafe?: PackEntry; problem?: string };

/** The lockfile, and why it cannot be used when it cannot. The reason never quotes the file: it is short and safe to show. */
function loadLock(root: string): LockRead {
  let text: string;
  try {
    text = readFileSync(lockPath(root), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? { entries: [] } : { entries: [], problem: `read error ${code ?? ""}`.trim() };
  }
  let parsed: { packs?: unknown } | null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { entries: [], problem: "not valid JSON" };
  }
  if (!parsed || !Array.isArray(parsed.packs)) return { entries: [], problem: "no packs list" };
  const entries = parsed.packs
    .filter(
      (item): item is PackEntry =>
        !!item && isPackId(item.id) && typeof item.url === "string" && typeof item.commit === "string" && typeof item.installedAt === "string",
    )
    .map(withValidConsent);
  const unsafe = entries.find((item) => !isSafeEntry(item));
  return { entries: entries.filter(isSafeEntry), ...(unsafe ? { unsafe } : {}) };
}

function readLock(root: string, strict: boolean): PackEntry[] {
  const { entries, unsafe, problem } = loadLock(root);
  if (!strict) return entries;
  if (problem) throw new PackError(`${lockPath(root)} cannot be read (${problem}); fix or delete it`);
  // Listing skips an entry git must not be handed; a command that would use or rewrite the lockfile stops instead of dropping it.
  if (unsafe) throw new PackError(`${lockPath(root)}: the entry for ${unsafe.id} has a url or ref that is not valid; fix or delete it`);
  return entries;
}

/** Why `packs.json` exists but cannot be read (every pack agent is hidden until it is fixed or deleted), or null. */
export function lockProblem(root = packsRoot()): string | null {
  return loadLock(root).problem ?? null;
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

/** SIGKILL to git and to whatever it started (a fetch runs helper programs): git has its own process group for that. */
function killTree(child: ReturnType<typeof spawn>) {
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** The bytes of the regular files under `dir`, never following a link; stops counting once `limit` is passed. What vanishes while it is counted counts as nothing. */
async function bytesUnder(dir: string, limit: number): Promise<number> {
  let total = 0;
  const walk = async (path: string) => {
    let items;
    try {
      items = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (total > limit) return;
      const child = join(path, item.name);
      if (item.isDirectory()) await walk(child);
      else if (item.isFile()) total += await lstat(child).then((stat) => stat.size, () => 0);
    }
  };
  await walk(dir);
  return total;
}

/** The staging directory of a fetch and what it may grow to while git runs. */
type Watch = { dir: string; maxBytes: number };

const downloadTooBig = (maxBytes: number) => rejected(`the download is larger than marcsh accepts (over ${formatLimit(maxBytes)})`);

function git(cwd: string, args: string[], { url, timeoutMs, signal, watch }: { url: string; timeoutMs: number; watch?: Watch } & SignalOption): Promise<string> {
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
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    // An argv array, never a shell string: nothing in the URL or ref is interpreted.
    const child = spawn("git", [...hardened, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    // Cancelling and timing out do not wait for git to exit: a program it started may hold its pipes open a while.
    const onAbort = () => {
      killTree(child);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      killTree(child);
      fail(new PackError(`git ${args[0]} failed: timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    let settled = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    const settle = () => {
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      signal?.removeEventListener("abort", onAbort);
    };
    const done = (text: string) => (settle(), resolve(text));
    const fail = (error: PackError) => (settle(), reject(error));
    // The download is stopped as it grows past the cap, not after it has all arrived. A look that is still running is not started again.
    let measuring = false;
    const overCap = async () => (watch ? (await bytesUnder(watch.dir, watch.maxBytes)) > watch.maxBytes : false);
    if (watch) {
      poll = setInterval(async () => {
        if (measuring || settled) return;
        measuring = true;
        try {
          if (await overCap()) {
            killTree(child);
            fail(downloadTooBig(watch.maxBytes));
          }
        } finally {
          measuring = false;
        }
      }, DOWNLOAD_POLL_MS);
    }
    // A call that was too quick for the polling is still held to the cap before it counts as done.
    const finish = (text: string) =>
      overCap().then(
        (over) => (over ? fail(downloadTooBig(watch!.maxBytes)) : done(text)),
        () => done(text),
      );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", (error) => fail(new PackError(`git could not run: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) return void finish(out.trim());
      // GitHub answers a missing or private repo by asking for a login, which is off: say what that means.
      if (/could not read Username|Authentication failed|Repository not found/.test(err)) {
        return fail(new PackError(`${printable(url)} was not found, or it is private: marcsh installs public repositories only`));
      }
      // The server's own words reach the toast: cleaned, and only the end of them (git puts the reason last).
      const why = printable(err.trim()).slice(-MAX_GIT_MESSAGE) || `exited with ${code}`;
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

/**
 * Fetches `url` at `ref` (else HEAD) into a fresh staging directory under `root`: one commit, no hooks, no submodules, no LFS.
 * While git runs, the staging directory is kept under `MAX_DOWNLOAD_BYTES`: past it git is stopped and the fetch is rejected.
 */
export async function fetchPack({
  url,
  ref,
  root = packsRoot(),
  timeoutMs = FETCH_TIMEOUT_MS,
  signal,
  limits,
}: { url: string; ref?: string } & RootOption & SignalOption & LimitsOption & { timeoutMs?: number }): Promise<Fetched> {
  if (!URL_FORM.test(url) || (ref !== undefined && !isRef(ref))) throw new PackError("Pack rejected: the repository URL or ref is not valid");
  const stagingRoot = join(root, ".staging");
  mkdirSync(stagingRoot, { recursive: true });
  removeStaleStaging(stagingRoot);
  const staging = mkdtempSync(join(stagingRoot, "pack-"));
  const src = join(staging, "src");
  try {
    mkdirSync(src);
    const run = (...args: string[]) => git(src, args, { url, timeoutMs, signal, watch: { dir: staging, maxBytes: limits?.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES } });
    await run("init", "-q", "--template=");
    // After `--`, so neither can be taken for an option.
    await run("fetch", "-q", "--depth", "1", "--no-tags", "--no-recurse-submodules", "--", url, ref ?? "HEAD");
    await run("checkout", "-q", "--detach", "--no-recurse-submodules", "FETCH_HEAD");
    // A detached HEAD file holds the commit itself.
    const commit = readFileSync(join(src, ".git", "HEAD"), "utf8").trim();
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) throw new PackError(`git did not check out a commit (${commit.slice(0, 40)})`);
    return { staging, src, commit };
  } catch (error) {
    // git may still be dying (it was killed, not waited for) and writing: remove again if something reappears.
    await rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    throw error;
  }
}

// ---- scan and preview ----

async function head(path: string, bytes: number) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** The entries of a folder, or none when it cannot be read: `listDir` (plugin.ts) without blocking. */
async function listDirAsync(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

const rejected = (why: string) => new PackError(`Pack rejected: ${why}`);

/**
 * Every file under `skills/` or `commands/`, as paths relative to the clone. Only real folders and regular files of at most
 * MAX_PART_BYTES are accepted: a link, a device or anything else rejects the pack, so the view can be built from exactly this list.
 */
async function listPart(src: string, part: "skills" | "commands"): Promise<string[]> {
  let top;
  try {
    top = await lstat(join(src, part));
  } catch {
    return [];
  }
  checkPartTop(top, part);
  const files: string[] = [];
  const walk = async (dir: string) => {
    for (const name of (await readdir(join(src, dir))).sort()) {
      const rel = `${dir}/${name}`;
      if (partEntryKind(await lstat(join(src, rel)), rel, part) === "dir") await walk(rel);
      else files.push(rel);
    }
  };
  await walk(part);
  return files;
}

function checkPartTop(top: Stats, part: string) {
  if (!top.isDirectory()) throw rejected(`${part} is ${top.isSymbolicLink() ? "a symlink" : "not a folder"}; only real folders and files are used`);
}

/** A folder to walk into or a regular file of at most MAX_PART_BYTES to keep; anything else rejects the pack. */
function partEntryKind(stat: Stats, rel: string, part: string): "dir" | "file" {
  if (stat.isDirectory()) return "dir";
  if (!stat.isFile()) throw rejected(`${printable(rel)} is ${stat.isSymbolicLink() ? "a symlink" : "not a regular file"}; ${part}/ may hold only regular files`);
  if (stat.size > MAX_PART_BYTES) throw rejected(`${printable(rel)} is larger than ${formatLimit(MAX_PART_BYTES)}`);
  return "file";
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
 *
 * This is a security check, so it is not `readFrontmatter` (agent-file.ts): that one is a lenient reader of flat fields and would
 * let a nested or oddly written key through.
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
async function readParts(src: string): Promise<Parts> {
  const files = [...(await listPart(src, "skills")), ...(await listPart(src, "commands"))];
  const warnings: string[] = [];
  for (const file of files) {
    if (!file.toLowerCase().endsWith(".md")) continue;
    let found;
    try {
      found = declaredKeys(await readFile(join(src, file), "utf8"));
    } catch (error) {
      throw rejected(`the frontmatter of ${printable(file)} cannot be read unambiguously (${(error as Error).message})`);
    }
    if (found.hooks) throw rejected(`${printable(file)} declares hooks, which marcsh never runs from a skill or command; declare them in hooks/hooks.json, where they stay off until you enable them with /agents hooks`);
    if (found.allowedTools) warnings.push(`${file} pre-approves tools (allowed-tools)`);
  }
  // A skill is a folder with a SKILL.md (any case), or a .md directly in skills/ (pi loads those too); a command is any .md
  // under commands/, named by its path.
  const folderSkills = files
    .filter((file) => file.startsWith("skills/") && basename(file).toLowerCase() === "skill.md")
    .map((file) => relative("skills", dirname(file)) || ".");
  const rootSkills = files
    .filter((file) => dirname(file) === "skills" && file.toLowerCase().endsWith(".md") && basename(file).toLowerCase() !== "skill.md")
    .map((file) => basename(file).slice(0, -3));
  const commands = files.filter((file) => file.startsWith("commands/") && file.toLowerCase().endsWith(".md")).map((file) => relative("commands", file).slice(0, -3));
  return { files, skills: [...folderSkills, ...rootSkills].sort(), commands: commands.sort(), warnings };
}

// Like the loader, a pack's `agents` folder is not read through a link.
const agentsIsLink = async (src: string) => {
  try {
    return (await lstat(join(src, "agents"))).isSymbolicLink();
  } catch {
    return false;
  }
};

async function agentFiles(src: string) {
  if (await agentsIsLink(src)) return [];
  return (await listDirAsync(join(src, "agents")))
    .filter((item) => item.isFile() && item.name.endsWith(".md"))
    .map((item) => item.name)
    .sort();
}

type Tally = { entries: number; bytes: number };
type ScanLimits = Pick<PackLimits, "maxEntries" | "maxBytes">;

/** Walks the clone without reading a file. Counts what it passes (not `.git`) and stops, with what it has counted so far, once a limit is crossed. */
async function walkForLinks(clone: string, dir: string, cloneReal: string, bad: string[], limits: ScanLimits, tally: Tally) {
  for (const item of await listDirAsync(dir)) {
    if (dir === clone && item.name === ".git") continue;
    const path = join(dir, item.name);
    tally.entries++;
    if (item.isFile()) tally.bytes += (await lstat(path)).size;
    if (tally.entries > limits.maxEntries || tally.bytes > limits.maxBytes) {
      throw rejected(`the repository is larger than marcsh accepts (${tally.entries} files / ${(tally.bytes / 1024 / 1024).toFixed(1)} MB)`);
    }
    if (item.isDirectory()) await walkForLinks(clone, path, cloneReal, bad, limits, tally);
    else if (item.isSymbolicLink()) {
      let target: string;
      try {
        target = await realpath(path);
      } catch {
        // A dangling link: judge where it points.
        target = resolve(await realpath(dir), await readlink(path));
      }
      if (target !== cloneReal && !target.startsWith(cloneReal + sep)) bad.push(path.slice(clone.length + 1));
    }
  }
}

/**
 * Throws unless the clone is safe to keep: it is within the size limits (counted before any file is read), no symlink leaves it, `agents/`, `skills/` and `commands/` hold no links, it has a primary
 * agent, no agent file is huge, no skill or command declares hooks. Returns what the view is built from.
 */
export async function scanPack(src: string, limits: Partial<ScanLimits> = {}): Promise<Parts> {
  const outside: string[] = [];
  const cap: ScanLimits = { maxEntries: MAX_PACK_ENTRIES, maxBytes: MAX_PACK_BYTES, ...limits };
  await walkForLinks(src, src, await realpath(src), outside, cap, { entries: 0, bytes: 0 });
  if (outside.length > 0) {
    throw new PackError(`Pack rejected: ${printable(outside[0]!)} is a symlink that points outside the pack${outside.length > 1 ? ` (and ${outside.length - 1} more)` : ""}`);
  }

  if (await agentsIsLink(src)) throw rejected("agents is a symlink, so its files would not be read");
  let primary = 0;
  for (const file of await agentFiles(src)) {
    const path = join(src, "agents", file);
    if ((await lstat(path)).size > MAX_AGENT_BYTES) throw new PackError(`Pack rejected: agents/${printable(file)} is larger than ${formatLimit(MAX_AGENT_BYTES)}`);
    const agent = parseAgentFile(await readFile(path, "utf8"), { pack: SCAN_PACK_ID, file });
    // The loader keeps such a file as a Build agent whose prompt starts with the frontmatter; a pack fails closed instead.
    if (agent?.ignored.includes("frontmatter")) throw rejected(`agents/${printable(file)} has a frontmatter that is never closed`);
    if (agent) primary++;
  }
  if (primary === 0) throw new PackError("Pack rejected: it has no primary agent in agents/*.md");

  return readParts(src);
}

async function pluginManifestKeys(src: string): Promise<Set<string>> {
  try {
    const manifest = JSON.parse(await head(join(src, ".claude-plugin", "plugin.json"), MAX_MANIFEST_BYTES));
    return new Set(manifest && typeof manifest === "object" ? Object.keys(manifest) : []);
  } catch {
    return new Set();
  }
}

/** What the pack holds and what marcsh will not use of it, read without running or following anything. `parts` is what `scanPack` read. */
export async function previewPack(src: string, { id, commit }: { id: string; commit: string }, parts?: Parts): Promise<PackPreview> {
  parts ??= await readParts(src);
  const agents: PackPreview["agents"] = [];
  const subagents: string[] = [];
  for (const file of await agentFiles(src)) {
    let agent;
    try {
      agent = parseAgentFile(await readFile(join(src, "agents", file), "utf8"), { pack: id, file });
    } catch {
      continue;
    }
    if (!agent) subagents.push(file);
    else {
      const tools = describeTools(agent.tools);
      agents.push({ name: agent.name, permission: agent.mode === Mode.PLAN ? "read-only" : "build", ...(agent.model ? { model: agent.model } : {}), ...(tools ? { tools } : {}) });
    }
  }

  const manifest = await pluginManifestKeys(src);
  const hooks = await readHooksDir(join(src, HOOKS_DIR));
  const ignored = [
    ...((await listDirAsync(src)).some((item) => item.name === ".mcp.json") ? [".mcp.json"] : []),
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
    ...(hooks.present ? { hooks: hooks.usable ? { usable: true as const, events: clean(hookEvents(hooks.config)) } : { usable: false as const, reason: printable(hooks.reason) } } : {}),
    ignored: clean(ignored),
    warnings: clean(parts.warnings),
  };
}

// ---- install, update, remove ----

/**
 * Writes `<staging>/plugin`: a manifest and copies of the files `scanPack` read under skills/ and commands/, nothing else. Copies, not
 * links: what the engines can load is then exactly what was scanned and previewed, even if the clone is changed afterwards.
 */
async function writePluginView(staging: string, id: string, { files }: Parts) {
  const view = join(staging, "plugin");
  await mkdir(join(view, ".claude-plugin"), { recursive: true });
  const name = id.replace(/\//g, "-").replace(/[^A-Za-z0-9-]+/g, "-");
  await writeFile(join(view, ".claude-plugin", "plugin.json"), `${JSON.stringify({ name, description: `Skills and commands of the marcsh pack ${id}` }, null, 2)}\n`);
  for (const file of files) {
    const from = join(staging, "src", file);
    if (!(await lstat(from)).isFile()) throw rejected(`${printable(file)} changed while the pack was being installed`);
    await mkdir(dirname(join(view, file)), { recursive: true });
    await copyFile(from, join(view, file));
  }
}

const discard = (path: string) => rm(path, { recursive: true, force: true });

export type InstallResult = { status: "installed"; pack: PackEntry; preview: PackPreview } | { status: "cancelled" };

/**
 * Fetches the pack, scans and previews it, and installs it only if `confirm` says yes. Aborting `signal` while git runs stops git and
 * rejects with `Cancelled`; once the fetch is done the answer to `confirm` decides.
 */
export async function installPack(
  text: string,
  { confirm, root = packsRoot(), urlBase, signal, limits }: { confirm: Confirm; urlBase?: string } & RootOption & SignalOption & LimitsOption,
): Promise<InstallResult> {
  const spec = parsePackSpec(text, { urlBase });
  const existing = readLock(root, true);
  if (existing.some((pack) => pack.id === spec.id)) throw new PackError(`${spec.id} is already installed; use update to move it to a newer commit`);
  const target = packDir(spec.id, root);
  if (existsSync(target)) throw new PackError(`${target} exists but is not an installed pack; run /agents remove ${spec.id} to clear it`);

  const { staging, src, commit } = await fetchPack({ url: spec.url, ref: spec.ref, root, signal, limits });
  try {
    const parts = await scanPack(src, limits);
    const preview = await previewPack(src, { id: spec.id, commit }, parts);
    // The view is copied from what was just read, before the user is asked.
    await writePluginView(staging, spec.id, parts);
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
      await discard(target);
      throw error;
    }
    return { status: "installed", pack, preview };
  } finally {
    await discard(staging);
  }
}

export type UpdateResult =
  | { status: "updated"; pack: PackEntry; preview: PackPreview }
  | { status: "up-to-date"; pack: PackEntry }
  | { status: "cancelled" };

/**
 * Fetches the commit the pack's ref (else HEAD) points at now; if it differs, previews old → new and swaps it in on consent.
 * Aborting `signal` while git runs rejects with `Cancelled` and leaves the installed pack as it was.
 */
export async function updatePack(
  id: string,
  { confirm, root = packsRoot(), signal, limits }: { confirm: Confirm } & RootOption & SignalOption & LimitsOption,
): Promise<UpdateResult> {
  assertPackId(id);
  const current = readLock(root, true).find((pack) => pack.id === id);
  if (!current) throw new PackError(`${id} is not installed`);

  const { staging, src, commit } = await fetchPack({ url: current.url, ref: current.ref, root, signal, limits });
  const retired = join(root, ".staging", `old-${basename(staging)}`);
  try {
    if (commit === current.commit) return { status: "up-to-date", pack: current };
    const parts = await scanPack(src, limits);
    const preview = {
      ...(await previewPack(src, { id, commit }, parts)),
      previousCommit: current.commit,
      ...(current.hooks ? { hooksTurnedOff: true as const } : {}),
    };
    await writePluginView(staging, id, parts);
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
    // A new commit never inherits consent: the hooks are off until the user reviews them again. (The view above has no hooks/ either.)
    const { hooks: _consent, ...kept } = current;
    const pack: PackEntry = { ...kept, commit, installedAt: new Date().toISOString() };
    try {
      changeLock(root, (latest) => {
        if (!latest.some((item) => item.id === id)) throw new PackError(`${id} was removed while it was being updated`);
        return latest.map((item) => (item.id === id ? pack : item));
      });
    } catch (error) {
      await discard(target);
      if (hadOld) renameSync(retired, target);
      throw error;
    }
    return { status: "updated", pack, preview };
  } finally {
    await discard(staging);
    await discard(retired);
  }
}

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export type RemoveResult = { status: "removed" } | { status: "removed-leftover" };

/** Whether `<root>/<owner>/<repo>` exists without a lock entry: a crash between the rename and the lock write leaves one. */
export function hasLeftover(id: string, { root = packsRoot() }: RootOption = {}): boolean {
  assertPackId(id);
  // On a case-insensitive disk another spelling of an installed id names the installed folder, which is not a leftover.
  if (listPacks({ root }).some((pack) => sameId(pack.id, id))) return false;
  try {
    lstatSync(packDir(id, root));
    return true;
  } catch {
    return false;
  }
}

/**
 * Deletes the pack's directory and its lock entry. A folder with no lock entry (see `hasLeftover`) is deleted too and reported as
 * `removed-leftover`: only that exact path under the root, and never through a link.
 */
export async function removePack(id: string, { root = packsRoot() }: RootOption = {}): Promise<RemoveResult> {
  assertPackId(id);
  const target = packDir(id, root);
  const packs = readLock(root, true);
  const installed = packs.some((pack) => pack.id === id);
  const spelled = packs.find((pack) => sameId(pack.id, id));
  if (!installed && spelled) throw new PackError(`${id} is not installed; did you mean ${spelled.id}?`);
  if (!installed) {
    if (!hasLeftover(id, { root })) throw new PackError(`${id} is not installed`);
    if (lstatSync(dirname(target)).isSymbolicLink()) throw new PackError(`${dirname(target)} is a link; remove ${target} by hand`);
  } else {
    changeLock(root, (packs) => {
      if (!packs.some((pack) => pack.id === id)) throw new PackError(`${id} is not installed`);
      return packs.filter((pack) => pack.id !== id);
    });
  }
  await discard(target);
  try {
    // The owner's folder goes with its last pack; rmdir refuses a folder that still holds one.
    rmdirSync(dirname(target));
  } catch {}
  return { status: installed ? "removed" : "removed-leftover" };
}

// ---- hooks: consent, the view's copy, and the check before every turn ----

export type PackHooksInfo =
  | { state: "none" }
  /** `hooks/` exists but is not the supported shape (see pack-hooks.ts): never enabled. */
  | { state: "unusable"; reason: string }
  /** Usable and not enabled. `changed` means the lockfile holds consent that no longer matches the commit or the files. */
  | { state: "off"; commit: string; config: HooksConfig; files: HookFile[]; digest: string; changed?: true }
  | { state: "on"; commit: string; config: HooksConfig; files: HookFile[]; digest: string; enabledAt: string };

const sameConsent = (entry: PackEntry, digest: string) => entry.hooks !== undefined && entry.hooks.commit === entry.commit && entry.hooks.digest === digest;

type PackFile = { path: string; data: Buffer };
type UsableHooks = Extract<HooksRead, { usable: true }>;

/** The files of `skills/` and `commands/` under `base` (the clone or the view), read whole. Throws `PackError` like `listPart`. */
async function partFiles(base: string): Promise<PackFile[]> {
  const files: PackFile[] = [];
  for (const path of [...(await listPart(base, "skills")), ...(await listPart(base, "commands"))]) files.push({ path, data: await readFile(join(base, path)) });
  return files;
}

const hookPath = (file: PackFile): PackFile => ({ path: `${HOOKS_DIR}/${file.path}`, data: file.data });

/** What the consent digest covers: every file a hook can reach through ${CLAUDE_PLUGIN_ROOT}, the hooks/ ones included. */
const consentDigest = (parts: readonly PackFile[], hooks: readonly HookFile[]) => digestFiles([...parts, ...hooks.map(hookPath)]);

/** The filter every command of the view's hooks.json runs through (marcsh's own plugin), or null when marcsh's plugin cannot be found. */
function filterPath(): string | null {
  const plugin = marcshPluginPath();
  return plugin ? join(plugin, HOOKS_DIR, "pack-hook-filter.ts") : null;
}

/** The files of the view's `hooks/` for these hooks: the pack's own, except its hooks.json, then marcsh's hooks.json and commands file. */
function viewHookFiles(read: UsableHooks, filter: string): HookFile[] {
  const { hooksJson, commandsJson } = claudeHookFiles(read.config, filter);
  const generated = (path: string, text: string): HookFile => {
    const data = Buffer.from(text);
    return { path, size: data.length, mode: 0o644, data };
  };
  return [...read.files.filter((file) => file.path !== HOOKS_FILE), generated(HOOKS_FILE, hooksJson), generated(COMMANDS_FILE, commandsJson)];
}

/** Whether the view holds exactly the clone's skills and commands (`parts`) and exactly these hook files: nothing more, less or different. */
async function viewMatches(view: string, parts: readonly PackFile[], expected: readonly HookFile[]): Promise<boolean> {
  try {
    const hooks = await readHookFiles(join(view, HOOKS_DIR));
    return hooks.ok && consentDigest(await partFiles(view), hooks.files) === consentDigest(parts, expected);
  } catch {
    return false;
  }
}

const unreadableParts = (error: unknown): PackHooksInfo => ({ state: "unusable", reason: printable(error instanceof Error ? error.message : "the pack cannot be read") });

type HooksShared = { commit: string; config: HooksConfig; files: HookFile[]; digest: string };

/** The marcsh filter's path when the lockfile's consent covers exactly this digest (so the view is worth comparing), else null. */
function consentFilter(entry: PackEntry, digest: string): string | null {
  return entry.hooks && sameConsent(entry, digest) ? filterPath() : null;
}

/** `on` only while the view also holds exactly what enabling made of the hooks (`intact`); consent that no longer holds reads as `off` + `changed`. */
function hooksState(entry: PackEntry, shared: HooksShared, intact: boolean): PackHooksInfo {
  if (intact && entry.hooks) return { state: "on", ...shared, enabledAt: entry.hooks.enabledAt };
  return { state: "off", ...shared, ...(entry.hooks ? { changed: true as const } : {}) };
}

const hooksShared = (entry: PackEntry, read: UsableHooks, parts: readonly PackFile[]): HooksShared => ({
  commit: entry.commit,
  config: read.config,
  files: read.files,
  digest: consentDigest(parts, read.files),
});

/**
 * What the installed clone's `hooks/` holds now, and whether the lockfile's consent covers exactly that: the commit, and the digest of the
 * whole pack. Consent counts as `on` only while the view also holds exactly what enabling made of it. Nothing is run.
 */
export async function inspectPackHooks(id: string, { root = packsRoot() }: RootOption = {}): Promise<PackHooksInfo> {
  assertPackId(id);
  const entry = listPacks({ root }).find((pack) => pack.id === id);
  if (!entry) return { state: "none" };
  const src = join(packDir(id, root), "src");
  const read = await readHooksDir(join(src, HOOKS_DIR));
  if (!read.present) return { state: "none" };
  if (!read.usable) return { state: "unusable", reason: read.reason };
  let parts: PackFile[];
  try {
    parts = await partFiles(src);
  } catch (error) {
    return unreadableParts(error);
  }
  const shared = hooksShared(entry, read, parts);
  const filter = consentFilter(entry, shared.digest);
  return hooksState(entry, shared, filter !== null && (await viewMatches(packPluginDir(id, root), parts, viewHookFiles(read, filter))));
}

/** Packs whose hooks have a consent in the lockfile: `on` when it still covers the pack and its view, `changed` when the hooks are off because it no longer does. */
export async function packHooksStates({ root = packsRoot() }: RootOption = {}): Promise<Map<string, "on" | "changed">> {
  const states = new Map<string, "on" | "changed">();
  for (const pack of listPacks({ root })) {
    if (pack.hooks) states.set(pack.id, (await inspectPackHooks(pack.id, { root })).state === "on" ? "on" : "changed");
  }
  return states;
}

/** The IDs of the packs whose hooks are enabled and still match what was approved. */
export async function packsWithHooksOn({ root = packsRoot() }: RootOption = {}): Promise<Set<string>> {
  return new Set([...(await packHooksStates({ root }))].filter(([, state]) => state === "on").map(([id]) => id));
}

const viewHooksPath = (view: string) => join(view, HOOKS_DIR);

const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** Removes a folder (or a link, without following it); true when nothing is left at the path. */
function removeAll(path: string): boolean {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {}
  return !exists(path);
}

/** Writes the view's `hooks/` from the bytes that were reviewed (not from the disk again), next to the folder first and then renamed in. */
function writeViewHooks(view: string, files: readonly HookFile[]) {
  let top;
  try {
    top = lstatSync(view);
  } catch {
    throw new PackError(`The generated view of this pack is missing (${view}); remove the pack and install it again`);
  }
  if (!top.isDirectory()) throw new PackError(`${view} is not a folder; remove the pack and install it again`);
  const target = viewHooksPath(view);
  const temp = join(view, `.hooks-${process.pid}`);
  // A crash leaves its folder behind under its own pid: clear every one, links removed without being followed.
  for (const name of readdirSync(view)) if (name.startsWith(".hooks-")) removeAll(join(view, name));
  try {
    for (const file of files) {
      const dest = join(temp, ...file.path.split("/"));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, file.data);
      // The executable bits as the pack has them; never group/other write, never setuid.
      chmodSync(dest, file.mode & 0o755);
    }
    if (!removeAll(target)) throw new PackError(`${target} could not be replaced`);
    renameSync(temp, target);
  } catch (error) {
    removeAll(temp);
    throw error;
  }
}

export type EnableHooksResult = { status: "enabled"; commit: string; digest: string };

/**
 * Enables a pack's hooks for the files the user reviewed: `reviewed` is the commit and digest that were shown. The clone is read again
 * and must still be exactly that, so a change between the review and the answer enables nothing. The view's copy is written from the
 * bytes just read and checked against the digest before the lockfile says the hooks are on.
 */
export async function enablePackHooks(id: string, { root = packsRoot(), reviewed }: RootOption & { reviewed: { commit: string; digest: string } }): Promise<EnableHooksResult> {
  assertPackId(id);
  const entry = readLock(root, true).find((pack) => pack.id === id);
  if (!entry) throw new PackError(`${id} is not installed`);
  const read = await readHooksDir(join(packDir(id, root), "src", HOOKS_DIR));
  if (!read.present) throw new PackError(`${id} has no hooks`);
  if (!read.usable) throw new PackError(`The hooks of ${id} cannot be enabled: ${read.reason}`);
  const parts = await partFiles(join(packDir(id, root), "src"));
  const digest = consentDigest(parts, read.files);
  if (reviewed.commit !== entry.commit || reviewed.digest !== digest) {
    throw new PackError(`The hooks of ${id} changed since you reviewed them; open /agents hooks ${id} again`);
  }

  const filter = filterPath();
  if (!filter) throw new PackError("marcsh's own plugin folder was not found, so pack hooks cannot be set up");
  const view = packPluginDir(id, root);
  const files = viewHookFiles(read, filter);
  writeViewHooks(view, files);
  // The review covered the whole pack: the view's skills and commands must be the clone's, and its hooks exactly what was just written.
  if (!(await viewMatches(view, parts, files))) {
    removeAll(viewHooksPath(view));
    throw new PackError(`The view of ${id} does not match the pack's files, so nothing was enabled; remove the pack and install it again`);
  }
  try {
    changeLock(root, (packs) => {
      const latest = packs.find((pack) => pack.id === id);
      if (!latest || latest.commit !== entry.commit) throw new PackError(`${id} changed while its hooks were being enabled`);
      const consent: HooksConsent = { commit: entry.commit, digest, enabledAt: new Date().toISOString() };
      return packs.map((pack) => (pack.id === id ? { ...pack, hooks: consent } : pack));
    });
  } catch (error) {
    removeAll(viewHooksPath(view));
    throw error;
  }
  return { status: "enabled", commit: entry.commit, digest };
}

export type DisableHooksResult = { status: "disabled" | "already-off" };

/** Turns a pack's hooks off without asking: the lockfile first (so they are off even if the rest fails), then the view's copy. */
export async function disablePackHooks(id: string, { root = packsRoot() }: RootOption = {}): Promise<DisableHooksResult> {
  assertPackId(id);
  let wasOn = false;
  changeLock(root, (packs) => {
    const entry = packs.find((pack) => pack.id === id);
    if (!entry) throw new PackError(`${id} is not installed`);
    wasOn = entry.hooks !== undefined;
    return packs.map((pack) => {
      const { hooks: _consent, ...rest } = pack;
      return pack.id === id ? rest : pack;
    });
  });
  const view = viewHooksPath(packPluginDir(id, root));
  const hadCopy = exists(view);
  if (!removeAll(view)) throw new PackError(`${id}: hooks are off, but their copy in ${view} could not be removed; it will not be loaded`);
  return { status: wasOn || hadCopy ? "disabled" : "already-off" };
}

/** Where a path is a generated view `<root>/<owner>/<repo>/plugin`: the packs root and the pack ID, else null. */
export function packViewLocation(viewPath: string): { root: string; id: string } | null {
  const parts = resolve(viewPath).split(sep);
  const [view, repo, owner] = [parts.at(-1), parts.at(-2), parts.at(-3)];
  if (view !== "plugin" || !repo || !owner) return null;
  const id = `${owner}/${repo}`;
  return isPackId(id) ? { root: parts.slice(0, -3).join(sep) || sep, id } : null;
}

export type TurnView = {
  /** The plugin view to load this turn, or null when it must not be loaded at all (hooks could not be kept out of it). */
  view: string | null;
  /** The hooks to run this turn: enabled, and the clone's and the view's files both still match the digest that was approved. */
  hooks?: { id: string; root: string; config: HooksConfig };
  /** Something the user should know: hooks that were on or present are not running this turn. */
  warning?: string;
};

/**
 * The check before a pack agent's turn. The view keeps `hooks/` only while the lockfile's consent covers exactly these files (same
 * commit; same digest in the clone and in the view). Anything else is removed from the view before an engine can load it, with a
 * warning when it was approved or present; a view that cannot be cleaned, or that is not known to be marcsh's, is not loaded.
 * Nothing is deleted from a path that is not an entry of the lockfile.
 */
export async function prepareViewForTurn(viewPath: string): Promise<TurnView> {
  const hooksPath = viewHooksPath(viewPath);
  const present = exists(hooksPath);
  const location = packViewLocation(viewPath);
  const entry = location ? listPacks({ root: location.root }).find((pack) => pack.id === location.id) : undefined;
  if (!location || !entry) {
    if (!present) return { view: viewPath };
    return { view: null, warning: `Pack hooks cannot be checked for ${printable(viewPath)}, so that pack's skills and commands were not loaded` };
  }

  const { root, id } = location;
  // `on` means the lockfile's consent covers the clone's pack files (hooks, skills, commands) and the view holds exactly what enabling made of them.
  const info = await inspectPackHooks(id, { root });
  if (info.state === "on") return { view: viewPath, hooks: { id, root, config: info.config } };

  if (!present && !entry.hooks) return { view: viewPath };
  if (present && !removeAll(hooksPath)) {
    return { view: null, warning: `${id}: its hook files could not be removed from the pack view, so the pack's skills and commands were not loaded` };
  }
  const warning = entry.hooks
    ? `${id}: hooks are off for this turn because their files no longer match what you approved. Review them with /agents hooks ${id}`
    : `${id}: hook files in the pack view that were never enabled were removed`;
  return { view: viewPath, warning };
}
