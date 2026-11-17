/**
 * Model fallback: when a turn or a subagent fails for a reason another model can get past, the next model of its route's chain takes
 * over. pi retries transient errors by itself first, so what reaches this module is a failure that stayed.
 *
 * Never a fallback: context length, an invalid request, a stop by the user. Another model would hit the same wall (or the user said stop).
 */

export type FailureCategory = "quota" | "auth" | "rate_limit" | "provider_unavailable" | "timeout" | "network";

// What another model would hit the same way. A message that says "context length" never falls back, whatever else it says.
// A stop by the user does not either; "connection aborted" is a network error, and "aborted due to timeout" a timeout, not a stop.
const CONTEXT_OR_STOPPED = [
  /context[ _](?:length|window)|context_length_exceeded|prompt is too long|input is too long|maximum context|exceeds the (?:model's )?(?:maximum )?(?:context|input)/i,
  /^(?:the )?(?:subagent|turn|request) was (?:interrupted|aborted|cancelled)|(?<!connection )\baborted\b(?! due to timeout)/i,
];
// Checked in this order (the first that matches decides):
//  1. a quota that will not come back soon: billing, credits, a daily or monthly limit, a plan;
//  2. a rate limit per minute or per request (OpenAI's "Rate limit reached for ... on tokens per min", Google's per-minute RESOURCE_EXHAUSTED,
//     a 429 with a retry-after): it passes within a minute or two, so it is not a quota even when its text says "quota" or "billing";
//  3. any other quota or billing wording;
//  4. a bad key or no permission, which providers (OpenAI) report as an "invalid_request_error", so before the invalid-request veto;
//  5. a malformed request, which fails on any model.
const HARD_QUOTA = /insufficient[_ ]quota|credit balance|insufficient[_ ]credits?|out of credits|monthly|per[ -]?day|\bdaily\b|usage limit|(?:spend(?:ing)?|plan) limit|subscription/i;
const RATE_LIMIT = /rate[ _-]?limit|per[ -]?min|\b(?:rpm|tpm)\b|too many requests|\b429\b[\s\S]*retry[- ]after|retry[- ]after[\s\S]*\b429\b/i;
const SOFT_QUOTA = /quota|billing|exceeded your (?:current )?(?:usage|plan)/i;
const AUTH = /\b40[13]\b|unauthori[sz]ed|forbidden|authentication|permission|invalid[ _](?:x-)?api[ _-]?key|(?:incorrect|invalid) api key|api key not valid|no api key|oauth|not logged in|please (?:log|sign) in|\/login/i;
// 400 and 422 count only where a status stands: at the start (as marcsh reports "400 {...}"), after "HTTP", "status" or "error", or as a JSON "code".
const INVALID_REQUEST = /invalid[_ ]request|invalid[_ ]argument|bad request|unprocessable|^\W*(?:(?:[a-z]*error|http|status(?: code)?)[ :/]*)?(?:400|422)\b|\b(?:http|status(?: code)?|error)[ :/]*(?:400|422)\b|"(?:code|status)"\s*:\s*(?:400|422)\b/i;

// What is left once those are told apart.
const CATEGORIES: ReadonlyArray<readonly [FailureCategory, RegExp]> = [
  ["rate_limit", /\b429\b|resource[_ ]exhausted/i],
  ["provider_unavailable", /\b5(?:0\d|2\d)\b|overloaded|unavailable|internal server error|bad gateway|server error|capacity/i],
  ["timeout", /timed? ?out|timeout|deadline exceeded/i],
  ["network", /econnreset|econnrefused|econnaborted|enotfound|eai_again|epipe|etimedout|socket hang up|fetch failed|network|connection (?:error|reset|refused|closed|aborted)|terminated/i],
];

/** Why a failure may be got past by another model, or undefined when it may not (or is not recognized). `message` is the error as marcsh reports it. */
export function classifyFailure(message: string | undefined | null): FailureCategory | undefined {
  const text = message ?? "";
  if (!text || CONTEXT_OR_STOPPED.some((pattern) => pattern.test(text))) return undefined;
  if (HARD_QUOTA.test(text)) return "quota";
  if (RATE_LIMIT.test(text)) return "rate_limit";
  if (SOFT_QUOTA.test(text)) return "quota";
  if (AUTH.test(text)) return "auth";
  if (INVALID_REQUEST.test(text)) return undefined;
  return CATEGORIES.find(([, pattern]) => pattern.test(text))?.[0];
}

const MINUTE = 60_000;
export const LIMIT_COOLDOWN_MS = 30 * MINUTE;
export const TRANSIENT_COOLDOWN_MS = 2 * MINUTE;

/** How long a model that failed this way is skipped: 30 minutes after a quota or auth failure, 2 after a transient one. */
export const cooldownMs = (category: FailureCategory): number => (category === "quota" || category === "auth" ? LIMIT_COOLDOWN_MS : TRANSIENT_COOLDOWN_MS);

/** Models that failed recently and until when (in memory: one run of marcsh, shared by the turns and subagents in it). */
export class Cooldowns {
  private readonly until = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Skips `model` for `ms` from now; a longer cooldown it already has is kept. */
  cool(model: string, ms: number) {
    this.until.set(model, Math.max(this.now() + ms, this.until.get(model) ?? 0));
  }

  isCooling(model: string): boolean {
    const until = this.until.get(model);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.until.delete(model);
    return false;
  }

  /** When the model may be used again, or undefined when it can be used now. */
  coolingUntil(model: string): number | undefined {
    return this.isCooling(model) ? this.until.get(model) : undefined;
  }

  clear() {
    this.until.clear();
  }
}

const shared = new Cooldowns();

/** The cooldowns of this run of marcsh. */
export const sharedCooldowns = (): Cooldowns => shared;

/** The next model to try after the one that failed: the first of `chain` not tried yet and not cooling. Undefined when there is none. */
export function nextModel<T extends { model: string }>(chain: readonly T[], tried: ReadonlySet<string>, isCooling: (model: string) => boolean): T | undefined {
  return chain.find((step) => !tried.has(step.model) && !isCooling(step.model));
}

/** The failure as one short phrase for the notice the user sees. */
export const categoryText = (category: FailureCategory): string =>
  ({ quota: "a usage limit", auth: "an authentication error", rate_limit: "a rate limit", provider_unavailable: "a provider error", timeout: "a timeout", network: "a network error" })[category];
