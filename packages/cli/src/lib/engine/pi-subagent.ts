import type { AgentSession, InlineExtension, ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ChatMessage, MessagePart } from "../chat-types";
import { friendlyPiError, redactSecrets } from "./pi-auth";
import { createErrorTracker } from "./pi-events";
import { disposePiSession } from "./pi-mcp";
import type { ToolSource } from "./pi-permissions";
import { isBackgroundCall, runWithToolTimeout, TOOL_CALL_TIMEOUT_MS, ToolCallTimeoutError } from "./pi-tool-timeout";
import type { TurnHost } from "./types";

export const TASK_TOOL = "Task";
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
}) => Promise<ChildRun>;

export type SubagentOptions = {
  host: Pick<TurnHost, "emit">;
  /** Aborts when the turn ends. */
  signal: AbortSignal;
  runChild: RunChild;
  /** How long a foreground call may run before the child is aborted. Default: `TOOL_CALL_TIMEOUT_MS`. */
  timeoutMs?: number;
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

const parameters = {
  type: "object",
  properties: {
    description: { type: "string", description: "A short (3-5 words) description of the task." },
    prompt: { type: "string", description: "The task for the subagent to perform. It starts with no memory of this conversation, so include everything it needs." },
  },
  required: ["description", "prompt"],
} as unknown as ToolDefinition["parameters"];

export function createTaskTool({ host, signal: turnEnded, runChild, timeoutMs = TOOL_CALL_TIMEOUT_MS }: SubagentOptions): ToolDefinition {
  return {
    name: TASK_TOOL,
    label: "Subagent task",
    description:
      "Launch a subagent to handle a self-contained task, such as researching or exploring the codebase, and get back its final " +
      "answer. The subagent works on its own with the same tools and permissions as you but does not see this conversation, " +
      "so give it a complete prompt. It cannot start further subagents. Launch several in one message to run them in parallel.",
    promptSnippet: "Launch a subagent for a self-contained task and get its final answer",
    parameters,
    async execute(toolCallId, params, toolSignal) {
      const { description, prompt } = parseTaskInput(params);
      const signal = toolSignal ? AbortSignal.any([toolSignal, turnEnded]) : turnEnded;
      if (signal.aborted) throw new Error(INTERRUPTED);

      const update = (changes: Partial<Omit<TaskPart, "type" | "taskId">>) =>
        host.emit({ type: "reply", update: (reply) => upsertTask(reply, toolCallId, changes) });

      update({ description, status: "running" });
      const start = (childSignal: AbortSignal) => runChild({ prompt, signal: childSignal, onProgress: (progress) => update(progress) });
      let run: ChildRun;
      try {
        // A background call is not timed; a foreground one is aborted once it runs too long.
        run = isBackgroundCall(params) ? await start(signal) : await runWithToolTimeout(TASK_TOOL, timeoutMs, signal, start);
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

/** The named inline extension that offers the tool, so pi's tool list says it is marcsh's. */
export function createSubagentExtension(options: SubagentOptions): InlineExtension {
  return {
    name: TASK_EXTENSION,
    hidden: true,
    factory: (pi) => {
      pi.registerTool(createTaskTool(options));
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

async function promptChild(session: AgentSession, { prompt, signal, onProgress }: ChildSessionOptions): Promise<ChildRun> {
  await session.bindExtensions({});
  if (signal.aborted) throw new Error(INTERRUPTED);

  const run: ChildRun = { text: "", toolUses: 0, totalTokens: 0, costUsd: 0 };
  const errors = createErrorTracker();
  let failure: string | null = null;
  session.subscribe((event) => {
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
