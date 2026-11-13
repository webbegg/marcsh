import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, rmdirSync, utimesSync } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { MAX_AGENT_BYTES, parseAgentFile } from "./agent-file";
import { describeTools } from "./agent-tools";
import { HOOKS_DIR, hookEvents, readHooksDir } from "./pack-hooks";
import {
  FORMS,
  PackError,
  URL_FORM,
  assertPackId,
  changeLock,
  formatLimit,
  isName,
  isRef,
  listPacks,
  packDir,
  packsRoot,
  readLock,
  rejected,
  type PackEntry,
  type RootOption,
} from "./pack-lock";
import { listPart } from "./pack-view";
import { Mode } from "./modes";
import { listDir } from "./plugin";
import { printable } from "./safe-text";

// Everything below that moved to pack-lock.ts (IDs, paths, lockfile) and pack-view.ts (hook consent, the view) is still exported from here.
export { PackError, listPacks, lockProblem, packAgentsDir, packPluginDir, packsRoot, type PackEntry } from "./pack-lock";
export {
  disablePackHooks,
  enablePackHooks,
  inspectPackHooks,
  packHooksStates,
  packsWithHooksOn,
  packViewLocation,
  prepareViewForTurn,
  type DisableHooksResult,
  type EnableHooksResult,
  type PackHooksInfo,
  type TurnView,
} from "./pack-view";

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
const MAX_MANIFEST_BYTES = 256 * 1024;

/** The agent ID given to a file that is only being checked by `scanPack`: the result is not kept, so it needs no real pack. */
const SCAN_PACK_ID = "pack";

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

const cancelled = () => new PackError("Cancelled");

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
