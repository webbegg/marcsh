import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSession, AgentSessionEvent, ExtensionFactory, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { isPiToolDenied, notAvailableReason, type Group } from "../agent-tools";
import { Mode } from "../modes";
import { prepareViewForTurn } from "../packs";
import { marcshPluginPath } from "../plugin";
import { getStorage, type Storage } from "../storage";
import { friendlyPiError, redactSecrets } from "./pi-auth";
import { applyPiEvent, createErrorTracker, createReplyFeed, isStreamDelta, withDuration } from "./pi-events";
import { ASK_USER_TOOL, createAskUserExtension, isMarcshAskUser } from "./pi-ask-user";
import type { Guard } from "./pi-guard";
import { createCommandLister, expandPluginInvocation, normalizePiCommands, toMenuCommands } from "./pi-commands";
import { createApprovalExtension, isReadOnlyBuiltin, READ_ONLY_TOOLS, runsUnasked, type ToolSource } from "./pi-permissions";
import { createMarcshMcpExtension, disposePiSession, importLoadMcpConfig } from "./pi-mcp";
import { createPackHooksExtension } from "./pi-pack-hooks";
import { createPiUiContext } from "./pi-ui";
import { createSubagentExtension, isMarcshTask, runChildSession, TASK_TOOL } from "./pi-subagent";
import { isProjectTrusted, resolveProjectTrust, type ProjectTrustRecords } from "./pi-trust";
import { TurnClosedError, type Engine, type EngineEvent, type EngineTurn, type TurnHost, type TurnRequest } from "./types";

/**
 * marcsh keeps pi's logins, settings, sessions and extensions apart from the user's own pi install.
 * `MARCSH_AGENT_DIR` moves it (tests point it at a temp dir so they never touch the real login).
 */
export function defaultPiAgentDir(): string {
  return process.env.MARCSH_AGENT_DIR?.trim() || join(homedir(), ".marcsh", "agent");
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
 * What marcsh itself took away from a session's tools for an agent's `tools` field (S15), kept in the session file as a custom entry
 * (pi ignores those) so a later turn can undo exactly that and nothing else. pi restores a resumed session's tools from its last turn,
 * so without this the next agent would inherit the narrowing; and without this record a change in the restored tools that marcsh did
 * not make (the user's `defaultTools`, an extension that turned a tool off) would look like one.
 */
const NARROWING_ENTRY = "marcsh-agent-tools";
type Narrowing = { denied: Group[]; removed: string[] };

const sameGroups = (a: readonly string[], b: readonly string[]) => a.join(",") === b.join(",");

/** The last narrowing recorded on this session's branch; undefined when marcsh never recorded one. */
function lastNarrowing(sessionManager: Pick<SessionManagerLike, "getBranch">): Narrowing | undefined {
  const branch = sessionManager.getBranch();
  for (let at = branch.length - 1; at >= 0; at--) {
    const entry = branch[at]!;
    if (entry.type !== "custom" || entry.customType !== NARROWING_ENTRY) continue;
    const data = entry.data as { denied?: unknown; removed?: unknown } | undefined;
    if (!Array.isArray(data?.denied) || !Array.isArray(data?.removed)) continue;
    return { denied: data.denied.filter((x): x is Group => typeof x === "string"), removed: data.removed.filter((x): x is string => typeof x === "string") };
  }
  return undefined;
}

type SessionManagerLike = AgentSession["sessionManager"];

/** Where pi says a tool comes from when marcsh's inline MCP extension (see `createMarcshMcpExtension`) registered it. */
const MCP_SOURCE = "<inline:marcsh-mcp>";

/** Task, AskUserQuestion and the tools of marcsh's MCP extension: the ones marcsh itself offers by default. A name alone proves nothing. */
function isMarcshOwned(tool: ToolSource): boolean {
  return isMarcshTask(tool) || isMarcshAskUser(tool) || tool.sourceInfo.path === MCP_SOURCE;
}

/**
 * Takes the tools of the denied groups (an agent's `tools` field, S15) away from a session: they leave the active tools, are not
 * declared to the model, and a call to one is blocked with a reason, without asking. It only ever narrows (the names in `restore`, which
 * an earlier agent's narrowing took away and which were not registered yet when the session started, come back once marcsh's own
 * tools (Task, AskUserQuestion, MCP) register under them; then the denial is applied on top). It is loaded twice: before the
 * approval extension, so a denied call is blocked before anything is asked, and after it, because plan mode's own handler there
 * sets the active tools to every read-only tool and would otherwise put a denied one back.
 */
export function createDeniedToolsExtension(
  denied: readonly Group[],
  { restore = [], onRemoved }: { restore?: readonly string[]; onRemoved?: (names: string[]) => void } = {},
): ExtensionFactory {
  return (pi) => {
    const isDenied = (name: string) => isPiToolDenied(name, denied);
    // A tool that registers late (an MCP server that connects after the session started) comes back when it shows up, if marcsh registered it.
    // `restore` is read on first use: the turn fills it in after the session exists and before any extension runs.
    let pending: Set<string> | undefined;
    pi.on("tool_call", (event) => (isDenied(event.toolName) ? { block: true, reason: notAvailableReason(event.toolName) } : undefined));
    const narrow = () => {
      let active = pi.getActiveTools();
      pending ??= new Set(restore);
      if (pending.size > 0) {
        const owned = new Set(pi.getAllTools().filter(isMarcshOwned).map((tool) => tool.name));
        const back = [...pending].filter((name) => owned.has(name));
        for (const name of back) pending.delete(name);
        active = [...new Set([...active, ...back])];
      }
      const removed = active.filter(isDenied);
      if (removed.length > 0) onRemoved?.(removed);
      pi.setActiveTools(active.filter((name) => !isDenied(name)));
    };
    pi.on("before_agent_start", narrow);
    pi.on("turn_start", narrow);
    // The first turn declares its tools before `turn_start` runs: the model is shown only the tools that are active when the request goes out.
    pi.on("context_with_system", (event) => {
      const active = new Set(pi.getActiveTools());
      return {
        messages: event.messages.map((message) =>
          message.role === "system" && message.toolsAdded ? { ...message, toolsAdded: message.toolsAdded.filter((tool) => active.has(tool.name)) } : message,
        ),
      };
    });
  };
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

function userText(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((block: { type?: string; text?: unknown }) => (block.type === "text" && typeof block.text === "string" ? block.text : "")).join("");
}

/** The items of `before` that `after` no longer holds (one for one, so equal texts are told apart by count). */
function taken(before: readonly string[], after: readonly string[]): string[] {
  const left = [...after];
  return before.filter((text) => {
    const at = left.indexOf(text);
    if (at === -1) return true;
    left.splice(at, 1);
    return false;
  });
}

/**
 * pi lists the messages it has queued (`queue_update`) and drops one from that list just before the user message it
 * sends starts. The tracker tells the host what is still waiting and, when such a message starts, which kind it was.
 * The first user message of a turn is the prompt, which was never queued, so it matches nothing.
 */
export function createQueueTracker() {
  let steering: readonly string[] = [];
  let followUp: readonly string[] = [];
  const sent: Array<{ kind: "steer" | "followUp"; text: string }> = [];

  return {
    /** Feeds one session event; returns what the host should hear about the queues, if anything. */
    observe(event: AgentSessionEvent): EngineEvent | null {
      if (event.type === "queue_update") {
        sent.push(
          ...taken(steering, event.steering).map((text) => ({ kind: "steer" as const, text })),
          ...taken(followUp, event.followUp).map((text) => ({ kind: "followUp" as const, text })),
        );
        steering = event.steering;
        followUp = event.followUp;
        return { type: "queue", steering: [...steering], followUp: [...followUp] };
      }
      if (event.type === "message_start" && event.message.role === "user") {
        const text = userText(event.message);
        const at = sent.findIndex((item) => item.text === text);
        if (at === -1) return null;
        const [item] = sent.splice(at, 1);
        return { type: "delivered", text, kind: item!.kind };
      }
      return null;
    },
    /** Forgets what was sent but not yet started (the queues were cleared). */
    reset() {
      sent.length = 0;
    },
  };
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
  // A pack agent's view (only its skills and commands, see packs.ts) is added for the turns that agent answers, never to warm-up.
  const resourcesFor = (packView?: string) => {
    const templates = pluginPath ? [join(pluginPath, "commands")] : [];
    const skills = pluginPath ? [join(pluginPath, "skills")] : [];
    for (const [list, part] of [[templates, "commands"], [skills, "skills"]] as const) {
      if (packView && existsSync(join(packView, part))) list.push(join(packView, part));
    }
    return templates.length > 0 || skills.length > 0 ? { additionalPromptTemplatePaths: templates, additionalSkillPaths: skills } : {};
  };
  const pluginResources = resourcesFor();
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

  function startTurn({ prompt, cwd, mode, model, systemPromptAppend, packPluginPath, deniedTools, resumeRef, signal }: TurnRequest, host: TurnHost): EngineTurn {
    const startedAt = Date.now();
    // The groups the selected agent does not get: they narrow the mode's tools (plan mode can only get narrower), never widen them.
    const denied = deniedTools ?? [];
    const allowed = (name: string) => !isPiToolDenied(name, denied);
    // What this turn took away, by name, for the record the next turn reads (see NARROWING_ENTRY).
    const removedNow = new Set<string>();
    const removedBy = (names: readonly string[]) => names.forEach((name) => removedNow.add(name));
    // A child session starts clean: it gets the denial, never the parent's restore.
    const denyingChild = denied.length > 0 ? [createDeniedToolsExtension(denied)] : [];
    let session: AgentSession | undefined;
    let previous: Narrowing | undefined;
    let aborted = signal.aborted;
    // Aborts when the turn is interrupted or over: pending approvals are then declined.
    const turnEnded = new AbortController();
    // Streamed text reaches the host at most ~30 times a second; the feed is closed (queue sent, timer gone) when the turn ends.
    const feed = createReplyFeed((event) => host.emit(event));
    const queue = createQueueTracker();
    // Typed before the prompt reached pi: held until it did, in the order typed. Each entry's promise settles when pi took the text
    // or, if the turn ends first (startup failed, interrupted), rejects so the host can give the text back to the user.
    let promptSent = false;
    const early: Array<{ kind: "steer" | "followUp"; text: string; resolve: () => void; reject: (error: Error) => void }> = [];
    // pi's own frontmatter reader, once pi is loaded: a steer or follow-up expands the plugin's `/marcsh:...` like a prompt does.
    let stripFrontmatter: ((content: string) => string) | undefined;
    // What pi was sent in place of what the user typed (`/marcsh:feature x` expands), so the transcript shows what was typed.
    const typedAs = new Map<string, string>();
    const asTyped = (text: string) => typedAs.get(text) ?? text;
    const announceQueue = (steering: readonly string[], followUp: readonly string[]) =>
      host.emit({ type: "queue", steering: steering.map(asTyped), followUp: followUp.map(asTyped) });
    // The held text is shown as pending like the text pi has queued.
    const showEarly = () =>
      announceQueue(
        early.filter((entry) => entry.kind === "steer").map((entry) => entry.text),
        early.filter((entry) => entry.kind === "followUp").map((entry) => entry.text),
      );
    const refuseEarly = (reason: string) => {
      const refused = early.splice(0);
      if (refused.length === 0) return;
      for (const entry of refused) entry.reject(new Error(reason));
      showEarly();
    };
    // Set once pi has settled (its prompt resolved and nothing is queued): the session shutdown that follows can take seconds,
    // and a steer or follow-up accepted then would be shown as pending and never sent.
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      host.emit({ type: "input-closed" });
    };

    const interrupt = () => {
      aborted = true;
      turnEnded.abort();
      feed.flush();
      // Messages pi has not sent are discarded, never run after the response is stopped; text pi never got is given back to the user.
      refuseEarly("The turn was interrupted before the message was sent.");
      session?.clearQueue();
      queue.reset();
      void session?.abort();
    };
    signal.addEventListener("abort", interrupt, { once: true });

    // Provider errors can echo the key or token that was sent, so nothing reaches the UI unredacted.
    const fail = (message: string) => {
      if (!aborted) host.emit({ type: "error", message: redactSecrets(friendlyPiError(message)) });
    };

    const queueInput = async (kind: "steer" | "followUp", text: string): Promise<void> => {
      if (aborted) return;
      if (settled) throw new TurnClosedError();
      if (!session || !promptSent) {
        await new Promise<void>((resolve, reject) => {
          early.push({ kind, text, resolve, reject });
          showEarly();
        });
        return;
      }
      // Like a prompt, `/marcsh:...` is expanded here; pi expands its own templates and skills and refuses extension commands.
      const sent = expandPluginInvocation(text, pluginPath, stripFrontmatter!);
      if (sent !== text) typedAs.set(sent, text);
      await (kind === "steer" ? session.steer(sent) : session.followUp(sent));
      // An interrupt that came while pi was taking the text cleared the queues before it was in them.
      if (aborted) session.clearQueue();
      // pi settled while it was taking the text: nothing is left to send it.
      else if (settled) {
        session.clearQueue();
        throw new TurnClosedError();
      }
    };

    // Writes what this turn's agent took away to the session, when it differs from what the last record says (see NARROWING_ENTRY).
    // A record that is not written (the process died first) only means the next turn undoes nothing, as before S15.
    const recordNarrowing = () => {
      if (!session) return;
      try {
        const same = previous !== undefined && sameGroups(previous.denied, denied);
        const registered = new Set(session.getAllTools().map((tool) => tool.name));
        // Names an earlier narrowing took away and this turn could not put back yet (not registered) stay on the record.
        const carried = previous ? previous.removed.filter((name) => same || !registered.has(name)) : [];
        const removed = [...new Set([...removedNow, ...carried])].sort();
        const unchanged = previous ? same && sameGroups(removed, [...previous.removed].sort()) : denied.length === 0;
        if (!unchanged) session.sessionManager.appendCustomEntry(NARROWING_ENTRY, { denied, removed } satisfies Narrowing);
      } catch {}
    };

    const run = async () => {
      process.env[AGENT_DIR_ENV] = agentDir;
      prepareAgentDir();
      const pi = await loadPi();
      stripFrontmatter = pi.stripFrontmatter;
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
      // Only what marcsh itself narrowed on an earlier turn of this conversation is undone, and only when this turn's agent narrows differently.
      previous = sessionManager && lastNarrowing(sessionManager);
      const restore = mode !== Mode.PLAN && previous && !sameGroups(previous.denied, denied) ? previous.removed : [];
      // The recorded names that are not registered when the session starts (MCP's connect later); filled in below, before any extension runs.
      const restoreLater: string[] = [];
      const denying = denied.length > 0 || restore.length > 0 ? [createDeniedToolsExtension(denied, { restore: restoreLater, onRemoved: removedBy })] : [];
      const approval = {
        cwd,
        host,
        rules: options.permissionRules ?? getStorage(),
        signal: turnEnded.signal,
        planMode: mode === Mode.PLAN,
        guard: options.guard,
      };
      // The pack's hooks are checked against what the user approved before anything of the view loads (S16): changed hooks are dropped for
      // this turn. Enabled ones run (PreToolUse and PostToolUse only) ahead of the approval extension, so a call they block never asks.
      const packTurn = packPluginPath ? prepareViewForTurn(packPluginPath) : undefined;
      if (packTurn?.warning) host.notify?.(packTurn.warning, "warning");
      const packHooks = packTurn?.hooks
        ? [createPackHooksExtension({ config: packTurn.hooks.config, view: packPluginPath!, cwd, signal: turnEnded.signal, notify: (message, level) => host.notify?.(message, level) })]
        : [];
      const resourceLoader = new pi.DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        ...resourcesFor(packTurn?.view ?? undefined),
        // Added to whatever APPEND_SYSTEM.md pi found; `appendSystemPrompt` would replace it. A fresh loader per turn is why a switched agent applies from the next turn.
        ...(systemPromptAppend ? { appendSystemPromptOverride: (base: string[]) => [...base, systemPromptAppend] } : {}),
        extensionFactories: [
          // MCP tools are ordinary non-built-in tools: loaded before the approval extension, so its handler still runs last.
          createMarcshMcpExtension(pi.createMcpExtension, agentDir, await importLoadMcpConfig()),
          ...denying,
          ...packHooks,
          createApprovalExtension(approval),
          ...denying,
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
                extensions: [...denyingChild, ...packHooks, createApprovalExtension(approval), ...denyingChild],
                ...(mode === Mode.PLAN ? { tools: READ_ONLY_TOOLS.filter(allowed) } : buildToolsOption(settingsManager)),
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
        ...(mode === Mode.PLAN ? { tools: [...READ_ONLY_TOOLS, ASK_USER_TOOL, TASK_TOOL].filter(allowed) } : buildToolsOption(settingsManager)),
      }));
      // The allow-list is by name, so an extension tool called `read` would pass it: keep only pi's own and marcsh's.
      if (mode === Mode.PLAN) {
        const planTools = session.getAllTools().filter(runsUnasked).map((tool) => tool.name);
        removedBy(planTools.filter((name) => !allowed(name)));
        session.setActiveToolsByName(planTools.filter(allowed));
      } else {
        const freshTools = () => newSessionTools(pi, session!, { cwd, agentDir, models, model: resolved, projectTrusted });
        let fresh: string[] | undefined;
        // pi gives a resumed session the tools of its last turn: after a plan turn a build turn sets them again.
        if (resumeRef && restoredPlanTools(session)) {
          fresh = await freshTools();
          session.setActiveToolsByName(fresh);
        }
        // The tools an earlier agent's narrowing took away come back, now and before any extension adjusts the active tools (so one that
        // turns a tool off still wins). The record is only a list of names: a name comes back only when a new unrestricted session would
        // offer it (pi's own tools under the current `defaultTools`, extension tools that are active by default) or marcsh owns the tool.
        // The ones not registered yet (MCP's) are left to the extension, which restores them if marcsh's MCP registers them.
        if (restore.length > 0) {
          const registered = new Map(session.getAllTools().map((tool) => [tool.name, tool]));
          const offered = new Set(fresh ?? (await freshTools()));
          const comeBack = restore.filter((name) => {
            const tool = registered.get(name);
            return allowed(name) && tool !== undefined && (offered.has(name) || isMarcshOwned(tool));
          });
          restoreLater.push(...restore.filter((name) => allowed(name) && !registered.has(name)));
          session.setActiveToolsByName([...new Set([...session.getActiveToolNames(), ...comeBack])]);
        }
        if (denied.length > 0) {
          const active = session.getActiveToolNames();
          removedBy(active.filter((name) => !allowed(name)));
          session.setActiveToolsByName(active.filter(allowed));
        }
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
        // Text and thinking show as they stream; the finished message and the tool results replace and follow them at once.
        if (isStreamDelta(event)) feed.push((reply) => applyPiEvent(reply, event));
        else if (event.type === "message_end" || event.type === "tool_execution_end") feed.emitNow((reply) => applyPiEvent(reply, event));
        const queued = queue.observe(event);
        if (queued) {
          // What was streamed so far belongs to the reply before the message that was just sent.
          if (queued.type === "delivered") feed.flush();
          if (queued.type === "queue") announceQueue(queued.steering, queued.followUp);
          else if (queued.type === "delivered") host.emit({ ...queued, text: asTyped(queued.text) });
          else host.emit(queued);
        }
      });
      if (session.sessionFile) host.emit({ type: "session", ref: session.sessionFile });

      try {
        // pi expands templates and skills and runs extension commands itself: `/name args` goes to it as typed,
        // except the plugin's `/marcsh:...`, which is expanded here and then sent as plain text.
        const expanded = expandPluginInvocation(prompt, pluginPath, pi.stripFrontmatter);
        const sending = session.prompt(expanded, expanded === prompt ? undefined : { expandPromptTemplates: false });
        promptSent = true;
        for (const entry of early.splice(0)) {
          queueInput(entry.kind, entry.text).then(entry.resolve, (error: unknown) => {
            entry.reject(error instanceof TurnClosedError ? error : new Error(redactSecrets(friendlyPiError(error instanceof Error ? error.message : String(error)))));
            // pi never queued it: show what it does hold, not the held text.
            if (!aborted && !settled && session) announceQueue(session.getSteeringMessages(), session.getFollowUpMessages());
          });
        }
        await sending;
        await session.waitForIdle();
        // A message typed as the run was ending was queued too late for pi to pick it up: it runs as a turn of its own
        // (a follow-up still unsent when pi goes idle is sent the same way, not lost).
        while (!aborted && session.pendingMessageCount > 0) {
          const { steering, followUp } = session.clearQueue();
          for (const text of [...steering, ...followUp]) {
            if (aborted) break;
            await session.prompt(text, { expandPromptTemplates: false });
            await session.waitForIdle();
          }
        }
      } finally {
        recordNarrowing();
        settle();
        feed.close();
        host.emit({ type: "reply", update: (reply) => withDuration(reply, Date.now() - startedAt) });
      }

      const failure = errors.flush();
      if (failure) fail(failure);
    };

    const done = run()
      .catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        signal.removeEventListener("abort", interrupt);
        settle();
        // The turn is over and pi never got these: the host gives them back.
        refuseEarly("The turn ended before the message was sent.");
        turnEnded.abort();
        feed.close();
        // Tells the extensions the session is over (MCP closes its servers then) before pi's dispose drops them.
        return disposePiSession(session);
      });

    return {
      done,
      interrupt,
      steer: (text) => queueInput("steer", text),
      followUp: (text) => queueInput("followUp", text),
    };
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
