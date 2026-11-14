import type { AgentSession, InlineExtension, ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ChatMessage, MessagePart } from "../chat-types";
import type { BackgroundHub } from "../background/hub";
import { subagentsFor } from "../background/session-subagents";
import { buildSubagentResult, MAX_RUNNING_SUBAGENTS, type BackgroundSubagents, type SubagentRunContext, type SubagentSnapshot } from "../background/subagents";
import { formatElapsed } from "../background/terminals";
import { friendlyPiError, redactSecrets } from "./pi-auth";
import { createErrorTracker } from "./pi-events";
import { disposePiSession } from "./pi-mcp";
import type { ToolSource } from "./pi-permissions";
import { isBackgroundCall, runWithToolTimeout, TOOL_CALL_TIMEOUT_MS, ToolCallTimeoutError, type ToolClock } from "./pi-tool-timeout";
import type { TurnHost } from "./types";

export const TASK_TOOL = "Task";
/** The tools that look after background subagents. */
export const TASK_TOOLS = ["task_wait", "task_check", "task_cancel", "task_list"] as const;
/** The task tools plan mode offers: they only read or wait (plan mode stops nothing). */
export const TASK_PLAN_TOOLS = ["task_wait", "task_check", "task_list"] as const;
/** The longest a `task_wait` waits, under the 3 minutes a foreground call may run. */
export const MAX_TASK_WAIT_MS = 170_000;
const DEFAULT_TASK_WAIT_S = 120;
const TASK_EXTENSION = "marcsh-subagent";
/** Where pi says a tool comes from when an inline extension named `marcsh-subagent` registered it. */
const TASK_SOURCE = `<inline:${TASK_EXTENSION}>`;

const INTERRUPTED = "The subagent was interrupted.";
const NO_TEXT = "The subagent finished without returning any text.";
const INVALID_INPUT = "Invalid Task input. Pass `description` (3-5 words) and `prompt` (what the subagent should do), both non-empty strings.";
const MAX_SUMMARY = 280;

/**
 * Whether pi's tool is marcsh's own `Task`. The name alone proves nothing: an extension can register a
 * tool with it. The tool must come from marcsh's own extension.
 */
export function isMarcshTask(tool: ToolSource): boolean {
  return tool.name === TASK_TOOL && tool.sourceInfo.path === TASK_SOURCE;
}

/** Whether pi's tool is one of marcsh's own task_* tools: by name and by marcsh's own extension. */
export function isMarcshTaskTool(tool: ToolSource): boolean {
  return (TASK_TOOLS as readonly string[]).includes(tool.name) && tool.sourceInfo.path === TASK_SOURCE;
}

type TaskPart = Extract<MessagePart, { type: "task" }>;

/** Merges changes into the task's part, creating it when unknown; returns the same reply when nothing changes. */
export function upsertTask(reply: ChatMessage, taskId: string, changes: Partial<Omit<TaskPart, "type" | "taskId">>): ChatMessage {
  const defined = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
  const index = reply.parts.findIndex((part) => part.type === "task" && part.taskId === taskId);
  const existing = reply.parts[index];

  if (!existing || existing.type !== "task") {
    const created: TaskPart = { type: "task", taskId, description: "", status: "running", ...defined };
    return { ...reply, parts: [...reply.parts, created] };
  }

  if (Object.entries(defined).every(([key, value]) => existing[key as keyof TaskPart] === value)) return reply;
  return { ...reply, parts: reply.parts.map((part, i): MessagePart => (i === index ? { ...existing, ...defined } : part)) };
}

/** What the child has done so far, for the task line. */
export type ChildProgress = { lastToolName?: string; toolUses: number; totalTokens: number };

/** What a finished child reports: its final text and what it used. */
export type ChildRun = ChildProgress & { text: string; costUsd: number };

export type RunChild = (request: {
  prompt: string;
  /** Aborts when the turn is interrupted or over, when pi aborts the Task call, or when the call runs too long. */
  signal: AbortSignal;
  onProgress(progress: ChildProgress): void;
  /** Each event of the child session (the live transcript of a background child). */
  onEvent?(event: AgentSessionEvent): void;
  /**
   * A foreground child's call clock: the child's ask host holds it while an approval waits for the user (the returned function
   * releases it), so the time the user takes to answer does not count toward the call's timeout.
   */
  holdClock?: () => () => void;
}) => Promise<ChildRun>;

/** Runs a background child: it is not bound to the turn, and its approvals go to the session's ask channel. */
export type BackgroundRunChild = (request: { description: string; prompt: string } & SubagentRunContext) => Promise<ChildRun>;

export type BackgroundSubagentOptions = {
  /** The session's hub: its subagents (`subagentsFor`) and where their results go. */
  hub: BackgroundHub;
  runChild: BackgroundRunChild;
  /** Whether `Task` may start one (not in plan mode). The task tools are offered either way. */
  canStart: boolean;
  /** The longest a `task_wait` waits. Default: `MAX_TASK_WAIT_MS`. */
  maxWaitMs?: number;
};

export type SubagentOptions = {
  host: Pick<TurnHost, "emit">;
  /** Aborts when the turn ends. */
  signal: AbortSignal;
  runChild: RunChild;
  /** How long a foreground call may run before the child is aborted. Default: `TOOL_CALL_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Background subagents (a turn with a background hub only): `Task` takes `background`, and the task tools are offered. */
  background?: BackgroundSubagentOptions;
};

/** The child's text as one short line for the task line. */
function summarize(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > MAX_SUMMARY ? `${line.slice(0, MAX_SUMMARY - 1)}…` : line;
}

function parseTaskInput(params: unknown): { description: string; prompt: string } {
  const { description, prompt } = (params ?? {}) as Record<string, unknown>;
  if (typeof description !== "string" || typeof prompt !== "string" || !description.trim() || !prompt.trim()) throw new Error(INVALID_INPUT);
  return { description: description.trim(), prompt };
}

const baseProperties = {
  description: { type: "string", description: "A short (3-5 words) description of the task." },
  prompt: { type: "string", description: "The task for the subagent to perform. It starts with no memory of this conversation, so include everything it needs." },
};

const parametersFor = (background: boolean) =>
  ({
    type: "object",
    properties: background
      ? {
          ...baseProperties,
          background: {
            type: "boolean",
            description:
              "Run it in the background: the call returns an id at once and the subagent keeps working. Its result is delivered to you when it " +
              "finishes; task_wait collects it sooner, task_check peeks, task_cancel stops it.",
          },
        }
      : baseProperties,
    required: ["description", "prompt"],
  }) as unknown as ToolDefinition["parameters"];

const toolText = (value: string, details: unknown) => ({ content: [{ type: "text" as const, text: value }], details });

const NO_BACKGROUND = "Background subagents are not available here. Run the Task without `background`.";

export function createTaskTool({ host, signal: turnEnded, runChild, timeoutMs = TOOL_CALL_TIMEOUT_MS, background }: SubagentOptions): ToolDefinition {
  const canStart = background?.canStart === true;
  return {
    name: TASK_TOOL,
    label: "Subagent task",
    description:
      "Launch a subagent to handle a self-contained task, such as researching or exploring the codebase, and get back its final " +
      "answer. The subagent works on its own with the same tools and permissions as you but does not see this conversation, " +
      "so give it a complete prompt. It cannot start further subagents. Launch several in one message to run them in parallel." +
      (canStart ? ` Pass \`background: true\` for long work: at most ${MAX_RUNNING_SUBAGENTS} background subagents run at once.` : ""),
    promptSnippet: "Launch a subagent for a self-contained task and get its final answer",
    parameters: parametersFor(canStart),
    async execute(toolCallId, params, toolSignal) {
      const { description, prompt } = parseTaskInput(params);
      const signal = toolSignal ? AbortSignal.any([toolSignal, turnEnded]) : turnEnded;
      if (signal.aborted) throw new Error(INTERRUPTED);

      if (isBackgroundCall(params)) {
        // Only a turn that can start one: never headless, a child session, or plan mode. Never run as an untimed foreground call.
        if (!background || !canStart) throw new Error(NO_BACKGROUND);
        // Not bound to the turn or the call: it runs until it ends, is cancelled, or the session is left. Throws at the cap.
        const snapshot = subagentsFor(background.hub).start({ description, prompt, run: (context) => background.runChild({ description, prompt, ...context }) });
        return toolText(
          `Started background subagent ${snapshot.id} "${description}". Its result is delivered to you when it finishes. ` +
            `Use task_wait to wait for it, task_check to peek, task_cancel to stop it.`,
          { id: snapshot.id, background: true },
        );
      }

      const update = (changes: Partial<Omit<TaskPart, "type" | "taskId">>) =>
        host.emit({ type: "reply", update: (reply) => upsertTask(reply, toolCallId, changes) });

      update({ description, status: "running" });
      const start = (childSignal: AbortSignal, clock: ToolClock) =>
        runChild({ prompt, signal: childSignal, onProgress: (progress) => update(progress), holdClock: () => clock.hold() });
      let run: ChildRun;
      try {
        // A foreground call is aborted once it runs too long (a background one returned above, untimed); waiting for the user does not count.
        run = await runWithToolTimeout(TASK_TOOL, timeoutMs, signal, start, { background: canStart });
      } catch (error) {
        if (signal.aborted) {
          update({ status: "stopped" });
          throw new Error(INTERRUPTED);
        }
        if (error instanceof ToolCallTimeoutError) {
          update({ status: "failed", error: error.message });
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        update({ status: "failed", error: message });
        throw new Error(message);
      }
      // A child that finished as the abort arrived did not complete its work for the user.
      if (signal.aborted) {
        update({ status: "stopped" });
        throw new Error(INTERRUPTED);
      }

      update({ status: "completed", summary: summarize(run.text), toolUses: run.toolUses, totalTokens: run.totalTokens });
      if (run.costUsd > 0) {
        host.emit({
          type: "reply",
          update: (reply) => ({ ...reply, metadata: { ...reply.metadata, costUsd: (reply.metadata?.costUsd ?? 0) + run.costUsd } }),
        });
      }
      return { content: [{ type: "text", text: run.text || NO_TEXT }], details: { taskId: toolCallId } };
    },
  };
}

const unknownSubagent = (id: string, known: BackgroundSubagents) =>
  new Error(`Unknown subagent id "${id}". Known: ${known.list().map((snapshot) => snapshot.id).join(", ") || "none"}.`);

const MAX_CHECK_TEXT = 4_000;

/** One line per subagent: id, status, description, runtime and usage. */
function describeSubagent(snapshot: SubagentSnapshot): string {
  const cost = snapshot.costUsd > 0 ? ` · $${snapshot.costUsd.toFixed(2)}` : "";
  return `${snapshot.id} [${snapshot.status}] "${snapshot.description}" · ${formatElapsed(snapshot)} · ${snapshot.toolUses} tool uses · ${snapshot.totalTokens} tokens${cost}`;
}

function parseIds(params: unknown): string[] {
  const raw = (params as { ids?: unknown } | undefined)?.ids;
  const ids = [...new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [])];
  if (ids.length === 0) throw new Error("Pass at least one subagent id in ids.");
  return ids;
}

/** The task tools for this session's background subagents. Only its own ids are known; a result a tool reports is collected (never announced). */
function createTaskTools({ hub, maxWaitMs = MAX_TASK_WAIT_MS }: BackgroundSubagentOptions, turnEnded: AbortSignal): ToolDefinition[] {
  const subagents = () => subagentsFor(hub);
  const known = (ids: readonly string[]) => {
    const missing = ids.find((id) => !subagents().get(id));
    if (missing) throw unknownSubagent(missing, subagents());
    return ids.map((id) => subagents().get(id)!);
  };
  // The hub may have handed a result to a sink already: the tool still shows it, so it is never lost (see `hub.consume`).
  const collect = (snapshots: readonly SubagentSnapshot[]) => {
    hub.consume(snapshots.filter((snapshot) => snapshot.status !== "running").map((snapshot) => snapshot.id));
    return snapshots.map((snapshot) => (snapshot.status === "running" ? `${describeSubagent(snapshot)}\nIt is still running.` : buildSubagentResult(snapshot)));
  };

  const wait: ToolDefinition = {
    name: "task_wait",
    label: "Wait for background subagents",
    description:
      "Wait until these background subagents finish, then get their results (they are not delivered again). Returns early after " +
      `\`timeout\` seconds (default ${DEFAULT_TASK_WAIT_S}, at most ${Math.floor(maxWaitMs / 1000)}) with those still running marked so.`,
    parameters: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: 'The subagent ids, e.g. ["sa-1"].' },
        timeout: { type: "number", description: `Seconds to wait at most (default ${DEFAULT_TASK_WAIT_S}).` },
      },
      required: ["ids"],
      additionalProperties: false,
    } as never,
    async execute(_toolCallId, params, toolSignal) {
      const snapshots = known(parseIds(params));
      const asked = (params as { timeout?: unknown } | undefined)?.timeout;
      const seconds = typeof asked === "number" && Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_TASK_WAIT_S;
      const ms = Math.min(seconds * 1000, maxWaitMs);
      const signal = toolSignal ? AbortSignal.any([toolSignal, turnEnded]) : turnEnded;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      // Each one is collected the moment it settles: the hub would otherwise announce an early one while this call waits for the rest.
      let waiting = true;
      const settledNow = snapshots.map((snapshot) =>
        subagents()
          .settled(snapshot.id)
          .then(() => {
            if (waiting) hub.consume([snapshot.id]);
          }),
      );
      try {
        await Promise.race([
          Promise.all(settledNow),
          new Promise<void>((resolve) => (timer = setTimeout(resolve, ms))),
          new Promise<void>((resolve) => {
            if (signal.aborted) return resolve();
            onAbort = resolve;
            signal.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
      } finally {
        waiting = false;
        clearTimeout(timer);
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
      return toolText(collect(snapshots).join("\n\n"), { ids: snapshots.map((snapshot) => snapshot.id), statuses: snapshots.map((snapshot) => snapshot.status) });
    },
  };

  const check: ToolDefinition = {
    name: "task_check",
    label: "Check background subagent",
    description: "Peek at a background subagent: its status, usage and latest text so far. It collects nothing: a finished result is still delivered.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: 'The subagent id, e.g. "sa-1".' } },
      required: ["id"],
      additionalProperties: false,
    } as never,
    async execute(_toolCallId, params) {
      const id = String((params as { id?: unknown } | undefined)?.id ?? "");
      const [snapshot] = known([id]);
      const text = snapshot!.text.length > MAX_CHECK_TEXT ? `…${snapshot!.text.slice(-MAX_CHECK_TEXT)}` : snapshot!.text;
      const latest = text ? `\n${snapshot!.status === "running" ? "Latest text so far" : "Its text"}:\n${text}` : "";
      const error = snapshot!.error ? `\nError: ${snapshot!.error}` : "";
      return toolText(`${describeSubagent(snapshot!)}${error}${latest}`, { id, status: snapshot!.status });
    },
  };

  const cancel: ToolDefinition = {
    name: "task_cancel",
    label: "Stop background subagents",
    description: "Stop these background subagents and get what they had (they are not delivered again).",
    parameters: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" }, description: 'The subagent ids to stop, e.g. ["sa-1"].' } },
      required: ["ids"],
      additionalProperties: false,
    } as never,
    async execute(_toolCallId, params) {
      const ids = known(parseIds(params)).map((snapshot) => snapshot.id);
      // Like task_wait: each one is collected the moment it settles, or the hub would announce an early one while this call waits for the rest.
      let waiting = true;
      for (const id of ids) {
        void subagents()
          .settled(id)
          .then(() => {
            if (waiting) hub.consume([id]);
          });
      }
      let snapshots: SubagentSnapshot[];
      try {
        snapshots = await subagents().cancel(ids);
      } finally {
        waiting = false;
      }
      return toolText(collect(snapshots).join("\n\n"), { ids, statuses: snapshots.map((snapshot) => snapshot.status) });
    },
  };

  const list: ToolDefinition = {
    name: "task_list",
    label: "List background subagents",
    description: "List this session's background subagents with their status, runtime and usage.",
    parameters: { type: "object", properties: {}, additionalProperties: false } as never,
    async execute() {
      const all = subagents().list();
      return toolText(all.length === 0 ? "No background subagents." : all.map(describeSubagent).join("\n"), {
        subagents: all.map((snapshot) => ({ id: snapshot.id, description: snapshot.description, status: snapshot.status })),
      });
    },
  };

  return [wait, check, cancel, list];
}

/** `Task`, plus the task tools when the turn has background subagents. */
export function createSubagentTools(options: SubagentOptions): ToolDefinition[] {
  return [createTaskTool(options), ...(options.background ? createTaskTools(options.background, options.signal) : [])];
}

/** The named inline extension that offers the tools, so pi's tool list says they are marcsh's. */
export function createSubagentExtension(options: SubagentOptions): InlineExtension {
  return {
    name: TASK_EXTENSION,
    hidden: true,
    factory: (pi) => {
      for (const tool of createSubagentTools(options)) pi.registerTool(tool);
    },
  };
}

type PiModule = typeof import("@earendil-works/pi-coding-agent");

export type ChildSessionOptions = {
  cwd: string;
  agentDir: string;
  models: ModelRuntime;
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
  /** Whether the project's own settings and files load: the parent turn's trust (S18). Default: untrusted. */
  projectTrusted?: boolean;
  /** The inline extensions the child loads: marcsh's approval extension, bound to the parent turn's host. No others load. */
  extensions: InlineExtension[];
  /** Restricts the child's active tools by name (plan mode), or `+name` entries added to the defaults; default: pi's defaults. */
  tools?: string[];
  prompt: string;
  signal: AbortSignal;
  onProgress(progress: ChildProgress): void;
  /** Each event of the child session, for a live transcript. */
  onEvent?(event: AgentSessionEvent): void;
};

/** The text of an assistant message's text blocks. */
function assistantText(message: { content?: unknown }): string {
  const content = Array.isArray(message.content) ? (message.content as { type?: string; text?: string }[]) : [];
  return content.map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : "")).join("");
}

/**
 * Runs one child pi session in this process and resolves with its final assistant text. The child has the
 * parent turn's directory, agent dir, models and model, an in-memory session (no file), and only the
 * extensions it is given: no user extensions, no MCP, no `Task`. Aborting `signal` aborts the child.
 * Rejects with the child's (redacted) error.
 */
export async function runChildSession(pi: PiModule, options: ChildSessionOptions): Promise<ChildRun> {
  const { cwd, agentDir, signal } = options;
  const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: options.projectTrusted ?? false });
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: options.extensions,
  });
  await resourceLoader.reload();
  if (signal.aborted) throw new Error(INTERRUPTED);

  const { session } = await pi.createAgentSession({
    cwd,
    agentDir,
    modelRuntime: options.models,
    model: options.model,
    sessionManager: pi.SessionManager.inMemory(cwd),
    settingsManager,
    resourceLoader,
    ...(options.tools ? { tools: options.tools } : {}),
  });
  const abort = () => void session.abort();
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await promptChild(session, options);
  } finally {
    signal.removeEventListener("abort", abort);
    await disposePiSession(session);
  }
}

async function promptChild(session: AgentSession, { prompt, signal, onProgress, onEvent }: ChildSessionOptions): Promise<ChildRun> {
  await session.bindExtensions({});
  if (signal.aborted) throw new Error(INTERRUPTED);

  const run: ChildRun = { text: "", toolUses: 0, totalTokens: 0, costUsd: 0 };
  const errors = createErrorTracker();
  let failure: string | null = null;
  session.subscribe((event) => {
    try {
      onEvent?.(event);
    } catch {}
    failure = errors.observe(event) ?? failure;
    if (event.type === "tool_execution_start") {
      run.toolUses += 1;
      run.lastToolName = event.toolName;
      onProgress({ lastToolName: run.lastToolName, toolUses: run.toolUses, totalTokens: run.totalTokens });
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      run.text = assistantText(event.message);
      run.totalTokens += event.message.usage?.totalTokens ?? 0;
      run.costUsd += event.message.usage?.cost?.total ?? 0;
      onProgress({ lastToolName: run.lastToolName, toolUses: run.toolUses, totalTokens: run.totalTokens });
    }
  });

  // The prompt is the model's text, not something the user typed: a leading `/` is not a command.
  await session.prompt(prompt, { expandPromptTemplates: false });
  await session.waitForIdle();
  if (signal.aborted) throw new Error(INTERRUPTED);

  failure = failure ?? errors.flush();
  if (failure) throw new Error(redactSecrets(friendlyPiError(failure)));
  return run;
}
