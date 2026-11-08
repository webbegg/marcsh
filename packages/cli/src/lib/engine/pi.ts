import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AgentSession,
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { applyPiEvent, createErrorTracker, withDuration } from "./pi-events";
import type { Engine, EngineTurn, TurnHost, TurnRequest } from "./types";

/** marcsh keeps pi's logins, settings, sessions and extensions apart from the user's own pi install. */
export function defaultPiAgentDir(): string {
  return join(homedir(), ".marcsh", "agent");
}

export type PiEngineOptions = {
  /** Where pi keeps auth, settings, models and sessions. Default: `~/.marcsh/agent`, never `~/.pi/agent`. */
  agentDir?: string;
  /** Where session files live. Default: pi's per-project directory under `agentDir`. */
  sessionDir?: string;
  /** Model and auth runtime. Default: one reading `auth.json` and `models.json` from `agentDir`. */
  modelRuntime?: ModelRuntime;
};

function parseModel(ref: string): { provider: string; id: string } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

/**
 * The pi engine. Each turn opens its own pi session (new, or the file named by `resumeRef`), prompts it
 * once, and disposes it when pi has settled.
 *
 * Tools run without approval until the permission bridge (T6) is wired in, so this engine must not be
 * selectable before then.
 */
export function createPiEngine(options: PiEngineOptions = {}): Engine {
  const agentDir = options.agentDir ?? defaultPiAgentDir();

  let runtime: Promise<ModelRuntime> | undefined;
  const getRuntime = () => {
    runtime ??= options.modelRuntime
      ? Promise.resolve(options.modelRuntime)
      : ModelRuntime.create({
          authPath: join(agentDir, "auth.json"),
          modelsPath: join(agentDir, "models.json"),
          allowModelNetwork: false,
        });
    // A failed start must not stick: the next turn retries it.
    runtime.catch(() => {
      runtime = undefined;
    });
    return runtime;
  };

  function startTurn({ prompt, cwd, model, resumeRef, signal }: TurnRequest, host: TurnHost): EngineTurn {
    const startedAt = Date.now();
    let session: AgentSession | undefined;
    let aborted = signal.aborted;

    const interrupt = () => {
      aborted = true;
      void session?.abort();
    };
    signal.addEventListener("abort", interrupt, { once: true });

    const fail = (message: string) => {
      if (!aborted) host.emit({ type: "error", message });
    };

    const run = async () => {
      const models = await getRuntime();
      const wanted = parseModel(model);
      const resolved = wanted && models.getModel(wanted.provider, wanted.id);
      if (!resolved) return fail(`Unknown pi model "${model}". Use provider/model-id.`);
      if (aborted) return;

      const sessionManager = resumeRef
        ? SessionManager.open(resumeRef, options.sessionDir, cwd)
        : options.sessionDir
          ? SessionManager.create(cwd, options.sessionDir)
          : undefined;
      ({ session } = await createAgentSession({ cwd, agentDir, modelRuntime: models, model: resolved, sessionManager }));
      if (aborted) return;

      const errors = createErrorTracker();
      session.subscribe((event) => {
        const failure = errors.observe(event);
        if (failure) fail(failure);
        if (event.type === "message_end" || event.type === "tool_execution_end") {
          host.emit({ type: "reply", update: (reply) => applyPiEvent(reply, event) });
        }
      });
      if (session.sessionFile) host.emit({ type: "session", ref: session.sessionFile });

      try {
        await session.prompt(prompt);
        await session.waitForIdle();
      } finally {
        host.emit({ type: "reply", update: (reply) => withDuration(reply, Date.now() - startedAt) });
      }

      const failure = errors.flush();
      if (failure) fail(failure);
    };

    const done = run()
      .catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        signal.removeEventListener("abort", interrupt);
        session?.dispose();
      });

    return { done, interrupt };
  }

  return {
    id: "pi",
    startTurn,
    warmUpCommands: async () => {},
  };
}
