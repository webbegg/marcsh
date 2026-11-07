import type { DialogContextValue } from "../../providers/dialog";
import type { ModeType } from "../../lib/modes";
import type { SupportedChatModelId } from "../../lib/models";

export type CommandContext = {
  exit: () => void;
  dialog: DialogContextValue;
  navigate: (path: string) => void;
  mode: ModeType;
  setMode: (mode: ModeType) => void;
  setModel: (model: SupportedChatModelId) => void;
};

export type Command = {
  name: string;
  description: string;
  value: string;
  action?: (ctx: CommandContext) => void | Promise<void>;
};
