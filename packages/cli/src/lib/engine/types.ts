import type { AskQuestion } from "../ask-user-question";
import type { ChatMessage } from "../chat-types";
import type { ClaudeCommand } from "../claude-commands";
import type { ModeType } from "../modes";
import type { ProjectTrustAsk, TrustAnswer } from "./pi-trust";

export type PermissionDecision = "allow" | "always" | "deny";

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
};

export type EngineEvent =
  /** The engine's reference for resuming this session became known. */
  | { type: "session"; ref: string }
  /** Output arrived: fold it into the assistant reply. */
  | { type: "reply"; update: (reply: ChatMessage) => ChatMessage }
  /** The engine's command list for the `/` menu; replaces any cached list. */
  | { type: "commands"; commands: ClaudeCommand[] }
  /** The turn failed with a user-facing message. */
  | { type: "error"; message: string };

export type TurnRequest = {
  prompt: string;
  cwd: string;
  mode: ModeType;
  model: string;
  /** The selected agent's prompt: added to the engine's own system prompt for this turn, never in place of it. */
  systemPromptAppend?: string;
  /** The selected pack agent's generated plugin view (only its skills and commands): loaded for this turn next to marcsh's own plugin. */
  packPluginPath?: string;
  resumeRef?: string;
  /** Aborting stops the turn. */
  signal: AbortSignal;
};

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
  /** Stops the current response and ends the turn. */
  interrupt(): void;
};

export type Engine = {
  id: string;
  startTurn(request: TurnRequest, host: TurnHost): EngineTurn;
  /** Fetches the command list without a model turn; best effort, never throws. */
  warmUpCommands(options: { cwd: string; save: (commands: ClaudeCommand[]) => void }): Promise<void>;
};
