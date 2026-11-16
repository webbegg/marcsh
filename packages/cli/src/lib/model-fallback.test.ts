import { describe, expect, test } from "bun:test";
import { categoryText, classifyFailure, Cooldowns, cooldownMs, LIMIT_COOLDOWN_MS, nextModel, sharedCooldowns, TRANSIENT_COOLDOWN_MS, type FailureCategory } from "./model-fallback";

describe("classifyFailure", () => {
  const cases: Array<[string, FailureCategory | undefined]> = [
    ["429 {\"type\":\"rate_limit_error\",\"message\":\"Number of request tokens has exceeded your per-minute rate limit\"}", "rate_limit"],
    ["Too Many Requests", "rate_limit"],
    ["RESOURCE_EXHAUSTED: try later", "rate_limit"],
    ["You exceeded your current quota, please check your plan and billing details", "quota"],
    ["Your credit balance is too low to access the Anthropic API", "quota"],
    ["400 {\"type\":\"invalid_request_error\",\"message\":\"Your credit balance is too low\"}", "quota"],
    ["usage limit reached for this subscription", "quota"],
    ["401 invalid x-api-key", "auth"],
    ["403 Forbidden", "auth"],
    ["No API key for openai. Run /login to sign in to a provider, or /models to pick a model that has one.", "auth"],
    ["OAuth token has expired", "auth"],
    ["529 {\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}", "provider_unavailable"],
    ["503 Service Unavailable", "provider_unavailable"],
    ["500 Internal Server Error", "provider_unavailable"],
    ["502 Bad Gateway", "provider_unavailable"],
    ["504 gateway timeout", "provider_unavailable"],
    ["Request timed out", "timeout"],
    ["The operation timed out after 60000 ms", "timeout"],
    ["fetch failed", "network"],
    ["read ECONNRESET", "network"],
    ["getaddrinfo ENOTFOUND api.example.com", "network"],
    ["Connection error.", "network"],
    // Never a fallback.
    ["400 invalid_request_error: prompt is too long: 250000 tokens > 200000 maximum", undefined],
    ["This model's maximum context length is 128000 tokens", undefined],
    ["context_length_exceeded", undefined],
    ["Input is too long for requested model", undefined],
    ["400 invalid_request_error: messages.0.content: Input should be a valid list", undefined],
    ["Bad Request", undefined],
    ["422 Unprocessable Entity", undefined],
    ["The subagent was interrupted.", undefined],
    ["Request was aborted", undefined],
    ["child exploded", undefined],
    ["provider exploded", undefined],
    ["", undefined],
  ];

  for (const [message, expected] of cases) {
    test(`${JSON.stringify(message).slice(0, 70)} → ${expected ?? "no fallback"}`, () => {
      expect(classifyFailure(message)).toBe(expected);
    });
  }

  test("a context-length error that also says 429 or overloaded still never falls back", () => {
    expect(classifyFailure("429 overloaded: context length exceeded")).toBeUndefined();
  });

  test("nothing in, nothing out", () => {
    expect(classifyFailure(undefined)).toBeUndefined();
    expect(classifyFailure(null)).toBeUndefined();
  });
});

describe("cooldown length", () => {
  test("30 minutes after a quota or auth failure, 2 after a transient one", () => {
    expect(LIMIT_COOLDOWN_MS).toBe(30 * 60_000);
    expect(TRANSIENT_COOLDOWN_MS).toBe(2 * 60_000);
    expect(cooldownMs("quota")).toBe(LIMIT_COOLDOWN_MS);
    expect(cooldownMs("auth")).toBe(LIMIT_COOLDOWN_MS);
    for (const category of ["rate_limit", "provider_unavailable", "timeout", "network"] as const) expect(cooldownMs(category)).toBe(TRANSIENT_COOLDOWN_MS);
  });
});

describe("Cooldowns", () => {
  test("a failed model is skipped until its cooldown ends, then used again", () => {
    let now = 1_000;
    const cooldowns = new Cooldowns(() => now);
    expect(cooldowns.isCooling("a/1")).toBe(false);
    cooldowns.cool("a/1", cooldownMs("provider_unavailable"));
    expect(cooldowns.isCooling("a/1")).toBe(true);
    expect(cooldowns.isCooling("a/2")).toBe(false);
    now += TRANSIENT_COOLDOWN_MS - 1;
    expect(cooldowns.isCooling("a/1")).toBe(true);
    now += 1;
    expect(cooldowns.isCooling("a/1")).toBe(false);
    expect(cooldowns.coolingUntil("a/1")).toBeUndefined();
  });

  test("a longer cooldown is never shortened by a later, shorter one", () => {
    let now = 0;
    const cooldowns = new Cooldowns(() => now);
    cooldowns.cool("a/1", cooldownMs("quota"));
    cooldowns.cool("a/1", cooldownMs("network"));
    now = TRANSIENT_COOLDOWN_MS + 1;
    expect(cooldowns.isCooling("a/1")).toBe(true);
    expect(cooldowns.coolingUntil("a/1")).toBe(LIMIT_COOLDOWN_MS);
    now = LIMIT_COOLDOWN_MS;
    expect(cooldowns.isCooling("a/1")).toBe(false);
  });

  test("clear forgets everything; the shared one is one object for the whole run", () => {
    const cooldowns = new Cooldowns();
    cooldowns.cool("a/1", 1000);
    cooldowns.clear();
    expect(cooldowns.isCooling("a/1")).toBe(false);
    expect(sharedCooldowns()).toBe(sharedCooldowns());
  });
});

describe("nextModel", () => {
  const chain = [{ model: "a/1" }, { model: "a/2", thinking: "low" }, { model: "a/3" }];

  test("the first model not tried and not cooling", () => {
    expect(nextModel(chain, new Set(["a/1"]), () => false)).toEqual({ model: "a/2", thinking: "low" });
    expect(nextModel(chain, new Set(["a/1"]), (m) => m === "a/2")).toEqual({ model: "a/3" });
  });

  test("none left: undefined", () => {
    expect(nextModel(chain, new Set(["a/1", "a/2", "a/3"]), () => false)).toBeUndefined();
    expect(nextModel(chain, new Set(), () => true)).toBeUndefined();
  });
});

test("every category has words for the notice", () => {
  for (const category of ["quota", "auth", "rate_limit", "provider_unavailable", "timeout", "network"] as const) expect(categoryText(category).length).toBeGreaterThan(3);
});
