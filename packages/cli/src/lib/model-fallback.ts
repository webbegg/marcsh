/**
 * Model fallback: when a turn or a subagent fails for a reason another model can get past, the next model of its route's chain takes
 * over. pi retries transient errors by itself first, so what reaches this module is a failure that stayed.
 *
 * Never a fallback: context length, an invalid request, a stop by the user. Another model would hit the same wall (or the user said stop).
 */

export type FailureCategory = "quota" | "auth" | "rate_limit" | "provider_unavailable" | "timeout" | "network";

// What another model would hit the same way. A message that says "context length" never falls back, whatever else it says.
const CONTEXT_OR_STOPPED = [
  /context[ _](?:length|window)|context_length_exceeded|prompt is too long|input is too long|maximum context|exceeds the (?:model's )?(?:maximum )?(?:context|input)/i,
  /^(?:the )?(?:subagent|turn|request) was (?:interrupted|aborted|cancelled)|\baborted\b/i,
];
const QUOTA = /quota|usage limit|credit balance|insufficient[_ ]credits?|billing|exceeded your (?:current )?(?:usage|plan)|subscription|out of credits|limit reached/i;
// A malformed request fails on any model. Checked after the quota, which some providers report as a 400 ("credit balance is too low").
const INVALID_REQUEST = /invalid[_ ]request|bad request|\b400\b|unprocessable|\b422\b/i;

const CATEGORIES: ReadonlyArray<readonly [FailureCategory, RegExp]> = [
  ["quota", QUOTA],
  ["auth", /\b40[13]\b|unauthori[sz]ed|forbidden|authentication|invalid[ _](?:x-)?api[ _-]?key|no api key|oauth|not logged in|please (?:log|sign) in|\/login/i],
  ["rate_limit", /\b429\b|rate[ _-]?limit|too many requests|resource[_ ]exhausted/i],
  ["provider_unavailable", /\b5(?:0\d|2\d)\b|overloaded|unavailable|internal server error|bad gateway|server error|capacity/i],
  ["timeout", /timed? ?out|timeout|deadline exceeded/i],
  ["network", /econnreset|econnrefused|enotfound|eai_again|epipe|etimedout|socket hang up|fetch failed|network|connection (?:error|reset|refused|closed)|terminated/i],
];

/** Why a failure may be got past by another model, or undefined when it may not (or is not recognized). `message` is the error as marcsh reports it. */
export function classifyFailure(message: string | undefined | null): FailureCategory | undefined {
  const text = message ?? "";
  if (!text || CONTEXT_OR_STOPPED.some((pattern) => pattern.test(text))) return undefined;
  if (INVALID_REQUEST.test(text) && !QUOTA.test(text)) return undefined;
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
