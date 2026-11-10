import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PI_DEFAULT_MODEL } from "../models";

export type PiModelOption = {
  /** "provider/id", the form pi turns take. */
  ref: string;
  provider: string;
  id: string;
  name: string;
};

export const piModelRef = ({ provider, id }: { provider: string; id: string }) => `${provider}/${id}`;

/** The models whose provider has credentials right now (stored logins, environment, models.json), by provider then name. */
export async function listAvailablePiModels(runtime: Pick<ModelRuntime, "getAvailable">): Promise<PiModelOption[]> {
  const models = await runtime.getAvailable(undefined, { signal: AbortSignal.timeout(15_000) });
  return models
    .map((model) => ({ ref: piModelRef(model), provider: model.provider, id: model.id, name: model.name }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * The model a pi turn should use: the preferred one while it is available, else the first available one,
 * else the default pi model (which then fails with a pointer to `/login`).
 */
export function pickPiModel(preferred: string | undefined, available: readonly PiModelOption[]): string {
  if (preferred && available.some((model) => model.ref === preferred)) return preferred;
  return available[0]?.ref ?? PI_DEFAULT_MODEL;
}
