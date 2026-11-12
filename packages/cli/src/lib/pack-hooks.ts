import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { hidesText, printable } from "./safe-text";

// Pack hooks: the commands a pack asks to run, read from its `hooks/` without running anything. Anything but the supported shape makes
// them unusable, and Claude gets a generated hooks.json whose commands go through marcsh's filter (`claudeHookFiles`), never the pack's own.

export const HOOKS_DIR = "hooks";
export const HOOKS_FILE = "hooks.json";
export const MAX_HOOK_FILE_BYTES = 1024 * 1024;
export const MAX_HOOKS_BYTES = 5 * 1024 * 1024;
const MAX_HOOK_ENTRIES = 500;
const MAX_HOOK_COMMANDS = 100;
const MAX_HOOK_EVENTS = 30;
const MAX_COMMAND_CHARS = 2000;
const MAX_MATCHER_CHARS = 200;
/** Claude's own default is 60 s; a hook may ask for more, up to ten minutes. */
export const MAX_HOOK_TIMEOUT_SECONDS = 600;

/** The events marcsh runs itself on pi (tool calls); every other event runs only where Claude runs it. */
export const PI_HOOK_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure"] as const;

/** The marcsh-owned file of the view's `hooks/` that holds the pack's original commands; a pack file may not use the name. */
export const COMMANDS_FILE = ".marcsh-commands.json";

export type HookCommand = { command: string; timeout?: number };
export type HookGroup = { matcher?: string; hooks: HookCommand[] };
/** Event name → the groups registered for it, in the order of the file. */
export type HooksConfig = Record<string, HookGroup[]>;

export type HookFile = { path: string; size: number; mode: number; data: Buffer };

export type HooksRead =
  /** There is no `hooks/` folder. */
  | { present: false }
  | { present: true; usable: false; reason: string }
  | { present: true; usable: true; config: HooksConfig; files: HookFile[]; digest: string };

/** What the lockfile holds when the user enabled a pack's hooks: consent for exactly this commit and these files. */
export type HooksConsent = { commit: string; digest: string; enabledAt: string };

const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DIGEST = /^[0-9a-f]{64}$/;

/** The lock's `hooks` field, or undefined when it is not exactly that shape: a field that cannot be trusted is no consent. */
export function parseHooksConsent(value: unknown): HooksConsent | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { commit, digest, enabledAt } = value as Record<string, unknown>;
  if (typeof commit !== "string" || !COMMIT.test(commit)) return undefined;
  if (typeof digest !== "string" || !DIGEST.test(digest)) return undefined;
  if (typeof enabledAt !== "string" || enabledAt.length === 0 || enabledAt.length > 64) return undefined;
  return { commit, digest, enabledAt };
}

/** Which of these events marcsh runs on pi too, and which only Claude runs. */
export function hookEngines(events: readonly string[]): { both: string[]; claudeOnly: string[] } {
  const onPi = (event: string) => (PI_HOOK_EVENTS as readonly string[]).includes(event);
  return {
    both: PI_HOOK_EVENTS.filter((event) => events.includes(event)),
    claudeOnly: events.filter((event) => !onPi(event)),
  };
}

// One name of a matcher: tool-name characters and at most one `*` (so `.*` too), which stands for any run of characters.
const MATCHER_NAME = /^[A-Za-z0-9_.-]*(?:\*[A-Za-z0-9_.-]*)?$/;

/**
 * Why a matcher is not accepted, or undefined. Claude reads a matcher as a regular expression, which a pack could make catastrophically
 * slow, so only `*`, nothing, or tool names separated by `|` are accepted, each with at most one wildcard (`*` or `.*`).
 */
export function matcherProblem(matcher: string): string | undefined {
  if (matcher === "" || matcher === "*") return undefined;
  if (matcher.split("|").every((name) => name !== "" && MATCHER_NAME.test(name))) return undefined;
  return `matcher "${printable(matcher).slice(0, 60)}" is not supported: use * or tool names separated by |, written with letters, digits, _ . - and at most one * (or .*) wildcard in each`;
}

/**
 * Whether a matcher accepts a tool: empty or `*` matches every tool, otherwise any of the `|`-separated names, case-sensitively; a name with a
 * `*` matches any tool that starts and ends as it does around the wildcard. Throws on a matcher that `matcherProblem` refuses.
 */
export function compileMatcher(matcher: string | undefined): (toolName: string) => boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return () => true;
  const problem = matcherProblem(matcher);
  if (problem) throw new Error(problem);
  const tests = matcher.split("|").map((name): ((toolName: string) => boolean) => {
    const star = name.indexOf("*");
    if (star < 0) return (toolName) => toolName === name;
    const before = name.slice(0, star);
    const prefix = before.endsWith(".") ? before.slice(0, -1) : before;
    const suffix = name.slice(star + 1);
    return (toolName) => toolName.length >= prefix.length + suffix.length && toolName.startsWith(prefix) && toolName.endsWith(suffix);
  });
  return (toolName) => tests.some((test) => test(toolName));
}

class Unusable extends Error {}
const unusable = (why: string) => new Unusable(why);

const formatMegabytes = (bytes: number) => `${bytes / 1024 / 1024} MB`;

/** Validates `hooks.json`: Claude's plugin format with command hooks only, nothing that is not understood. */
function parseHooksJson(text: string): HooksConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw unusable("hooks.json is not valid JSON");
  }
  const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isObject(parsed)) throw unusable("hooks.json is not an object");
  for (const key of Object.keys(parsed)) {
    if (key !== "hooks" && key !== "description") throw unusable(`hooks.json has an unexpected key "${printable(key).slice(0, 40)}"`);
  }
  if (parsed.description !== undefined && typeof parsed.description !== "string") throw unusable("hooks.json: description is not text");
  if (!isObject(parsed.hooks)) throw unusable('hooks.json has no "hooks" object');

  const config: HooksConfig = {};
  let commands = 0;
  const events = Object.entries(parsed.hooks);
  if (events.length > MAX_HOOK_EVENTS) throw unusable(`hooks.json declares more than ${MAX_HOOK_EVENTS} events`);
  for (const [event, groups] of events) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(event)) throw unusable(`"${printable(event).slice(0, 40)}" is not an event name`);
    if (!Array.isArray(groups)) throw unusable(`${event} is not a list`);
    const kept: HookGroup[] = [];
    for (const group of groups) {
      if (!isObject(group)) throw unusable(`${event} has an entry that is not an object`);
      for (const key of Object.keys(group)) {
        if (key !== "matcher" && key !== "hooks") throw unusable(`${event} has an entry with an unexpected key "${printable(key).slice(0, 40)}"`);
      }
      const matcher = group.matcher;
      if (matcher !== undefined) {
        if (typeof matcher !== "string" || matcher.length > MAX_MATCHER_CHARS) throw unusable(`${event}: a matcher is not text of at most ${MAX_MATCHER_CHARS} characters`);
        if (hidesText(matcher)) throw unusable(`${event}: a matcher has control or invisible characters`);
        const problem = matcherProblem(matcher);
        if (problem) throw unusable(`${event}: ${problem}`);
      }
      if (!Array.isArray(group.hooks)) throw unusable(`${event} has an entry without a hooks list`);
      const hooks: HookCommand[] = [];
      for (const hook of group.hooks) {
        if (!isObject(hook)) throw unusable(`${event} has a hook that is not an object`);
        if (hook.type !== "command") throw unusable(`${event} has a hook of type ${typeof hook.type === "string" ? `"${printable(hook.type).slice(0, 20)}"` : "none"}; only "command" hooks are supported`);
        for (const key of Object.keys(hook)) {
          if (key !== "type" && key !== "command" && key !== "timeout") throw unusable(`${event} has a hook with an unexpected key "${printable(key).slice(0, 40)}"`);
        }
        const command = hook.command;
        if (typeof command !== "string" || command.trim() === "") throw unusable(`${event} has a command hook without a command`);
        if (command.length > MAX_COMMAND_CHARS) throw unusable(`${event} has a command longer than ${MAX_COMMAND_CHARS} characters`);
        // What is shown to the user must be what runs: no line break, escape sequence or invisible character.
        if (hidesText(command)) throw unusable(`${event} has a command with control or invisible characters`);
        const timeout = hook.timeout;
        if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_HOOK_TIMEOUT_SECONDS)) {
          throw unusable(`${event} has a timeout that is not between 0 and ${MAX_HOOK_TIMEOUT_SECONDS} seconds`);
        }
        hooks.push(timeout === undefined ? { command } : { command, timeout });
        commands++;
      }
      if (commands > MAX_HOOK_COMMANDS) throw unusable(`hooks.json declares more than ${MAX_HOOK_COMMANDS} commands`);
      if (hooks.length > 0) kept.push(matcher === undefined ? { hooks } : { matcher, hooks });
    }
    if (kept.length > 0) config[event] = kept;
  }
  if (commands === 0) throw unusable("hooks.json declares no command hooks");
  return config;
}

const cannotRead = (rel: string) => unusable(`${printable(rel)} is a symlink or cannot be read`);

function checkRegular(stat: Stats, rel: string) {
  if (!stat.isFile()) throw unusable(`${printable(rel)} is not a regular file`);
  if (stat.size > MAX_HOOK_FILE_BYTES) throw unusable(`${printable(rel)} is larger than ${formatMegabytes(MAX_HOOK_FILE_BYTES)}`);
}

/** Opens without following a link and reads the whole file, so a file swapped for a link after it was listed is not read. */
async function readRegular(path: string, rel: string): Promise<{ data: Buffer; mode: number }> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw cannotRead(rel);
  }
  try {
    const stat = await handle.stat();
    checkRegular(stat, rel);
    const data = Buffer.alloc(stat.size);
    let read = 0;
    while (read < data.length) {
      const { bytesRead } = await handle.read(data, read, data.length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return { data: data.subarray(0, read), mode: stat.mode };
  } finally {
    await handle.close();
  }
}

/** sha256 over the files sorted by path: each one's path length, path, size and bytes, so no path and content can be told from another split. */
export function digestFiles(files: readonly { path: string; data: Buffer }[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${Buffer.byteLength(file.path)}:${file.path}\n${file.data.length}\n`);
    hash.update(file.data);
    hash.update("\n");
  }
  return hash.digest("hex");
}

class Absent extends Error {}

const byPath = (a: HookFile, b: HookFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Why the folder itself cannot be listed: it is missing (`Absent`), or it cannot be read. */
function topFailure(error: unknown): never {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Absent();
  throw unusable("hooks/ cannot be read");
}

function checkTop(top: Stats) {
  if (top.isSymbolicLink()) throw unusable("hooks is a symlink; only a real folder is used");
  if (!top.isDirectory()) throw unusable("hooks is not a folder");
}

/** Counts what a walk passes and holds it to the limits. */
class HookBudget {
  private entries = 0;
  private bytes = 0;
  entry(name: string) {
    if (++this.entries > MAX_HOOK_ENTRIES) throw unusable(`hooks/ holds more than ${MAX_HOOK_ENTRIES} entries`);
    if (hidesText(name)) throw unusable(`a file name under hooks/ has control or invisible characters (${JSON.stringify(name).slice(0, 60)})`);
  }
  file(size: number) {
    this.bytes += size;
    if (this.bytes > MAX_HOOKS_BYTES) throw unusable(`hooks/ holds more than ${formatMegabytes(MAX_HOOKS_BYTES)} in total`);
  }
}

/** A folder to walk into, or a regular file to read; a link or anything else makes the hooks unusable. */
function entryKind(stat: Stats, path: string): "dir" | "file" {
  if (stat.isDirectory()) return "dir";
  if (stat.isSymbolicLink()) throw unusable(`${printable(path)} is a symlink; hooks/ may hold only regular files`);
  if (!stat.isFile()) throw unusable(`${printable(path)} is not a regular file; hooks/ may hold only regular files`);
  return "file";
}

/** Every regular file under `dir` (never through a link), sorted by path. Throws `Absent` when there is no folder, `Unusable` when it holds anything else. */
async function listHookFiles(dir: string): Promise<HookFile[]> {
  checkTop(await lstat(dir).catch(topFailure));
  const files: HookFile[] = [];
  const budget = new HookBudget();
  const walk = async (rel: string) => {
    for (const name of (await readdir(join(dir, rel))).sort()) {
      const path = rel ? `${rel}/${name}` : name;
      budget.entry(name);
      const stat = await lstat(join(dir, path));
      if (entryKind(stat, path) === "dir") await walk(path);
      else {
        budget.file(stat.size);
        const { data, mode } = await readRegular(join(dir, path), path);
        files.push({ path, size: data.length, mode, data });
      }
    }
  };
  await walk("");
  return files.sort(byPath);
}

type HookFilesRead = { ok: true; files: HookFile[] } | { ok: false; reason: string };

function hookFilesFailure(error: unknown): HookFilesRead {
  if (error instanceof Absent) return { ok: false, reason: "hooks/ is missing" };
  return { ok: false, reason: error instanceof Unusable ? error.message : "hooks/ cannot be read" };
}

/** The files of a folder under the same rules as `readHooksDir`, but not the shape of `hooks.json`: for a copy of `hooks/` in a view. */
export async function readHookFiles(dir: string): Promise<HookFilesRead> {
  try {
    return { ok: true, files: await listHookFiles(dir) };
  } catch (error) {
    return hookFilesFailure(error);
  }
}

/** What `hooks.json` and the files make of a `hooks/` folder, once they are read. */
function judgeHooksDir(files: HookFile[]): HooksRead {
  if (files.some((file) => file.path === COMMANDS_FILE)) throw unusable(`${COMMANDS_FILE} is a name marcsh keeps for itself; rename that file`);
  const manifest = files.find((file) => file.path === HOOKS_FILE);
  if (!manifest) throw unusable("hooks/ has no hooks.json");
  const config = parseHooksJson(manifest.data.toString("utf8"));
  return { present: true, usable: true, config, files, digest: digestFiles(files) };
}

function hooksDirFailure(error: unknown): HooksRead {
  if (error instanceof Absent) return { present: false };
  if (error instanceof Unusable) return { present: true, usable: false, reason: error.message };
  return { present: true, usable: false, reason: "hooks/ cannot be read" };
}

/** Reads a `hooks/` folder: its regular files (never through a link), their digest and the commands of `hooks.json`; unusable when anything is off-limits or `hooks.json` is not the supported shape. */
export async function readHooksDir(dir: string): Promise<HooksRead> {
  try {
    return judgeHooksDir(await listHookFiles(dir));
  } catch (error) {
    return hooksDirFailure(error);
  }
}

/** Quotes text as one word for `sh`. */
export const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** What Claude gets instead of the pack's `hooks.json`: the same events, matchers and timeouts with every command calling the filter (by marcsh's own bun, so PATH cannot turn the hooks off), plus the original commands for it to read. */
export function claudeHookFiles(config: HooksConfig, filterPath: string): { hooksJson: string; commandsJson: string } {
  const run = `${shellQuote(process.execPath)} --no-env-file --config=/dev/null ${shellQuote(filterPath)} "\${CLAUDE_PLUGIN_ROOT}/${HOOKS_DIR}/${COMMANDS_FILE}"`;
  const hooks = Object.fromEntries(
    Object.entries(config).map(([event, groups]) => [
      event,
      groups.map((group, g) => ({
        ...(group.matcher === undefined ? {} : { matcher: group.matcher }),
        hooks: group.hooks.map((hook, h) => ({
          type: "command",
          command: `${run} ${event} ${g} ${h}`,
          ...(hook.timeout === undefined ? {} : { timeout: hook.timeout }),
        })),
      })),
    ]),
  );
  const description = "Generated by marcsh: every command of this pack's hooks runs through marcsh's filter, which lets a hook block a call but never approve one";
  return { hooksJson: `${JSON.stringify({ description, hooks }, null, 2)}\n`, commandsJson: `${JSON.stringify(config, null, 2)}\n` };
}

/** The pack's hooks as the preview and the review list them: the event names in file order. */
export const hookEvents = (config: HooksConfig) => Object.keys(config);

/** The events' line for the review, as the user reads it. */
export function engineLine(events: readonly string[]): string {
  const { both, claudeOnly } = hookEngines(events);
  const parts = [
    ...(both.length > 0 ? [`${both.join(", ")} run on Claude and pi`] : []),
    ...(claudeOnly.length > 0 ? [`${claudeOnly.join(", ")} run on Claude only`] : []),
  ];
  return `${parts.join("; ")}.`;
}
