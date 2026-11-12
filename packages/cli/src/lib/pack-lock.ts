import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseHooksConsent, type HooksConsent } from "./pack-hooks";

// Shared by packs.ts (fetch, install, update, remove) and pack-view.ts (hook consent and the generated view): the pack ID and URL rules,
// where a pack lives on disk, and the lockfile. Neither of them is imported here.

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

export type RootOption = { root?: string };

export const rejected = (why: string) => new PackError(`Pack rejected: ${why}`);

/** A size limit as the messages say it, so the text cannot drift from the constant. */
export const formatLimit = (bytes: number) => (bytes % (1024 * 1024) === 0 ? `${bytes / 1024 / 1024} MB` : `${bytes / 1024} KB`);
export const FORMS = "Use owner/repo, owner/repo@ref or https://github.com/owner/repo";

export function packsRoot() {
  return process.env.MARCSH_PACKS_DIR?.trim() || join(homedir(), ".marcsh", "packs");
}

const OWNER = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const REPO = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
const REF = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
// What git is given as the repository: https (GitHub) or file (tests), and nothing that could be read as an option.
export const URL_FORM = /^(?:https|file):\/\/[^\s\u0000-\u001f\u007f]+$/;

export const isRef = (ref: string) => REF.test(ref) && !ref.includes("..") && !ref.endsWith("/") && !ref.endsWith(".lock");

export function isName(owner: string, repo: string) {
  return OWNER.test(owner) && REPO.test(repo) && !repo.includes("..") && repo !== ".";
}

export const isPackId = (id: unknown): id is string => {
  if (typeof id !== "string") return false;
  const [owner, repo, ...rest] = id.split("/");
  return rest.length === 0 && owner !== undefined && repo !== undefined && isName(owner, repo);
};

export function assertPackId(id: string) {
  if (!isPackId(id)) throw new PackError(`"${id}" is not a pack ID. ${FORMS}`);
}

export const packDir = (id: string, root: string) => join(root, ...id.split("/"));

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

export function readLock(root: string, strict: boolean): PackEntry[] {
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
export function changeLock(root: string, change: (packs: PackEntry[]) => PackEntry[]) {
  writeLock(root, change(readLock(root, true)));
}

/** The installed packs, in the order they were installed. An unreadable lockfile lists none. */
export function listPacks({ root = packsRoot() }: RootOption = {}): PackEntry[] {
  return readLock(root, false);
}
