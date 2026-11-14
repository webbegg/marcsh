import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_ENGINE_ID, isEngineId, type EngineId } from "./engine";

export type Preferences = {
  themeName?: string;
  /** The engine new sessions start on. */
  defaultEngine?: string;
  /** The pi model ("provider/id") new pi turns use. */
  piModel?: string;
  /** The ID of the selected agent (see lib/agents). */
  agent?: string;
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
