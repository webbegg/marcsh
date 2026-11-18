export const SUPPORTED_CHAT_MODELS = [
  { id: "opus" },
  { id: "sonnet" },
  { id: "haiku" },
] as const;

export type SupportedChatModel = (typeof SUPPORTED_CHAT_MODELS)[number];
export type SupportedChatModelId = SupportedChatModel["id"];

export const DEFAULT_CHAT_MODEL_ID: SupportedChatModelId = "opus";

/** Whether `value` is one of the Claude aliases marcsh offers. */
export function isChatModelId(value: unknown): value is SupportedChatModelId {
  return SUPPORTED_CHAT_MODELS.some((candidate) => candidate.id === value);
}

/** The model a session last used: that of the latest message that names one (user and reply messages both do), if any. */
export function lastUsedModel(messages: readonly { metadata?: { model?: string } }[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const model = messages[index]?.metadata?.model;
    if (model) return model;
  }
  return undefined;
}

/** pi addresses models as "provider/id"; the Claude aliases above mean nothing to it. */
export const PI_DEFAULT_MODEL = "anthropic/claude-opus-5-5";

/** The model a session on `engineId` sends: pi sessions use the chosen pi model ref, every other engine the chosen Claude alias. */
export function modelForEngine(engineId: string, claudeModel: string, piModel: string = PI_DEFAULT_MODEL): string {
  return engineId === "pi" ? piModel : claudeModel;
}
