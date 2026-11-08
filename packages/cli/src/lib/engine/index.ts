import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { claudeEngine } from "./claude";
import type { PiEngine } from "./pi";
import type { Engine } from "./types";

export const ENGINE_IDS = ["claude", "pi"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

export const DEFAULT_ENGINE_ID: EngineId = "claude";

export const ENGINE_LABELS: Record<EngineId, string> = {
  claude: "Claude (Agent SDK)",
  pi: "pi",
};

export function isEngineId(value: unknown): value is EngineId {
  return ENGINE_IDS.some((id) => id === value);
}

export function createEngineRegistry(createPi: () => Engine) {
  const replaced = new Map<string, Engine>();
  let pi: Engine | undefined;

  return {
    /** The engine for a stored session's `engine` value, or undefined when this build does not know it. */
    get(id: string): Engine | undefined {
      const replacement = replaced.get(id);
      if (replacement) return replacement;
      if (id === "claude") return claudeEngine;
      if (id === "pi") return (pi ??= createPi());
      return undefined;
    },
    /** Swaps an engine for another (tests inject fakes); `undefined` restores the real one. */
    set(id: string, engine: Engine | undefined) {
      if (engine) replaced.set(id, engine);
      else replaced.delete(id);
    },
  };
}

export const engines = createEngineRegistry(
  // Loaded on first use so Claude-only runs do not pay for pi's modules at startup.
  () => (require("./pi") as typeof import("./pi")).createPiEngine(),
);

export const getEngine = (id: string) => engines.get(id);

/**
 * The pi engine's model runtime and device id, for the login and model dialogs: they use the runtime the pi
 * turns use, so a login is seen by the next turn. Creating the runtime loads pi (lazily, after the engine has
 * pointed pi at marcsh's agent dir). A pi engine without them (a test double) rejects.
 */
export function piHandle(registry: Pick<ReturnType<typeof createEngineRegistry>, "get"> = engines) {
  const pi = () => {
    const engine = registry.get("pi") as Partial<PiEngine> | undefined;
    if (!engine?.getRuntime || !engine.getDeviceId) throw new Error("The pi engine has no model runtime");
    return engine as PiEngine;
  };
  return {
    getRuntime: async (): Promise<ModelRuntime> => pi().getRuntime(),
    getDeviceId: async (): Promise<string> => pi().getDeviceId(),
  };
}

export const getPiRuntime = () => piHandle().getRuntime();

/** Stands in for a session whose engine this build does not know: its turns only report that. */
export function unknownEngine(id: string): Engine {
  return {
    id,
    startTurn(_request, host) {
      host.emit({ type: "error", message: `This session uses an unknown engine: ${id}` });
      return { done: Promise.resolve(), interrupt() {} };
    },
    warmUpCommands: async () => {},
  };
}
