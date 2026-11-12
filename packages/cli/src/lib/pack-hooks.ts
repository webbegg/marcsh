import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { hidesText, printable } from "./safe-text";

/*
 * Pack hooks: the commands a pack asks to run, read from its `hooks/` folder without running anything.
 *
 * A pack's hooks are `hooks/hooks.json` (Claude's plugin format) plus the regular files under `hooks/` it may run. They are off until the
 * user enables them after reading every command, and the consent is pinned to the pack commit and to `digest` below (see packs.ts). This
 * module only reads and judges: whatever is not exactly the supported shape makes the hooks unusable, and unusable hooks are never enabled.
 *
 * Claude is not given the pack's `hooks.json`: `claudeHookFiles` makes the one it runs, where every command is a call to marcsh's filter
 * (plugin/hooks/pack-hook-filter.ts) that runs the original and lets only what narrows a call through.
 */

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

/** Opens without following a link and reads the whole file, so a file swapped for a link after it was listed is not read. */
function readRegular(path: string, rel: string): { data: Buffer; mode: number } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw unusable(`${printable(rel)} is a symlink or cannot be read`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw unusable(`${printable(rel)} is not a regular file`);
    if (stat.size > MAX_HOOK_FILE_BYTES) throw unusable(`${printable(rel)} is larger than ${formatMegabytes(MAX_HOOK_FILE_BYTES)}`);
    const data = Buffer.alloc(stat.size);
    let read = 0;
    while (read < data.length) {
      const n = readSync(fd, data, read, data.length - read, read);
      if (n === 0) break;
      read += n;
    }
    return { data: data.subarray(0, read), mode: stat.mode };
  } finally {
    closeSync(fd);
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

/** Every regular file under `dir` (never through a link), sorted by path. Throws `Absent` when there is no folder, `Unusable` when it holds anything else. */
function listHookFiles(dir: string): HookFile[] {
  let top;
  try {
    top = lstatSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Absent();
    throw unusable("hooks/ cannot be read");
  }
  if (top.isSymbolicLink()) throw unusable("hooks is a symlink; only a real folder is used");
  if (!top.isDirectory()) throw unusable("hooks is not a folder");

  const files: HookFile[] = [];
  let entries = 0;
  let bytes = 0;
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const path = rel ? `${rel}/${name}` : name;
      if (++entries > MAX_HOOK_ENTRIES) throw unusable(`hooks/ holds more than ${MAX_HOOK_ENTRIES} entries`);
      if (hidesText(name)) throw unusable(`a file name under hooks/ has control or invisible characters (${JSON.stringify(name).slice(0, 60)})`);
      const stat = lstatSync(join(dir, path));
      if (stat.isDirectory()) walk(path);
      else if (stat.isSymbolicLink()) throw unusable(`${printable(path)} is a symlink; hooks/ may hold only regular files`);
      else if (!stat.isFile()) throw unusable(`${printable(path)} is not a regular file; hooks/ may hold only regular files`);
      else {
        bytes += stat.size;
        if (bytes > MAX_HOOKS_BYTES) throw unusable(`hooks/ holds more than ${formatMegabytes(MAX_HOOKS_BYTES)} in total`);
        const { data, mode } = readRegular(join(dir, path), path);
        files.push({ path, size: data.length, mode, data });
      }
    }
  };
  walk("");
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The files of a folder under the same rules as `readHooksDir`, but not the shape of `hooks.json`: for a copy of `hooks/` in a view. */
export function readHookFiles(dir: string): { ok: true; files: HookFile[] } | { ok: false; reason: string } {
  try {
    return { ok: true, files: listHookFiles(dir) };
  } catch (error) {
    if (error instanceof Absent) return { ok: false, reason: "hooks/ is missing" };
    return { ok: false, reason: error instanceof Unusable ? error.message : "hooks/ cannot be read" };
  }
}

/**
 * Reads a `hooks/` folder: every regular file in it (never through a link), the digest of those files, and the commands of `hooks.json`.
 * The folder is unusable, and so never enabled, when anything in it is a link or a special file, a file is over 1 MB or the folder over
 * 5 MB, a name has control or invisible characters or is one marcsh keeps for itself, or `hooks.json` is missing or is anything but the supported shape.
 */
export function readHooksDir(dir: string): HooksRead {
  try {
    const files = listHookFiles(dir);
    if (files.some((file) => file.path === COMMANDS_FILE)) throw unusable(`${COMMANDS_FILE} is a name marcsh keeps for itself; rename that file`);
    const manifest = files.find((file) => file.path === HOOKS_FILE);
    if (!manifest) throw unusable("hooks/ has no hooks.json");
    const config = parseHooksJson(manifest.data.toString("utf8"));
    return { present: true, usable: true, config, files, digest: digestFiles(files) };
  } catch (error) {
    if (error instanceof Absent) return { present: false };
    if (error instanceof Unusable) return { present: true, usable: false, reason: error.message };
    return { present: true, usable: false, reason: "hooks/ cannot be read" };
  }
}

/** Quotes text as one word for `sh`. */
export const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * What Claude is given for a pack's hooks, instead of the pack's own `hooks.json`: a `hooks.json` with the same events, matchers and timeouts
 * where every command is a call to marcsh's filter (`filterPath`, run by marcsh's own bun, by path, so a PATH without bun cannot leave the hooks
 * silently off, and without the project's env file or config), and the commands file
 * the filter reads the original commands from (the commands as the user read them, by event, group and hook number).
 */
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
