import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelsArgs } from "../cli-args";
import { listAvailablePiModels, piModelRef } from "../lib/engine/pi-models";
import { SUPPORTED_CHAT_MODELS } from "../lib/models";
import { printable } from "../lib/safe-text";
import { EXIT, processIo, type Io } from "./io";

/** What the listing needs of pi's model runtime. */
export type PiModelSource = Pick<ModelRuntime, "getModels" | "getAvailable">;

export type ModelsDeps = { io?: Io; getRuntime?: () => Promise<PiModelSource> };

/** The runtime the pi turns use (loads pi on first use). */
async function piRuntime(): Promise<PiModelSource> {
  const { piHandle } = await import("../lib/engine");
  return piHandle().getRuntime();
}

/** Every model pi knows, sorted like the interface's pi model dialog, with whether its provider has credentials (the dialog lists only those). */
async function listPiModels(runtime: PiModelSource) {
  const available = new Set((await listAvailablePiModels(runtime)).map((model) => model.ref));
  return runtime
    .getModels()
    .map((model) => ({ ref: piModelRef(model), name: model.name, provider: model.provider, id: model.id, credentials: available.has(piModelRef(model)) }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** `marcsh models`: the Claude aliases and pi's models; resolves with the exit code. */
export async function modelsCommand(args: ModelsArgs, deps: ModelsDeps = {}): Promise<number> {
  const { io = processIo, getRuntime = piRuntime } = deps;
  const both = args.engine === undefined;
  const indent = both ? "  " : "";
  let code: number = EXIT.ok;

  if (both || args.engine === "claude") {
    if (both) io.stdout("claude\n");
    for (const { id } of SUPPORTED_CHAT_MODELS) io.stdout(`${indent}${id}\n`);
  }

  if (both || args.engine === "pi") {
    try {
      const models = await listPiModels(await getRuntime());
      if (both) io.stdout("\npi\n");
      if (models.length === 0) io.stdout(both ? `${indent}(none)\n` : "No pi models.\n");
      // Model names come from pi's catalogue and the user's models.json: nothing in them may reach the terminal as a control sequence.
      for (const model of models) io.stdout(`${indent}${model.credentials ? "*" : " "} ${printable(model.ref)}  ${printable(model.name)}\n`);
      if (models.length > 0) io.stdout("\n* has credentials; /login in the interface adds more\n");
    } catch (err) {
      io.stderr(`marcsh: cannot list the pi models: ${err instanceof Error ? err.message : String(err)}\n`);
      code = EXIT.failed;
    }
  }
  return code;
}
