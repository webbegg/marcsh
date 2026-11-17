import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PI_DEFAULT_MODEL } from "./models";

/**
 * Model profiles: named presets of which model (and thinking level, and fallback chain) each subagent and the main turn use.
 * The file is `profiles.json` next to `preferences.json` (`MARCSH_PROFILES_PATH` moves it):
 *
 *     { "version": 1, "default": "cheap",
 *       "profiles": { "cheap": { "primary": { "model": "anthropic/claude-sonnet-5-5", "fallback": [{ "model": "openai/gpt-5" }] },
 *                                "review-*": { "model": "anthropic/claude-haiku-5-5", "thinking": "low" },
 *                                "*": { "model": "anthropic/claude-haiku-5-5" } } } }
 *
 * This module is the store: the file's format, its reading and the profile the session chose. How a route is picked for an agent is
 * `model-routing.ts`.
 */

/** The key of the route of the selected agent's own turn (a subagent file named `primary` is never matched by it). */
export const PRIMARY_KEY = "primary";
/** The key of the route of any subagent no other key matches. */
export const ANY_KEY = "*";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];
/** The most models a fallback chain holds. */
export const MAX_FALLBACK = 8;

/** One model of a chain: its thinking level is pi's only (Claude has no such setting in marcsh). */
export type RouteStep = { model: string; thinking?: Thinking };
export type Route = RouteStep & { fallback?: RouteStep[] };
/** Route keys: a subagent's file name, a prefix glob (`review-*`), `*`, or `primary`. */
export type Profile = Record<string, Route>;
export type ProfilesFile = { version: 1; default?: string; profiles: Record<string, Profile> };

export const emptyProfiles = (): ProfilesFile => ({ version: 1, profiles: {} });

export const isThinking = (value: unknown): value is Thinking => typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*\*?$/;

export const isProfileName = (name: string) => NAME.test(name) && !RESERVED.has(name);
const isRouteKey = (key: string) => key === ANY_KEY || (KEY.test(key) && !RESERVED.has(key));

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function parseStep(value: unknown, where: string, problems: string[]): RouteStep | undefined {
  const raw = typeof value === "string" ? { model: value } : value;
  if (!isObject(raw) || typeof raw.model !== "string" || !raw.model.trim()) {
    problems.push(`${where} needs a "model" string`);
    return undefined;
  }
  const step: RouteStep = { model: raw.model.trim() };
  if (raw.thinking !== undefined) {
    if (isThinking(raw.thinking)) step.thinking = raw.thinking;
    else problems.push(`${where}: "thinking" must be one of ${THINKING_LEVELS.join(", ")}`);
  }
  return step;
}

function parseRoute(value: unknown, where: string, problems: string[]): Route | undefined {
  const step = parseStep(value, where, problems);
  if (!step) return undefined;
  const route: Route = step;
  const fallback = (value as { fallback?: unknown }).fallback;
  if (fallback === undefined) return route;
  if (!Array.isArray(fallback)) {
    problems.push(`${where}: "fallback" must be a list`);
    return route;
  }
  const steps: RouteStep[] = [];
  for (const [index, item] of fallback.entries()) {
    const parsed = parseStep(item, `${where}: fallback ${index + 1}`, problems);
    if (!parsed || parsed.model === route.model || steps.some((other) => other.model === parsed.model)) continue;
    if (steps.length >= MAX_FALLBACK) {
      problems.push(`${where}: keep at most ${MAX_FALLBACK} fallback models`);
      break;
    }
    steps.push(parsed);
  }
  if (steps.length > 0) route.fallback = steps;
  return route;
}

/**
 * Reads the file's content. A file that is not an object with `"version": 1` is ignored whole (no profiles, one problem); inside a valid
 * file a profile, route or fallback step that is wrong is dropped, and each is reported in `problems`.
 */
export function parseProfiles(raw: unknown): { file: ProfilesFile; problems: string[] } {
  const problems: string[] = [];
  if (!isObject(raw)) return { file: emptyProfiles(), problems: ["it is not a JSON object"] };
  if (raw.version !== 1) return { file: emptyProfiles(), problems: [`"version" must be 1${raw.version === undefined ? " (it is missing)" : ""}`] };
  const file = emptyProfiles();
  const profiles = raw.profiles === undefined ? {} : raw.profiles;
  if (!isObject(profiles)) return { file: emptyProfiles(), problems: ['"profiles" must be an object of named profiles'] };
  for (const [name, value] of Object.entries(profiles)) {
    if (!isProfileName(name)) {
      problems.push(`profile name "${name}" is not valid: use 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit`);
      continue;
    }
    if (!isObject(value)) {
      problems.push(`profile "${name}" must be an object of routes`);
      continue;
    }
    const profile: Profile = {};
    for (const [key, entry] of Object.entries(value)) {
      if (!isRouteKey(key)) {
        problems.push(`profile "${name}": "${key}" is not a route key (a subagent name, a prefix like "review-*", "*" or "primary")`);
        continue;
      }
      const route = parseRoute(entry, `profile "${name}": route "${key}"`, problems);
      if (route) profile[key] = route;
    }
    file.profiles[name] = profile;
  }
  if (raw.default !== undefined) {
    if (typeof raw.default === "string" && Object.hasOwn(file.profiles, raw.default)) file.default = raw.default;
    else problems.push(`"default" names profile ${JSON.stringify(raw.default)}, which does not exist`);
  }
  return { file, problems };
}

/** Where the profiles live: `MARCSH_PROFILES_PATH`, else `profiles.json` in the folder of the preferences file (`~/.marcsh`). */
export function profilesPath(): string {
  const set = process.env.MARCSH_PROFILES_PATH?.trim();
  if (set) return set;
  // Read from the environment, not from `preferences.ts`, which imports the engines (and they import this).
  const preferences = process.env.MARCSH_PREFERENCES_PATH?.trim();
  return preferences ? join(dirname(preferences), "profiles.json") : join(homedir(), ".marcsh", "profiles.json");
}

export type LoadedProfiles = {
  file: ProfilesFile;
  /** Why the file or parts of it are ignored; empty when it is fine or absent. */
  problems: string[];
  exists: boolean;
};

/** Reads the profiles. Never throws: a missing file is no profiles, an unreadable or invalid one is no profiles and says why. */
export function loadProfiles(path = profilesPath()): LoadedProfiles {
  if (!existsSync(path)) return { file: emptyProfiles(), problems: [], exists: false };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { file: emptyProfiles(), problems: [`it cannot be read: ${error instanceof Error ? error.message : String(error)}`], exists: true };
  }
  return { ...parseProfiles(raw), exists: true };
}

/** The one-line warning for a file that is invalid or has parts that are ignored; undefined when there is nothing to say. */
export function profilesWarning(loaded: LoadedProfiles, path = profilesPath()): string | undefined {
  if (loaded.problems.length === 0) return undefined;
  const shown = loaded.problems.slice(0, 3).join("; ");
  const more = loaded.problems.length > 3 ? `; and ${loaded.problems.length - 3} more` : "";
  return `${path}: ${shown}${more}. Whatever is invalid is ignored.`;
}

/**
 * Sets `default` in the file, keeping everything else in it. The file must exist, be valid JSON and hold the profile; it is replaced in
 * one step, so an interrupted write never leaves half a file. Throws a user-facing message otherwise.
 */
export function writeDefaultProfile(name: string, path = profilesPath()): void {
  if (!existsSync(path)) throw new Error(`There is no profiles file (${path}). Create it first: see the configuration guide.`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} is not valid JSON, so it was left as it is: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(raw)) throw new Error(`${path} is not a JSON object, so it was left as it is.`);
  if (!isObject(raw.profiles) || !Object.hasOwn(raw.profiles, name)) throw new Error(`There is no profile "${name}" in ${path}.`);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ ...raw, default: name }, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

const STARTER_COMMENT =
  'Model profiles for marcsh. A profile routes models. "primary" routes the main turn: the default profile adds its thinking level and fallback chain, and /profile use <name> also switches to its primary model. Add more routes under a subagent\'s file name, a prefix such as "review-*", or "*", each as { "model": ..., "thinking": ..., "fallback": [...] }. ' +
  'pi takes provider/id and Claude takes opus, sonnet or haiku; a route for the other engine is skipped, so this starter lists both. ' +
  'Choose a profile for a session with /profile use <name>; the profile named in "default" applies to every session that has not chosen another. ' +
  "marcsh never overwrites this file; /profile default only changes the \"default\" entry. See docs/configuration.md.";

/** Whether a plain file, not a link or a folder, is at the path. */
function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** Whether a link whose target is missing is at the path: `existsSync` says no, yet a file cannot be created there. */
export function isDanglingLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && !existsSync(path);
  } catch {
    return false;
  }
}

/** The text of the starter file: one `default` profile whose primary model is the current engine's, with the other engine's as a fallback its own engine skips. */
export function starterProfilesText(models: { engine: string; piModel: string; claudeModel: string }): string {
  const piModel = models.piModel.trim();
  const claude = models.claudeModel;
  // The main model must be set, so pi without one takes pi's default; the other engine's model is listed only when there is one.
  const [model, other] = models.engine === "pi" ? [piModel || PI_DEFAULT_MODEL, claude] : [claude, piModel];
  const starter = {
    $comment: STARTER_COMMENT,
    version: 1,
    default: "default",
    profiles: { default: { primary: { model, ...(other && other !== model ? { fallback: [{ model: other }] } : {}) } } },
  };
  return `${JSON.stringify(starter, null, 2)}\n`;
}

export type StarterResult = { ok: true; path: string } | { ok: false; reason: "exists" | "denied" | "failed"; message: string };

/**
 * Creates a starter profiles file at `path` (default `profilesPath()`), with the parent folder if it is missing. The file is created
 * exclusively (`wx`): an existing file, a symlink or one that appeared a moment ago is never touched. Whatever is written is read back
 * with the profile reader; a file that does not read as the starter is removed again. Never throws.
 */
export function createStarterProfiles(models: { engine: string; piModel: string; claudeModel: string }, path = profilesPath()): StarterResult {
  const text = starterProfilesText(models);
  const check = (parsed: { file: ProfilesFile; problems: string[] }) => parsed.problems.length === 0 && parsed.file.default === "default" && Object.hasOwn(parsed.file.profiles, "default");
  // The text is ours, but it is checked before it is written all the same.
  if (!check(parseProfiles(JSON.parse(text)))) return { ok: false, reason: "failed", message: "The starter profiles file did not pass marcsh's own check, so nothing was written." };
  const denied = (code: string | undefined) => code === "EACCES" || code === "EPERM" || code === "EROFS";
  const deniedResult = (): StarterResult => ({
    ok: false,
    reason: "denied",
    message: `Cannot create ${path}: permission denied. Fix the folder's permissions, or set MARCSH_PROFILES_PATH to a file you can write.`,
  });
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A file in the way of the folder is also reported as EEXIST: that is not a profiles file that exists.
    if (denied(code)) return deniedResult();
    return { ok: false, reason: "failed", message: `Could not create the folder for ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    writeFileSync(path, text, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      const message = isRegularFile(path)
        ? `A profiles file already exists at ${path}, so it was left as it is.`
        : `Something other than a profiles file is at ${path} (a link or a folder), so nothing was written.`;
      return { ok: false, reason: "exists", message };
    }
    if (denied(code)) return deniedResult();
    return { ok: false, reason: "failed", message: `Could not create ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const written = loadProfiles(path);
  if (!check(written)) {
    // Only the file just created is removed, and only while it still holds exactly what was written: a file something else wrote to meanwhile is left alone.
    try {
      if (readFileSync(path, "utf8") === text) rmSync(path);
    } catch {}
    return { ok: false, reason: "failed", message: `The file written to ${path} did not read back as a valid profiles file, so it was removed.` };
  }
  return { ok: true, path };
}

// What `/profile use` chose, for this run of marcsh (like `/permissions <mode>`): never saved.
let sessionProfile: string | undefined;

/** The profile chosen with `/profile use` in this run, if any. */
export const getSessionProfile = () => sessionProfile;
/** Chooses the session's profile; `undefined` clears it, which brings back the default. */
export function setSessionProfile(name: string | undefined) {
  sessionProfile = name;
}

/** The profiles in force, highest first, each with where it comes from: the session's, then the file's default. A name the file lacks is skipped. */
export type ActiveProfile = { name: string; source: "session" | "default"; profile: Profile };

export function activeProfiles(file: ProfilesFile, session: string | undefined = sessionProfile): ActiveProfile[] {
  const active: ActiveProfile[] = [];
  if (session && Object.hasOwn(file.profiles, session)) active.push({ name: session, source: "session", profile: file.profiles[session]! });
  if (file.default && file.default !== session && Object.hasOwn(file.profiles, file.default)) {
    active.push({ name: file.default, source: "default", profile: file.profiles[file.default]! });
  }
  return active;
}
