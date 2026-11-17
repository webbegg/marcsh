import { describe, expect, test } from "bun:test";
import { isChatModelId, lastUsedModel } from "./models";

describe("isChatModelId", () => {
  test("knows the Claude aliases only", () => {
    expect(["opus", "sonnet", "haiku"].every(isChatModelId)).toBe(true);
    expect(isChatModelId("gpt")).toBe(false);
    expect(isChatModelId("anthropic/claude-opus-5-5")).toBe(false);
    expect(isChatModelId(undefined)).toBe(false);
    expect(isChatModelId(3)).toBe(false);
  });
});

describe("lastUsedModel", () => {
  const msg = (role: "user" | "assistant", model?: string) => ({ role, metadata: model ? { model } : undefined });

  test("is the model of the latest message that names one", () => {
    expect(lastUsedModel([msg("user", "opus"), msg("assistant", "opus"), msg("user", "haiku"), msg("assistant", "haiku")])).toBe("haiku");
    expect(lastUsedModel([msg("assistant", "sonnet"), msg("user")])).toBe("sonnet");
  });

  test("is undefined when no message names one", () => {
    expect(lastUsedModel([])).toBeUndefined();
    expect(lastUsedModel([msg("user"), msg("assistant")])).toBeUndefined();
  });
});
