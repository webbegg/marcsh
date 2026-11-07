export const SUPPORTED_CHAT_MODELS = [
  { id: "opus" },
  { id: "sonnet" },
  { id: "haiku" },
] as const;

export type SupportedChatModel = (typeof SUPPORTED_CHAT_MODELS)[number];
export type SupportedChatModelId = SupportedChatModel["id"];

export const DEFAULT_CHAT_MODEL_ID: SupportedChatModelId = "opus";
