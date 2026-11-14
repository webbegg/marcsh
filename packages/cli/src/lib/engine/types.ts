import { approvalModeLine, type ApprovalMode } from "../approval-policy";
import { type BranchSource, resolveBranch } from "../git-branch";
import type { AskQuestion } from "../ask-user-question";
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
  /** A queued message was just sent: the reply so far is complete, and what follows answers this message. */
  | { type: "delivered"; text: string; kind: "steer" | "followUp" }
  /** The engine has settled: the turn takes no more steers or follow-ups, though it may still be shutting down. */
  | { type: "input-closed" };

/** What `steer` and `followUp` reject with once the engine has settled: the text was not taken and nothing will send it. */
export class TurnClosedError extends Error {
  constructor() {
    super("The turn is already over, so the message was not sent.");
    this.name = "TurnClosedError";
  }
}

export type TurnRequest = {
  prompt: string;
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
  /** The selected pack agent's generated plugin view (only its skills and commands): loaded for this turn next to marcsh's own plugin. */
  packPluginPath?: string;
  /**
   * The tool groups the selected agent does not get this turn. Only ever narrows: the engine removes these tools on top of what the
   * mode already offers, and the tools that are left still ask. Absent: the mode's own tools, exactly as before.
   */
  deniedTools?: Group[];
  resumeRef?: string;
  /** Aborting stops the turn. */
  signal: AbortSignal;
};

/**
 * The text an engine appends to its system prompt: the agent's prompt, then the approval mode line (a blank line apart). None when both are absent.
 * The line says whether auto and yolo are active or paused on `branch`; it is read only when there is a mode to describe.
 */
export function systemPromptWithMode(agentPrompt: string | undefined, approvalMode: ApprovalMode | undefined, branch: BranchSource): string | undefined {
  const line = approvalMode && approvalMode !== "normal" ? approvalModeLine(approvalMode, resolveBranch(branch)) : undefined;
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
};
