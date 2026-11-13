import { chmodSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  COMMANDS_FILE,
  HOOKS_DIR,
  HOOKS_FILE,
  claudeHookFiles,
  digestFiles,
  readHookFiles,
  readHooksDir,
  type HookFile,
  type HooksConfig,
  type HooksConsent,
  type HooksRead,
} from "./pack-hooks";
import {
  PackError,
  assertPackId,
  changeLock,
  formatLimit,
  isPackId,
  listPacks,
  packDir,
  packPluginDir,
  packsRoot,
  readLock,
  rejected,
  type PackEntry,
  type RootOption,
} from "./pack-lock";
import { marcshPluginPath } from "./plugin";
import { printable } from "./safe-text";

// The generated plugin view of a pack and the hook consent that decides what it holds. Imports pack-lock.ts, never packs.ts.

const MAX_PART_BYTES = 1024 * 1024;

/**
 * Every file under `skills/` or `commands/`, as paths relative to the clone. Only real folders and regular files of at most
 * MAX_PART_BYTES are accepted: a link, a device or anything else rejects the pack, so the view can be built from exactly this list.
 */
export async function listPart(src: string, part: "skills" | "commands"): Promise<string[]> {
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
