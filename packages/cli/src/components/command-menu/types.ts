import type { DialogContextValue } from "../../providers/dialog";
import type { Agent } from "../../lib/agents";
import type { SupportedChatModelId } from "../../lib/models";
import type { EngineId } from "../../lib/engine";
import type { ToastContextValue } from "../../providers/toast";

export type CommandContext = {
  exit: () => void;
  dialog: DialogContextValue;
  toast: ToastContextValue;
  /** The engine the prompt runs on: the open session's, or the default for a new one. */
  engine: string;
  /** The folder the prompt works in: the open session's, or where marcsh was started. */
  cwd: string;
  defaultEngine: EngineId;
  setDefaultEngine: (engine: EngineId) => void;
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
};

export type Command = {
  name: string;
  description: string;
  value: string;
  /** Where an engine's command comes from (`claude`; pi: `extension`, `prompt`, `skill`); marcsh's own commands leave it unset. */
  source?: string;
  argumentHint?: string;
  action?: (ctx: CommandContext) => void | Promise<void>;
};
