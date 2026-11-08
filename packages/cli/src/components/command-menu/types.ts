import type { DialogContextValue } from "../../providers/dialog";
import type { ModeType } from "../../lib/modes";
import type { SupportedChatModelId } from "../../lib/models";
import type { EngineId } from "../../lib/engine";
import type { ToastContextValue } from "../../providers/toast";

export type CommandContext = {
  exit: () => void;
  dialog: DialogContextValue;
  toast: ToastContextValue;
  /** The engine the prompt runs on: the open session's, or the default for a new one. */
  engine: string;
  defaultEngine: EngineId;
  setDefaultEngine: (engine: EngineId) => void;
  navigate: (path: string) => void;
  mode: ModeType;
  setMode: (mode: ModeType) => void;
  setModel: (model: SupportedChatModelId) => void;
};

export type Command = {
  name: string;
  description: string;
  value: string;
  /** Set on Claude Code commands and skills; marcsh's own commands leave it unset. */
  source?: "claude";
  argumentHint?: string;
  action?: (ctx: CommandContext) => void | Promise<void>;
};
