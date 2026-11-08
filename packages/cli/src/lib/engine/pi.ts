import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Mode } from "../modes";
import { getStorage, type Storage } from "../storage";
import { applyPiEvent, createErrorTracker, withDuration } from "./pi-events";
import { createApprovalExtension, isReadOnlyBuiltin, READ_ONLY_TOOLS } from "./pi-permissions";
import type { Engine, EngineTurn, TurnHost, TurnRequest } from "./types";

/** marcsh keeps pi's logins, settings, sessions and extensions apart from the user's own pi install. */
export function defaultPiAgentDir(): string {
  return join(homedir(), ".marcsh", "agent");
}

/**
 * pi finds its own directory (`getAgentDir()`: auth, settings, sessions, and `bin/` where it downloads the
 * `fd` and `rg` helpers that find and grep run) through this process-wide variable, and falls back to
 * `~/.pi/agent`. marcsh owns the variable for the whole process and always points it at its own agent dir,
 * whatever the shell had in it.
 *
 * pi's tool manager reads the directory once, when its modules load, so the variable is set before pi's
 * modules are first imported (this is why this file only imports pi's types and loads the rest with
 * `import()` when a turn starts). Do not import pi's modules ahead of this file.
 */
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

const loadPi = () => import("@earendil-works/pi-coding-agent");
type Pi = Awaited<ReturnType<typeof loadPi>>;

export type PiEngineOptions = {
  /** Where pi keeps auth, settings, models and sessions. Default: `~/.marcsh/agent`, never `~/.pi/agent`. */
  agentDir?: string;
  /** Where session files live. Default: pi's per-project directory under `agentDir`. */
  sessionDir?: string;
  /** Model and auth runtime. Default: one reading `auth.json` and `models.json` from `agentDir`. */
  modelRuntime?: ModelRuntime;
  /** Where "always" approvals are kept. Default: marcsh's SQLite, opened on the first turn that needs it. */
  permissionRules?: Pick<Storage, "addPermissionRule" | "hasPermissionRule">;
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
 * Every tool except pi's read-only ones asks through the host before it runs (see `pi-permissions.ts`).
 * In plan mode the session only has the read-only tools.
 */
export function createPiEngine(options: PiEngineOptions = {}): Engine {
  const agentDir = options.agentDir ?? defaultPiAgentDir();
  // An engine given another agent dir (tests) points pi's lazy readers at it; see AGENT_DIR_ENV.
  process.env[AGENT_DIR_ENV] = agentDir;

  let runtime: Promise<ModelRuntime> | undefined;
  const getRuntime = (pi: Pi) => {
    runtime ??= options.modelRuntime
      ? Promise.resolve(options.modelRuntime)
      : pi.ModelRuntime.create({
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

  function startTurn({ prompt, cwd, mode, model, resumeRef, signal }: TurnRequest, host: TurnHost): EngineTurn {
    const startedAt = Date.now();
    let session: AgentSession | undefined;
    let aborted = signal.aborted;
    // Aborts when the turn is interrupted or over: pending approvals are then declined.
    const turnEnded = new AbortController();

    const interrupt = () => {
      aborted = true;
      turnEnded.abort();
      void session?.abort();
    };
    signal.addEventListener("abort", interrupt, { once: true });

    const fail = (message: string) => {
      if (!aborted) host.emit({ type: "error", message });
    };

    const run = async () => {
      process.env[AGENT_DIR_ENV] = agentDir;
      const pi = await loadPi();
      const models = await getRuntime(pi);
      const wanted = parseModel(model);
      const resolved = wanted && models.getModel(wanted.provider, wanted.id);
      if (!resolved) return fail(`Unknown pi model "${model}". Use provider/model-id.`);
      if (aborted) return;

      const sessionManager = resumeRef
        ? pi.SessionManager.open(resumeRef, options.sessionDir, cwd)
        : options.sessionDir
          ? pi.SessionManager.create(cwd, options.sessionDir)
          : undefined;
      const settingsManager = pi.SettingsManager.create(cwd, agentDir);
      const resourceLoader = new pi.DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        extensionFactories: [
          createApprovalExtension({
            cwd,
            host,
            rules: options.permissionRules ?? getStorage(),
            signal: turnEnded.signal,
          }),
        ],
      });
      await resourceLoader.reload();
      if (aborted) return;

      ({ session } = await pi.createAgentSession({
        cwd,
        agentDir,
        modelRuntime: models,
        model: resolved,
        sessionManager,
        settingsManager,
        resourceLoader,
        // Plan mode: only the read-only tools exist, so nothing that writes or runs can be called.
        ...(mode === Mode.PLAN ? { tools: [...READ_ONLY_TOOLS] } : {}),
      }));
      // The allow-list is by name, so an extension tool called `read` would pass it: keep only pi's own.
      if (mode === Mode.PLAN) session.setActiveToolsByName(session.getAllTools().filter(isReadOnlyBuiltin).map((tool) => tool.name));
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
        turnEnded.abort();
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
