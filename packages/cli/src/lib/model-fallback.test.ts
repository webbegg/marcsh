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

// R4-003 / R4-004: realistic provider bodies, one table per kind of provider; the category decides the cooldown (quota and auth 30 minutes, the rest 2).
describe("classifyFailure with provider bodies", () => {
  const bodies: Array<[string, string, FailureCategory | undefined]> = [
    // Rate limits are transient: never a quota, whatever the provider calls the limit.
    ["openai tokens per min", "429 Rate limit reached for gpt-4o in organization org-abc on tokens per min (TPM): Limit 30000, Used 29000, Requested 5000. Please try again in 4s. Visit https://platform.openai.com/account/rate-limits to learn more.", "rate_limit"],
    ["openai requests per min", "429 Rate limit reached for gpt-4 in organization org-abc on requests per min (RPM): Limit 3, Used 3, Requested 1.", "rate_limit"],
    ["google per minute", "429 {\"error\":{\"code\":429,\"message\":\"Quota exceeded for quota metric 'Generate Content API requests per minute' and limit 'GenerateContent request limit per minute for a region' of service 'generativelanguage.googleapis.com'\",\"status\":\"RESOURCE_EXHAUSTED\"}}", "rate_limit"],
    ["google free tier per minute", "429 You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 15 PerMinutePerProject", "rate_limit"],
    ["anthropic rate limit", "429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"This request would exceed your organization's rate limit of 30,000 input tokens per minute\"}}", "rate_limit"],
    ["429 with retry-after", "429 Too fast. retry-after: 12", "rate_limit"],
    // Real quota and billing: the model is out for a long while.
    ["openai insufficient_quota", "429 You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs.", "quota"],
    ["openai insufficient_quota body", "429 {\"error\":{\"message\":\"You exceeded your current quota\",\"type\":\"insufficient_quota\",\"code\":\"insufficient_quota\"}}", "quota"],
    ["openai tokens per day", "429 Rate limit reached for gpt-4o on tokens per day (TPD): Limit 500000, Used 499000", "quota"],
    ["anthropic credit balance", "400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.\"}}", "quota"],
    ["anthropic usage limits", "400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.\"}}", "quota"],
    ["google daily quota", "429 {\"error\":{\"code\":429,\"message\":\"Quota exceeded for quota metric 'Generate Content API requests' and limit 'requests per day'\",\"status\":\"RESOURCE_EXHAUSTED\"}}", "quota"],
    ["monthly spend", "Monthly spend limit exceeded for this workspace", "quota"],
    // Auth before the invalid-request veto: a bad key is reported as an invalid request by OpenAI.
    ["openai invalid_api_key", "401 {\"error\":{\"message\":\"Incorrect API key provided: sk-abc***xyz.\",\"type\":\"invalid_request_error\",\"param\":null,\"code\":\"invalid_api_key\"}}", "auth"],
    ["anthropic authentication_error", "401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"}}", "auth"],
    ["anthropic permission_error", "403 {\"type\":\"error\",\"error\":{\"type\":\"permission_error\",\"message\":\"Your API key does not have permission to use the specified resource.\"}}", "auth"],
    ["google api key not valid", "400 {\"error\":{\"code\":400,\"message\":\"API key not valid. Please pass a valid API key.\",\"status\":\"INVALID_ARGUMENT\"}}", "auth"],
    ["google permission denied", "403 {\"error\":{\"code\":403,\"message\":\"The caller does not have permission\",\"status\":\"PERMISSION_DENIED\"}}", "auth"],
    // Provider trouble.
    ["anthropic overloaded", "529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}", "provider_unavailable"],
    ["openai server_error", "500 {\"error\":{\"message\":\"The server had an error while processing your request.\",\"type\":\"server_error\"}}", "provider_unavailable"],
    ["google unavailable", "503 {\"error\":{\"code\":503,\"message\":\"The model is overloaded. Please try again later.\",\"status\":\"UNAVAILABLE\"}}", "provider_unavailable"],
    ["google deadline", "504 {\"error\":{\"code\":504,\"message\":\"Deadline expired before operation could complete.\",\"status\":\"DEADLINE_EXCEEDED\"}}", "provider_unavailable"],
    // Network: a connection that was aborted is not the user's stop.
    ["connection aborted", "Connection aborted by peer", "network"],
    ["econnaborted", "read ECONNABORTED", "network"],
    ["timeout abort", "TimeoutError: The operation was aborted due to timeout", "timeout"],
    // Never a fallback: a malformed request, however the provider words it.
    ["openai invalid request", "400 {\"error\":{\"message\":\"Invalid value for 'messages[0].role'.\",\"type\":\"invalid_request_error\",\"param\":\"messages\",\"code\":null}}", undefined],
    ["openai context", "400 {\"error\":{\"message\":\"This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.\",\"type\":\"invalid_request_error\",\"code\":\"context_length_exceeded\"}}", undefined],
    ["anthropic invalid request", "400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"messages: roles must alternate between \\\"user\\\" and \\\"assistant\\\"\"}}", undefined],
    ["google invalid argument", "400 {\"error\":{\"code\":400,\"message\":\"Request contains an invalid argument.\",\"status\":\"INVALID_ARGUMENT\"}}", undefined],
    ["google too many tokens", "400 {\"error\":{\"code\":400,\"message\":\"The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).\",\"status\":\"INVALID_ARGUMENT\"}}", undefined],
    ["anthropic stop", "Request was aborted.", undefined],
    ["fetch abort", "This operation was aborted", undefined],
  ];

  for (const [name, message, expected] of bodies) {
    test(`${name} → ${expected ?? "no fallback"}`, () => {
      expect(classifyFailure(message)).toBe(expected);
    });
  }

  test("a rate limit cools for 2 minutes, a quota or a bad key for 30", () => {
    expect(cooldownMs(classifyFailure(bodies[0]![1])!)).toBe(TRANSIENT_COOLDOWN_MS);
    expect(cooldownMs(classifyFailure(bodies.find(([name]) => name === "openai insufficient_quota")![1])!)).toBe(LIMIT_COOLDOWN_MS);
    expect(cooldownMs(classifyFailure(bodies.find(([name]) => name === "openai invalid_api_key")![1])!)).toBe(LIMIT_COOLDOWN_MS);
  });

  test("a 400 or 422 inside a number or a message is not a status", () => {
    // Auth does not match, and no status 400: the text falls to the categories it does match.
    expect(classifyFailure("502 Bad Gateway while sending 4000 tokens, 422 bytes read")).toBe("provider_unavailable");
    expect(classifyFailure("read ECONNRESET after 400 ms")).toBe("network");
    expect(classifyFailure("Error 422 Unprocessable Entity")).toBeUndefined();
    expect(classifyFailure("HTTP 400 Bad Request")).toBeUndefined();
    expect(classifyFailure("status: 400")).toBeUndefined();
    expect(classifyFailure("{\"error\":{\"code\":400,\"message\":\"x\"}}")).toBeUndefined();
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
