import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_APPROVAL_MODE, isApprovalMode, type ApprovalMode } from "./approval-policy";
import { DEFAULT_ENGINE_ID, isEngineId, type EngineId } from "./engine";
import { pushRecent } from "./model-picks";

/** What marcsh does when a turn finishes: ring the terminal bell, show a system notification, or nothing. */
export type NotifyMode = "bell" | "system" | "off";
const NOTIFY_MODES: readonly NotifyMode[] = ["bell", "system", "off"];
export const DEFAULT_NOTIFY_MODE: NotifyMode = "bell";

/** Model lists are kept per engine: Claude aliases and pi "provider/id" refs never mix. */
export type ModelLists = Partial<Record<EngineId, string[]>>;

export type Preferences = {
  themeName?: string;
  /** The engine new sessions start on. */
  defaultEngine?: string;
  /** The pi model ("provider/id") new pi turns use. */
  piModel?: string;
  /** The ID of the selected agent (see lib/agents). */
  agent?: string;
  /** The approval mode new sessions start in (normal, auto or yolo; see lib/approval-policy). */
  approvalMode?: string;
  /** The models marked as favorites, per engine, in the order they were marked. */
  favoriteModels?: ModelLists;
  /** The models last chosen or used for a turn, per engine, newest first. */
  recentModels?: ModelLists;
  /** What happens when a turn finishes; see {@link NotifyMode}. */
  notify?: NotifyMode;
};

export function preferencesPath() {
  return process.env.MARCSH_PREFERENCES_PATH?.trim() || join(homedir(), ".marcsh", "preferences.json");
}

export function readPreferences(path = preferencesPath()): Preferences {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Preferences) : {};
  } catch {
    return {};
  }
}

/** Merges into the stored preferences, so one setting never erases another. */
export function updatePreferences(patch: Preferences, path = preferencesPath()) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...readPreferences(path), ...patch }, null, 2), "utf8");
  } catch {
    // Ignore preference write failures so the setting still works for this run.
  }
}

// `marcsh --engine <engine>`: the engine for this launch only. It is never written to the preferences file.
let launchEngine: EngineId | undefined;

/** Overrides the default engine for this process (`undefined` clears it). */
export function setLaunchEngine(engine: EngineId | undefined) {
  launchEngine = engine;
}

export function getDefaultEngine(path = preferencesPath()): EngineId {
  if (launchEngine) return launchEngine;
  const { defaultEngine } = readPreferences(path);
  return isEngineId(defaultEngine) ? defaultEngine : DEFAULT_ENGINE_ID;
}

/** Persists the choice; an engine the user picks while running replaces the launch override. */
export function setDefaultEngine(engine: EngineId, path = preferencesPath()) {
  launchEngine = undefined;
  updatePreferences({ defaultEngine: engine }, path);
}

export function getDefaultApprovalMode(path = preferencesPath()): ApprovalMode {
  const { approvalMode } = readPreferences(path);
  return isApprovalMode(approvalMode) ? approvalMode : DEFAULT_APPROVAL_MODE;
}

export function setDefaultApprovalMode(mode: ApprovalMode, path = preferencesPath()) {
  updatePreferences({ approvalMode: mode }, path);
}

/** The stored pi model, or undefined when none is stored or the value is not a "provider/id" ref. */
export function getPiModel(path = preferencesPath()): string | undefined {
  const { piModel } = readPreferences(path);
  return typeof piModel === "string" && /^[^/\s]+\/\S+$/.test(piModel) ? piModel : undefined;
}

export function setPiModel(model: string, path = preferencesPath()) {
  updatePreferences({ piModel: model }, path);
}

/** The stored agent ID, or undefined when none is stored; whether that agent still exists is the caller's check. */
export function getAgentId(path = preferencesPath()): string | undefined {
  const { agent } = readPreferences(path);
  return typeof agent === "string" ? agent : undefined;
}

export function setAgentId(id: string, path = preferencesPath()) {
  updatePreferences({ agent: id }, path);
}

/** The strings of `value` for `engine`, each once; anything of another shape is ignored. */
function modelList(value: unknown, engine: EngineId): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const list: unknown = (value as Record<string, unknown>)[engine];
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((model): model is string => typeof model === "string" && model !== ""))];
}

export function getFavoriteModels(engine: EngineId, path = preferencesPath()): string[] {
  return modelList(readPreferences(path).favoriteModels, engine);
}

export function setFavoriteModels(engine: EngineId, models: string[], path = preferencesPath()) {
  const { favoriteModels } = readPreferences(path);
  const others = typeof favoriteModels === "object" && favoriteModels !== null && !Array.isArray(favoriteModels) ? favoriteModels : {};
  updatePreferences({ favoriteModels: { ...others, [engine]: models } }, path);
}

export function getRecentModels(engine: EngineId, path = preferencesPath()): string[] {
  return modelList(readPreferences(path).recentModels, engine);
}

/** Puts `model` first among the engine's recent models; the list keeps the last 5. */
export function recordRecentModel(engine: EngineId, model: string, path = preferencesPath()) {
  const { recentModels } = readPreferences(path);
  const others = typeof recentModels === "object" && recentModels !== null && !Array.isArray(recentModels) ? recentModels : {};
  updatePreferences({ recentModels: { ...others, [engine]: pushRecent(getRecentModels(engine, path), model) } }, path);
}

/** What happens when a turn finishes; the bell unless the preference is one of the known modes. */
export function getNotifyMode(path = preferencesPath()): NotifyMode {
  const { notify } = readPreferences(path);
  return NOTIFY_MODES.find((mode) => mode === notify) ?? DEFAULT_NOTIFY_MODE;
}
