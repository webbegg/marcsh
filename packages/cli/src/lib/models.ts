export const SUPPORTED_CHAT_MODELS = [
  { id: "opus" },
  { id: "sonnet" },
  { id: "haiku" },
] as const;

export type SupportedChatModel = (typeof SUPPORTED_CHAT_MODELS)[number];
export type SupportedChatModelId = SupportedChatModel["id"];

export const DEFAULT_CHAT_MODEL_ID: SupportedChatModelId = "opus";

/** pi addresses models as "provider/id"; the Claude aliases above mean nothing to it. */
export const PI_DEFAULT_MODEL = "anthropic/claude-opus-5-5";

/** The model a session on `engineId` sends: pi sessions use the chosen pi model ref, every other engine the chosen Claude alias. */
export function modelForEngine(engineId: string, claudeModel: string, piModel: string = PI_DEFAULT_MODEL): string {
  return engineId === "pi" ? piModel : claudeModel;
}
