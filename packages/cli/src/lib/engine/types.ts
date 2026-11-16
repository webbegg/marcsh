import { modeLine, type ApprovalMode, type LineMode } from "../approval-policy";
import type { BranchSource } from "../git-branch";
import type { AskQuestion } from "../ask-user-question";
import type { Attachment } from "../attachments";
import type { BackgroundHub } from "../background/hub";
import type { Group } from "../tool-names";
import type { ChatMessage } from "../chat-types";
import type { ClaudeCommand } from "../claude-commands";
import type { ModeType } from "../modes";
import type { ProjectTrustAsk, TrustAnswer } from "./pi-trust";

/**
 * "Allow this program under this folder": allows the call, and every later one with the same program whose targets are inside the
 * folder (a path rule, per project). Written `path:<dir>`, so a decision stays a plain string.
 */
export type PathAnswer = `path:${string}`;

export type PermissionDecision = "allow" | "always" | "deny" | PathAnswer;

export const pathAnswer = (dir: string): PathAnswer => `path:${dir}`;

/** The folder of a path answer, or null for any other decision. */
export const pathAnswerDir = (decision: PermissionDecision): string | null => (decision.startsWith("path:") ? decision.slice("path:".length) : null);

/** A tool call the engine wants the user to approve. */
export type PermissionAsk = {
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  /** The ask must not be approvable by one keystroke: no one-key approve, no always-allow. */
  defaultToNo?: boolean;
  suppressAlwaysAllowRule?: boolean;
  /** A shell command made of one path program: the folders (narrowest first) the user may allow it under. Offered even when `suppressAlwaysAllowRule` is set. */
  pathRule?: { program: string; dirs: string[] };
};

export type EngineEvent =
  /** The engine's reference for resuming this session became known. */
  | { type: "session"; ref: string }
  /** Output arrived: fold it into the assistant reply. */
  | { type: "reply"; update: (reply: ChatMessage) => ChatMessage }
  /** The engine's command list for the `/` menu; replaces any cached list. */
  | { type: "commands"; commands: ClaudeCommand[] }
  /** The turn failed with a user-facing message. */
  | { type: "error"; message: string }
  /** The messages the user typed during the turn that the engine has not sent yet (replaces the last list). */
  | { type: "queue"; steering: string[]; followUp: string[] }
  /**
   * A queued message was just sent: the reply so far is complete, and what follows answers this message. A `background` one is a
   * batch of background results (its text is `backgroundMessageText`, see `lib/background/hub.ts`), not something the user typed.
   */
  | { type: "delivered"; text: string; kind: "steer" | "followUp" | "background" }
  /** The engine has settled: the turn takes no more steers or follow-ups, though it may still be shutting down. */
  | { type: "input-closed" };

/** What `steer` and `followUp` reject with once the engine has settled: the text was not taken and nothing will send it. */
export class TurnClosedError extends Error {
  constructor() {
    super("The turn is already over, so the message was not sent.");
    this.name = "TurnClosedError";
  }
}

/** A model with the thinking level it runs at (pi's levels: `off`...`max`; Claude has none). */
export type ModelStep = { model: string; thinking?: string };

/**
 * What the active profile (`lib/profiles.ts`) says about the selected agent's own turn: its `primary` route. `model` is the route's model
 * and `thinking` applies only while the turn runs on it (the user may have picked another model since). `fallback` is the chain to move to
 * when the turn's model fails: pi continues the same conversation on the next model; Claude gets the first as the SDK's `fallbackModel`.
 */
export type TurnRouting = { model?: string; thinking?: string; fallback?: ModelStep[] };

export type TurnRequest = {
  prompt: string;
  /**
   * Files attached to the prompt. Images and PDFs carry their bytes; an engine sends what it can take as input and the rest as `@path`
   * mentions in the prompt, and says so (`host.notify`) when a file it was given goes the second way.
   */
  attachments?: Attachment[];
  cwd: string;
  mode: ModeType;
  model: string;
  /** The selected agent's prompt: added to the engine's own system prompt for this turn, never in place of it. */
  systemPromptAppend?: string;
  /**
   * The session's approval mode: what runs without asking, for the turn and the Task children it starts. Absent: normal, the
   * engine's own flow exactly as before (only catastrophic commands are blocked).
   */
  approvalMode?: ApprovalMode;
  /**
   * Reads the session's approval mode at the moment a tool call is decided, so a switch with /permissions during the turn applies to every
   * later call (also in Task children). Absent: `approvalMode` for the whole turn. `approvalMode` still feeds the system-prompt mode line.
   */
  currentApprovalMode?: () => ApprovalMode;
  /**
   * Nobody answers this turn's asks (headless `marcsh run`): every ask is denied. Normal's mode line says so, for the turn and its children.
   * Absent: someone may approve, as in the TUI.
   */
  noApprover?: boolean;
  /**
   * Reads whether the session is in plan mode now. A background subagent outlives the turn that started it: while this says plan, its
   * calls are blocked like a plan turn's (only the read-only tools run). Absent: the mode the turn started in (`mode`).
   */
  currentPlanMode?: () => boolean;
  /** The selected pack agent's generated plugin view (only its skills and commands): loaded for this turn next to marcsh's own plugin. */
  packPluginPath?: string;
  /** The ID of the agent answering this turn (`build`, `<pack>/<file>`...): what a pack's hooks are told (`agent`, MARCSH_AGENT). */
  agentId?: string;
  /**
   * The tool groups the selected agent does not get this turn. Only ever narrows: the engine removes these tools on top of what the
   * mode already offers, and the tools that are left still ask. Absent: the mode's own tools, exactly as before.
   */
  deniedTools?: Group[];
  /**
   * The named subagents the model may start this turn (pi: `Task` `agent`; Claude: the SDK's `agents`). Each only narrows: its tools are
   * the turn's minus its own denied groups, and a read-only one only reads. Absent: none, and `Task` is exactly as before.
   */
  subagents?: TurnSubagent[];
  /** The active profile's `primary` route for this turn (see {@link TurnRouting}). Absent: no profile, and no fallback. */
  routing?: TurnRouting;
  resumeRef?: string;
  /**
   * What the conversation named by `resumeRef` had cost in all so far. An engine whose reported cost is a running total that a resumed
   * conversation carries over (Claude's) subtracts it, so each reply holds only its own cost.
   */
  priorCostUsd?: number;
  /**
   * The session's background hub: results that finish while the turn runs are sent into it as follow-ups. Only a pi session's
   * screen has one; the Claude engine ignores it and headless `marcsh run` never sets it.
   */
  background?: BackgroundHub;
  /** `background`: the prompt is a batch of background results, sent as it is (no command or template is expanded). */
  promptKind?: "background";
  /** Aborting stops the turn. */
  signal: AbortSignal;
};

/** A named subagent as an engine runs it (see `turnSubagents` in agents.ts). */
export type TurnSubagent = {
  /** How the model addresses it: its file name without `.md`. */
  name: string;
  description?: string;
  /** Appended to the child's system prompt. */
  prompt?: string;
  /** The model it asks for (routed by the active profile, else its own file's); the parent's is used when absent or unusable on the engine. */
  model?: string;
  /** pi only: the thinking level its routed model runs at. */
  thinking?: string;
  /** The models to restart the child on, in order, when `model` fails on a limit, an auth error or a provider error (pi). */
  fallback?: ModelStep[];
  /** `permission: read-only`: the child only reads (plan rules), whatever the parent's mode. */
  readOnly: boolean;
  /** The groups its `tools` field takes away, on top of the parent's. */
  deniedTools?: Group[];
  /** Its pack's plugin view: pi gives the child that pack's skills when they are loaded for the turn. Absent for the user's own. */
  pluginDir?: string;
};

export type CompactRequest = {
  cwd: string;
  model: string;
  /** The engine's reference for the conversation to compact (its `session` event's `ref`). */
  resumeRef: string;
  /** Aborting stops the compaction. */
  signal: AbortSignal;
};

/** What the engine reports of a compaction, each when it knows it. */
export type CompactResult = { tokensBefore?: number; tokensAfter?: number };

export type { LineMode };

/** The line mode of a turn that is not in plan: its approval mode, normal's headless line when nobody approves. */
export const approvalLineMode = (approvalMode: ApprovalMode | undefined, noApprover: boolean | undefined): ApprovalMode | "headless" | undefined =>
  noApprover && approvalMode === "normal" ? "headless" : approvalMode;

/**
 * The text an engine appends to its system prompt: the agent's prompt, then the mode line (`modeLine`, a blank line apart). No mode line
 * when the caller gives no mode; none at all when both are absent. `branch` is read only for auto and yolo.
 */
export function systemPromptWithMode(agentPrompt: string | undefined, mode: LineMode | undefined, branch: BranchSource): string | undefined {
  const line = mode ? modeLine(mode, branch) : undefined;
  return [agentPrompt, line].filter(Boolean).join("\n\n") || undefined;
}

export type NoticeLevel = "info" | "warning" | "error";

/** What the chat offers an engine during a turn. Each ask resolves once; an aborted signal resolves it as declined. */
export type TurnHost = {
  emit(event: EngineEvent): void;
  askPermission(ask: PermissionAsk, signal: AbortSignal): Promise<PermissionDecision>;
  /** Resolves with the answers keyed by question text, or null when the user declines. */
  askQuestions(questions: AskQuestion[], signal: AbortSignal): Promise<Record<string, string> | null>;
  /*
   * Generic asks, for engines whose extensions open their own dialogs (pi). Each resolves once, as cancelled when
   * the user cancels or the signal aborts. A host without them cancels every ask; the Claude engine never uses them.
   */
  /** Resolves with the chosen option, or undefined when cancelled. */
  select?(title: string, options: string[], signal: AbortSignal): Promise<string | undefined>;
  /** Resolves with the answer; false when cancelled. */
  confirm?(title: string, message: string, signal: AbortSignal): Promise<boolean>;
  /** Resolves with the text, or undefined when cancelled. */
  input?(title: string, placeholder: string | undefined, signal: AbortSignal): Promise<string | undefined>;
  /** Resolves with the edited text, or undefined when cancelled. */
  editor?(title: string, prefill: string | undefined, signal: AbortSignal): Promise<string | undefined>;
  /**
   * Before pi loads a project's own files, once per undecided project: resolves with the user's answer ("skip" =
   * untrusted for this turn only). Not an extension dialog; a host without it answers "skip".
   */
  askProjectTrust?(ask: ProjectTrustAsk, signal: AbortSignal): Promise<TrustAnswer>;
  /** A short message for the user that needs no answer. */
  notify?(message: string, level: NoticeLevel): void;
};

export type EngineTurn = {
  /** Settles when the turn ends; rejects when it fails outside a reported `error` event. */
  done: Promise<void>;
  /** Stops the current response and ends the turn. Messages queued but not yet sent are discarded. */
  interrupt(): void;
  /*
   * Typing during a turn. An engine without them takes no input until the turn ends (the chat keeps its input
   * disabled). Each rejects when the engine cannot take the text (`TurnClosedError` once it has settled, see the
   * `input-closed` event); after an interrupt they do nothing.
   */
  /** Sends the text to the running turn, before the model's next response. */
  steer?(text: string): Promise<void>;
  /** Sends the text as a message of its own once the turn has nothing else to do. */
  followUp?(text: string): Promise<void>;
};

export type Engine = {
  id: string;
  startTurn(request: TurnRequest, host: TurnHost): EngineTurn;
  /** Fetches the command list without a model turn; best effort, never throws. */
  warmUpCommands(options: { cwd: string; save: (commands: ClaudeCommand[]) => void }): Promise<void>;
  /**
   * Compacts the context of the conversation `resumeRef` names, outside a turn; rejects with a user-facing message when it cannot.
   * An engine that compacts through a turn of its own prompt (Claude's `/compact`) leaves it out.
   */
  compact?(request: CompactRequest): Promise<CompactResult>;
};
