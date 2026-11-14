import type { DialogContextValue } from "../../providers/dialog";
import type { Agent } from "../../lib/agents";
import type { SupportedChatModelId } from "../../lib/models";
import type { EngineId } from "../../lib/engine";
import type { ApprovalMode } from "../../lib/approval-policy";
import type { ToastContextValue } from "../../providers/toast";
import type { SessionCommands } from "./session-commands";

export type CommandContext = {
  /** What was typed after the command's name (`/agents install acme/flows` → `install acme/flows`), trimmed; empty when picked from the menu. */
  args: string;
  exit: () => void;
  dialog: DialogContextValue;
  toast: ToastContextValue;
  /** The engine the prompt runs on: the open session's, or the default for a new one. */
  engine: string;
  /** The folder the prompt works in: the open session's, or where marcsh was started. */
  cwd: string;
  defaultEngine: EngineId;
  setDefaultEngine: (engine: EngineId) => void;
  /** The approval mode of this app session, and the one saved for new sessions. */
  approvalMode: ApprovalMode;
  setApprovalMode: (mode: ApprovalMode) => void;
  defaultApprovalMode: ApprovalMode;
  setDefaultApprovalMode: (mode: ApprovalMode) => void;
  /** The model pi turns use ("provider/id"). */
  piModel: string;
  setPiModel: (model: string) => void;
  /** Re-checks the pi model against the models that have credentials now (after a login or logout). */
  refreshPiModel: () => Promise<string>;
  navigate: (path: string) => void;
  /** The selected agent's ID. */
  agentId: string;
  /** Reads the agent files again and resolves the list `/agents` shows. */
  reloadAgents: () => Agent[];
  /** Selects an agent by ID and keeps the choice. */
  selectAgent: (id: string) => void;
  setModel: (model: SupportedChatModelId) => void;
  /** What the open session can do; null outside a session (the home screen). */
  session: SessionCommands | null;
};

export type Command = {
  name: string;
  description: string;
  value: string;
  /** Where an engine's command comes from (`claude`; pi: `extension`, `prompt`, `skill`); marcsh's own commands leave it unset. */
  source?: string;
  argumentHint?: string;
  /** `session`: works on the open session, so the `/` menu lists it only there. */
  scope?: "session";
  action?: (ctx: CommandContext) => void | Promise<void>;
};
