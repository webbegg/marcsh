import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "./chat-types";
import { formatUsage, sessionUsage } from "./usage";

const assistant = (metadata: ChatMessage["metadata"]): ChatMessage => ({ id: "a", role: "assistant", parts: [], metadata });
const user: ChatMessage = { id: "u", role: "user", parts: [{ type: "text", text: "hi" }] };

describe("sessionUsage", () => {
  test("is empty when no message reports usage", () => {
    expect(sessionUsage([])).toEqual({});
    expect(sessionUsage([user, assistant({ model: "opus" })])).toEqual({});
  });

  test("takes the context of the last reply that has it, with its percent of the window", () => {
    const usage = sessionUsage([
      assistant({ usage: { contextTokens: 10_000, contextWindow: 200_000 } }),
      user,
      assistant({ usage: { contextTokens: 42_100, contextWindow: 200_000 } }),
      assistant({ usage: { costUsd: 0.1 } }),
    ]);

    expect(usage).toEqual({ contextTokens: 42_100, contextWindow: 200_000, contextPercent: 21, costUsd: 0.1 });
  });

  test("leaves the percent out when the window is unknown", () => {
    expect(sessionUsage([assistant({ usage: { contextTokens: 500 } })])).toEqual({ contextTokens: 500 });
  });

  test("sums the cost of every reply, reading older messages that only have metadata.costUsd", () => {
    const usage = sessionUsage([assistant({ costUsd: 0.25 }), assistant({ usage: { costUsd: 0.5 }, costUsd: 0.5 }), user, assistant({})]);

    expect(usage.costUsd).toBeCloseTo(0.75);
  });
});

describe("formatUsage", () => {
  test("shows context, percent and cost", () => {
    expect(formatUsage({ contextTokens: 42_100, contextWindow: 200_000, contextPercent: 21, costUsd: 0.34 })).toBe("42.1k/200k (21%) · $0.34");
  });

  test("drops the parts that are unknown", () => {
    expect(formatUsage({ costUsd: 0.34 })).toBe("$0.34");
    expect(formatUsage({ contextTokens: 42_100, contextWindow: 200_000, contextPercent: 21 })).toBe("42.1k/200k (21%)");
    expect(formatUsage({ contextTokens: 900 })).toBe("900 ctx");
  });

  test("is empty when nothing is known", () => {
    expect(formatUsage({})).toBe("");
    expect(formatUsage({ contextWindow: 200_000 })).toBe("");
  });

  test("abbreviates token counts and small costs", () => {
    expect(formatUsage({ contextTokens: 1_000_000, contextWindow: 1_000_000, contextPercent: 100 })).toBe("1M/1M (100%)");
    expect(formatUsage({ contextTokens: 1_500_000, contextWindow: 2_000_000, contextPercent: 75 })).toBe("1.5M/2M (75%)");
    expect(formatUsage({ contextTokens: 999_960 })).toBe("1M ctx");
    expect(formatUsage({ costUsd: 0.004 })).toBe("<$0.01");
    expect(formatUsage({ costUsd: 0 })).toBe("$0.00");
    expect(formatUsage({ costUsd: 12.345 })).toBe("$12.35");
  });
});
