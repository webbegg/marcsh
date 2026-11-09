import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Mode } from "../modes";
import { marcshPluginPath } from "../plugin";
import { getStorage, type Storage } from "../storage";
import { friendlyPiError, redactSecrets } from "./pi-auth";
import { applyPiEvent, createErrorTracker, withDuration } from "./pi-events";
import { ASK_USER_TOOL, createAskUserExtension } from "./pi-ask-user";
import type { Guard } from "./pi-guard";
import { createCommandLister, expandPluginInvocation, normalizePiCommands, toMenuCommands } from "./pi-commands";
import { createApprovalExtension, isReadOnlyBuiltin, READ_ONLY_TOOLS, runsUnasked } from "./pi-permissions";
import { createMarcshMcpExtension, disposePiSession, importLoadMcpConfig } from "./pi-mcp";
import { createPiUiContext } from "./pi-ui";
import { createSubagentExtension, runChildSession, TASK_TOOL } from "./pi-subagent";
import { isProjectTrusted, resolveProjectTrust, type ProjectTrustRecords } from "./pi-trust";
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

/**
 * Owner-only permissions (rwx------) on marcsh's own agent dir, since pi keeps logins and sessions in it.
 * mkdir leaves an existing directory untouched, so it is tightened too. A custom agent dir is the caller's:
 * it is never created or chmod-ed here.
 */
function secureDefaultAgentDir(agentDir: string) {
  if (agentDir !== defaultPiAgentDir()) return;
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  chmodSync(agentDir, 0o700);
}

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
  /** Where each project's trust decision is kept (see `pi-trust.ts`). Default: marcsh's SQLite, opened only for a project that has pi files. */
  projectTrust?: ProjectTrustRecords;
  /** The branch/ship guard for pi's `bash` tool. Default: the decision Claude's PreToolUse hook makes (tests inject others). */
  guard?: Guard;
  /** The marcsh plugin whose `feature` command and `workflow` skill pi loads in place. Default: the bundled one; null for none. */
  pluginPath?: string | null;
};

/** The pi engine, plus the handles the login and model dialogs share with its turns. */
export type PiEngine = Engine & {
  /** The model and auth runtime the turns use, created on first use. A login made through it is seen by the next turn. */
  getRuntime(): Promise<ModelRuntime>;
  /** The id pi keeps in its settings for this installation, which some logins send to the provider. */
  getDeviceId(): Promise<string>;
};

const BUILTIN_PREFIX = "builtin:";

/**
 * pi's own read-only exploration tools, offered next to its default ones (read, bash, edit, write). They run without
 * approval like `read` (see `pi-permissions.ts`). pi applies `+name` entries on top of the `defaultTools` setting, on new
 * and resumed sessions alike.
 */
const EXPLORATION_TOOLS = ["+ls", "+grep", "+find"];

/**
 * The `tools` option for a build session: the exploration tools are added when the user has no `defaultTools` setting
 * (agent dir or project), and a user's list is left exactly as they wrote it.
 */
function buildToolsOption(settingsManager: { getDefaultTools(): string[] | undefined }): { tools?: string[] } {
  return settingsManager.getDefaultTools() === undefined ? { tools: [...EXPLORATION_TOOLS] } : {};
}

/**
 * A resumed session whose active tools hold none of pi's own write or run tools (bash, edit, write): pi
 * restored the read-only loadout that a plan turn recorded in the session file. A build turn needs the
 * tools a new session offers instead.
 */
function restoredPlanTools(session: AgentSession): boolean {
  const active = new Set(session.getActiveToolNames());
  return !session.getAllTools().some((tool) => active.has(tool.name) && tool.sourceInfo.path.startsWith(BUILTIN_PREFIX) && !isReadOnlyBuiltin(tool));
}

/**
 * The tools a new session offers in this agent dir and project, by pi's own rules: the built-in ones come
 * from a throwaway in-memory session (it applies the `defaultTools` setting and pi's default list), the
 * extension and custom ones are the registered tools that pi activates on registration.
 */
async function newSessionTools(
  pi: Pi,
  session: AgentSession,
  { cwd, agentDir, models, model, projectTrusted }: { cwd: string; agentDir: string; models: ModelRuntime; model: NonNullable<ReturnType<ModelRuntime["getModel"]>>; projectTrusted: boolean },
): Promise<string[]> {
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: pi.SettingsManager.create(cwd, agentDir, { projectTrusted }),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const freshSettings = pi.SettingsManager.create(cwd, agentDir, { projectTrusted });
  const { session: fresh } = await pi.createAgentSession({
    cwd,
    agentDir,
    modelRuntime: models,
    model,
    sessionManager: pi.SessionManager.inMemory(cwd),
    settingsManager: freshSettings,
    resourceLoader,
    ...buildToolsOption(freshSettings),
  });
  const builtin = fresh.getActiveToolNames();
  await disposePiSession(fresh);
  // Opt-in extension tools (`defaultActive: false`) are on when the user's `defaultTools` names them.
  const namedByUser = new Set(pi.SettingsManager.create(cwd, agentDir, { projectTrusted }).getDefaultTools() ?? []);
  const registered = session
    .getAllTools()
    .filter((tool) => !tool.sourceInfo.path.startsWith(BUILTIN_PREFIX))
    .filter(
      (tool) =>
        (tool.exposure === "direct" || tool.exposure === "model-only") &&
        (session.getToolDefinition(tool.name)?.defaultActive !== false || namedByUser.has(tool.name)),
    )
    .map((tool) => tool.name);
  return [...new Set([...builtin, ...registered])];
}

function parseModel(ref: string): { provider: string; id: string } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

/**
 * The pi engine. Each turn opens its own pi session (new, or the file named by `resumeRef`), prompts it
 * once, and disposes it when pi has settled.
 *
 * Every tool except pi's read-only ones and marcsh's `AskUserQuestion` and `Task` asks through the host before
 * it runs (see `pi-permissions.ts`), and a `bash` command the branch/ship guard flags is blocked or always asked
 * (see `pi-guard.ts`). In plan mode the session only has the read-only tools, `AskUserQuestion` and `Task`.
 * `Task` runs a child session in this process (see `pi-subagent.ts`) whose tool calls ask the same way.
 *
 * A project's own pi files (extensions, MCP servers, settings...) load only when the project is trusted (see `pi-trust.ts`):
 * the first turn in an undecided project asks the host before pi loads anything of it, and a project that is not trusted
 * gets pi's untrusted behavior. Warm-up never asks and never loads the project's files unless it is already trusted.
 */
export function createPiEngine(options: PiEngineOptions = {}): PiEngine {
  const agentDir = options.agentDir ?? defaultPiAgentDir();
  const pluginPath = options.pluginPath === undefined ? marcshPluginPath() : options.pluginPath;
  // The plugin's `commands/*.md` become prompt templates (`/feature`) and its `skills/*/SKILL.md` skills (`/skill:workflow`),
  // read where they are, so the `/` menu lists them (as `marcsh:feature` and `marcsh:workflow`). Typing those names is
  // answered by `expandPluginInvocation`, not by pi, so a user's own `feature` or `workflow` cannot take their place.
  const pluginResources = pluginPath
    ? { additionalPromptTemplatePaths: [join(pluginPath, "commands")], additionalSkillPaths: [join(pluginPath, "skills")] }
    : {};
  // An engine given another agent dir (tests) points pi's lazy readers at it; see AGENT_DIR_ENV.
  process.env[AGENT_DIR_ENV] = agentDir;
  // Before pi writes anything there: its settings (the device id), logins, models and sessions.
  const prepareAgentDir = () => secureDefaultAgentDir(agentDir);
  const trustRecords = (): ProjectTrustRecords => options.projectTrust ?? getStorage();

  let runtime: Promise<ModelRuntime> | undefined;
  const runtimeFor = (pi: Pi) => {
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

    // Provider errors can echo the key or token that was sent, so nothing reaches the UI unredacted.
    const fail = (message: string) => {
      if (!aborted) host.emit({ type: "error", message: redactSecrets(friendlyPiError(message)) });
    };

    const run = async () => {
      process.env[AGENT_DIR_ENV] = agentDir;
      prepareAgentDir();
      const pi = await loadPi();
      const models = await runtimeFor(pi);
      const wanted = parseModel(model);
      const resolved = wanted && models.getModel(wanted.provider, wanted.id);
      if (!resolved) return fail(`Unknown pi model "${model}". Use provider/model-id.`);
      if (aborted) return;

      // Before pi reads anything of the project: its settings, extensions, MCP servers and the rest stay unloaded until this is decided.
      const projectTrusted = await resolveProjectTrust({
        cwd,
        records: trustRecords,
        ask: host.askProjectTrust && ((ask, askSignal) => host.askProjectTrust!(ask, askSignal)),
        signal: turnEnded.signal,
      });
      if (aborted) return;

      const sessionManager = resumeRef
        ? pi.SessionManager.open(resumeRef, options.sessionDir, cwd)
        : options.sessionDir
          ? pi.SessionManager.create(cwd, options.sessionDir)
          : undefined;
      const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted });
      const approval = {
        cwd,
        host,
        rules: options.permissionRules ?? getStorage(),
        signal: turnEnded.signal,
        planMode: mode === Mode.PLAN,
        guard: options.guard,
      };
      const resourceLoader = new pi.DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        ...pluginResources,
        extensionFactories: [
          // MCP tools are ordinary non-built-in tools: loaded before the approval extension, so its handler still runs last.
          createMarcshMcpExtension(pi.createMcpExtension, agentDir, await importLoadMcpConfig()),
          createApprovalExtension(approval),
          createAskUserExtension({ host, signal: turnEnded.signal }),
          // A child session has the parent turn's host, rules, guard and mode, so it asks the same way; in plan mode it only reads.
          createSubagentExtension({
            host,
            signal: turnEnded.signal,
            runChild: (request) =>
              runChildSession(pi, {
                ...request,
                cwd,
                agentDir,
                models,
                model: resolved,
                projectTrusted,
                extensions: [createApprovalExtension(approval)],
                ...(mode === Mode.PLAN ? { tools: [...READ_ONLY_TOOLS] } : buildToolsOption(settingsManager)),
              }),
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
        // Plan mode: only the read-only tools, the question tool and Task exist, so nothing that writes or runs can be called.
        ...(mode === Mode.PLAN ? { tools: [...READ_ONLY_TOOLS, ASK_USER_TOOL, TASK_TOOL] } : buildToolsOption(settingsManager)),
      }));
      // The allow-list is by name, so an extension tool called `read` would pass it: keep only pi's own and marcsh's.
      if (mode === Mode.PLAN) session.setActiveToolsByName(session.getAllTools().filter(runsUnasked).map((tool) => tool.name));
      // pi gives a resumed session the tools of its last turn: after a plan turn, a build turn sets them again.
      else if (resumeRef && restoredPlanTools(session)) {
        session.setActiveToolsByName(await newSessionTools(pi, session, { cwd, agentDir, models, model: resolved, projectTrusted }));
      }
      if (aborted) return;

      // Dialogs from extensions render in marcsh. The mode pi's own RPC host uses keeps `ctx.hasUI` true (dialogs work)
      // while telling extensions this is not pi's terminal (`ctx.mode` is not "tui"), so they skip pi-tui components.
      const started = session;
      await started.bindExtensions({
        uiContext: createPiUiContext({ host, signal: turnEnded.signal, theme: started.extensionRunner.getUIContext().theme }),
        mode: "rpc",
        // An extension command cannot replace the session marcsh is driving.
        commandContextActions: {
          waitForIdle: () => started.waitForIdle(),
          newSession: async () => ({ cancelled: true }),
          fork: async () => ({ cancelled: true }),
          navigateTree: async () => ({ cancelled: true }),
          switchSession: async () => ({ cancelled: true }),
          reload: async () => {},
        },
        onError: (error) => host.notify?.(redactSecrets(`Extension error in ${error.extensionPath}: ${error.error}`), "error"),
      });
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
        // pi expands templates and skills and runs extension commands itself: `/name args` goes to it as typed,
        // except the plugin's `/marcsh:...`, which is expanded here and then sent as plain text.
        const expanded = expandPluginInvocation(prompt, pluginPath, pi.stripFrontmatter);
        await session.prompt(expanded, expanded === prompt ? undefined : { expandPromptTemplates: false });
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
        // Tells the extensions the session is over (MCP closes its servers then) before pi's dispose drops them.
        return disposePiSession(session);
      });

    return { done, interrupt };
  }

  return {
    id: "pi",
    startTurn,
    // The command list comes from a throwaway in-memory session: no model call, no session file.
    warmUpCommands: async ({ cwd, save }) => {
      try {
        process.env[AGENT_DIR_ENV] = agentDir;
        prepareAgentDir();
        const pi = await loadPi();
        const models = await runtimeFor(pi);
        const commandLister = createCommandLister();
        // Never asks: a project that is not already trusted keeps its own files unloaded, so warm-up cannot run its code.
        const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: isProjectTrusted(cwd, trustRecords) });
        const resourceLoader = new pi.DefaultResourceLoader({
          cwd,
          agentDir,
          settingsManager,
          ...pluginResources,
          extensionFactories: [commandLister.extension, createMarcshMcpExtension(pi.createMcpExtension, agentDir)],
        });
        await resourceLoader.reload();
        const { session } = await pi.createAgentSession({
          cwd,
          agentDir,
          modelRuntime: models,
          sessionManager: pi.SessionManager.inMemory(cwd),
          settingsManager,
          resourceLoader,
        });
        try {
          save(toMenuCommands(normalizePiCommands(commandLister.list(), pluginPath)));
        } finally {
          await disposePiSession(session);
        }
      } catch {
        // Best effort: the menu keeps the last list it had.
      }
    },
    getRuntime: async () => {
      process.env[AGENT_DIR_ENV] = agentDir;
      prepareAgentDir();
      return runtimeFor(await loadPi());
    },
    getDeviceId: async () => {
      process.env[AGENT_DIR_ENV] = agentDir;
      prepareAgentDir();
      const pi = await loadPi();
      // The device id is a global setting: no project is involved, so none of its files are read.
      return pi.SettingsManager.create(process.cwd(), agentDir, { projectTrusted: false }).getOrCreateDeviceId();
    },
  };
}
