import { randomUUID } from "node:crypto";

/** The variable that marks every process this marcsh run starts (see `leftovers.ts`). Its own module: marcsh sets it first thing, before loading anything else. */
export const SESSION_ENV = "MARCSH_SESSION";
/** The background terminal (`bt-3`) that started a process: set by `terminals.ts`, read by `leftovers.ts`. */
export const BG_ENV = "MARCSH_BG";
/** Set to `1` on what marcsh starts for itself (pi's pack hooks): never listed as a leftover. `pi-pack-hooks.ts` still spells it out. */
export const INFRA_ENV = "MARCSH_INFRA";

export type SessionMarker = {
  /** The marker's value, fresh for each marcsh process. */
  id: string;
  /** When it was made (epoch ms): no process started before it can be this run's. */
  since: number;
};

let current: SessionMarker | undefined;

/**
 * Makes this marcsh process's marker and puts it in `env` (its own environment, which every process it starts inherits). A marker
 * inherited from another marcsh (one started by a tool of another run) is replaced: each run only ever finds its own.
 */
export function startSessionMarker(env: NodeJS.ProcessEnv = process.env, now = Date.now()): SessionMarker {
  current = { id: randomUUID(), since: now };
  env[SESSION_ENV] = current.id;
  return current;
}

/** This process's marker, or undefined before `startSessionMarker` (tests, and nothing to find then). */
export const sessionMarker = (): SessionMarker | undefined => current;

/** Forgets the marker (tests). */
export function clearSessionMarker() {
  current = undefined;
}
