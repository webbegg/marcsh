import type { ChatMessage, ChatUsage } from "./chat-types";

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The numbers among the values, or undefined when there is none (an engine that reports nothing leaves a field unknown, not 0). */
export function reported(value: unknown): number | undefined {
  return isNumber(value) ? value : undefined;
}

/**
 * Tokens the conversation takes up in one request: input + cache read + cache write (output is the reply, not context).
 * Parts the engine did not report count as 0 when another one is reported; undefined when none is, or when the request
 * reported nothing but zeros (a failed request), so it never wipes a context that was known.
 */
export function contextTokensOf(input: unknown, cacheRead: unknown, cacheWrite: unknown): number | undefined {
  const parts = [input, cacheRead, cacheWrite].filter(isNumber);
  const sum = parts.reduce((total, part) => total + part, 0);
  return sum > 0 ? sum : undefined;
}

/** Merges usage fields over `base`, ignoring the ones that are undefined; undefined when there is nothing at all. */
export function mergeUsage(base: ChatUsage | undefined, changes: ChatUsage): ChatUsage | undefined {
  const merged = { ...base };
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined) merged[key as keyof ChatUsage] = value;
  }
  return Object.keys(merged).length === 0 ? undefined : merged;
}

/** Adds `part` to the number in `field` of `base`, when the part is reported. */
export function addTo(base: ChatUsage | undefined, field: keyof ChatUsage, part: number | undefined): number | undefined {
  return part === undefined ? base?.[field] : (base?.[field] ?? 0) + part;
}

export type SessionUsage = {
  contextTokens?: number;
  contextWindow?: number;
  /** Whole percent of the window the context takes; known only with both. */
  contextPercent?: number;
  costUsd?: number;
};

/** The context of the last reply that reports it (with that reply's window) and the cost summed over every reply that reports one. */
export function sessionUsage(messages: readonly ChatMessage[]): SessionUsage {
  const result: SessionUsage = {};
  let cost: number | undefined;

  for (const message of messages) {
    if (message.role !== "assistant") continue;

    const usage = message.metadata?.usage;
    const replyCost = reported(usage?.costUsd) ?? reported(message.metadata?.costUsd);
    if (replyCost !== undefined) cost = (cost ?? 0) + replyCost;

    const tokens = reported(usage?.contextTokens);
    if (tokens !== undefined) {
      result.contextTokens = tokens;
      result.contextWindow = reported(usage?.contextWindow);
    }
  }

  if (result.contextWindow === undefined) delete result.contextWindow;
  else if (result.contextWindow > 0 && result.contextTokens !== undefined) {
    result.contextPercent = Math.round((result.contextTokens / result.contextWindow) * 100);
  }
  if (cost !== undefined) result.costUsd = cost;
  return result;
}

/** 900 → "900", 42_100 → "42.1k", 200_000 → "200k", 1_500_000 → "1.5M". */
function compact(tokens: number): string {
  const trimmed = (value: number) => String(Math.round(value * 10) / 10);
  if (tokens < 1000) return String(Math.round(tokens));
  const thousands = Math.round(tokens / 100) / 10;
  return thousands < 1000 ? `${trimmed(thousands)}k` : `${trimmed(tokens / 1_000_000)}M`;
}

function money(usd: number): string {
  return usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

/** e.g. `42.1k/200k (21%) · $0.34`: each part is left out when unknown, and the result is empty when nothing is known. */
export function formatUsage(usage: SessionUsage): string {
  const parts: string[] = [];

  if (usage.contextTokens !== undefined) {
    if (usage.contextWindow === undefined) parts.push(`${compact(usage.contextTokens)} ctx`);
    else if (usage.contextPercent === undefined) parts.push(`${compact(usage.contextTokens)}/${compact(usage.contextWindow)}`);
    else parts.push(`${compact(usage.contextTokens)}/${compact(usage.contextWindow)} (${usage.contextPercent}%)`);
  }
  if (usage.costUsd !== undefined) parts.push(money(usage.costUsd));

  return parts.join(" · ");
}
