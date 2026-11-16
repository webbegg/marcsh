import type { ModelStep } from "./engine/types";
import { ANY_KEY, PRIMARY_KEY, type ActiveProfile, type Profile, type Route, type RouteStep, type Thinking } from "./profiles";

/**
 * Which model (and thinking level, and fallback chain) a subagent launch or the main turn gets. The rules, per launch:
 *
 * 1. The route of the session's profile (`/profile use`), then of the default profile. Within a profile the key that names the subagent
 *    wins, then the longest prefix glob (`review-*`), then `*`. `primary` is only for the selected agent's own turn.
 * 2. A route is one unit: its model, thinking level and fallback chain come together. A route whose model does not fit the engine is
 *    skipped, as an agent's own `model` is (pi takes `provider/id`, Claude its own names), and the next source is tried.
 * 3. Then the agent file's `model`, when it fits the engine.
 * 4. Then the turn's own model (nothing is returned).
 *
 * Thinking levels belong to pi: on Claude marcsh has no such setting, so none is returned there.
 */

/** Where a resolved model comes from. */
export type RouteSource =
  | { kind: "profile"; profile: string; origin: ActiveProfile["source"]; key: string }
  | { kind: "agent" }
  | { kind: "turn" };

export type ResolvedRoute = {
  /** The model to use; absent when the turn's own model is used. */
  model?: string;
  thinking?: Thinking;
  /** The models to move to, in order, when `model` fails (only those that fit the engine). */
  fallback: RouteStep[];
  source: RouteSource;
};

/** What routing needs to know about the engine: whether it can use a model name, and whether it has thinking levels. */
export type RoutingEngine = { id: string; fits: (model: string) => boolean };

/**
 * The route a profile has for the subagent `name`: the exact key, else the longest prefix glob, else `*`. The `primary` key is the main
 * turn's, never a subagent's (not even one whose file is named `primary`).
 */
export function matchRoute(profile: Profile, name: string): { key: string; route: Route } | undefined {
  const own = (key: string) => (key !== PRIMARY_KEY && Object.hasOwn(profile, key) ? { key, route: profile[key]! } : undefined);
  const exact = own(name);
  if (exact) return exact;
  const glob = Object.keys(profile)
    .filter((key) => key !== ANY_KEY && key.endsWith("*") && name.startsWith(key.slice(0, -1)))
    .sort((a, b) => b.length - a.length)[0];
  return (glob && own(glob)) || own(ANY_KEY);
}

/** The route a profile has for the main turn: its `primary` key, and nothing else (`*` is for subagents). */
const matchPrimary = (profile: Profile): { key: string; route: Route } | undefined =>
  Object.hasOwn(profile, PRIMARY_KEY) ? { key: PRIMARY_KEY, route: profile[PRIMARY_KEY]! } : undefined;

const usableSteps = (steps: readonly RouteStep[] | undefined, engine: RoutingEngine): RouteStep[] =>
  (steps ?? []).filter((step) => engine.fits(step.model)).map((step) => (engine.id === "pi" || !step.thinking ? step : { model: step.model }));

/**
 * Resolves the route of a subagent (`name` is its file name, `agentModel` the agent file's own `model`), or, with `name` left out, of the
 * main turn (its `primary` key).
 */
export function resolveRoute({
  active,
  name,
  agentModel,
  engine,
}: {
  active: readonly ActiveProfile[];
  name?: string;
  agentModel?: string;
  engine: RoutingEngine;
}): ResolvedRoute {
  for (const { name: profile, source: origin, profile: routes } of active) {
    const found = name === undefined ? matchPrimary(routes) : matchRoute(routes, name);
    if (!found || !engine.fits(found.route.model)) continue;
    return {
      model: found.route.model,
      ...(engine.id === "pi" && found.route.thinking ? { thinking: found.route.thinking } : {}),
      fallback: usableSteps(found.route.fallback, engine).filter((step) => step.model !== found.route.model),
      source: { kind: "profile", profile, origin, key: found.key },
    };
  }
  // The main turn's own model is chosen in the UI (and an agent's `model` is applied there), not here.
  if (name !== undefined && agentModel && engine.fits(agentModel)) return { model: agentModel, fallback: [], source: { kind: "agent" } };
  return { fallback: [], source: { kind: "turn" } };
}

/** The model of the `primary` route in force, for `/profile use` to switch the session to; undefined when no profile has a usable one. */
export function primaryModel(active: readonly ActiveProfile[], engine: RoutingEngine): string | undefined {
  return resolveRoute({ active, engine }).model;
}

const stepText = (step: RouteStep) => (step.thinking ? `${step.model} (${step.thinking})` : step.model);

export function sourceText(source: RouteSource): string {
  if (source.kind === "agent") return "agent file";
  if (source.kind === "turn") return "the turn's model";
  return `${source.origin === "session" ? "session" : "default"} profile ${source.profile}, route ${source.key}`;
}

/** One line for a resolved route: its model with where it comes from, then thinking and the fallback chain. */
export function routeText(route: ResolvedRoute): string {
  if (!route.model) return `the turn's model`;
  const parts = [`${route.model} (${sourceText(route.source)})`];
  if (route.thinking) parts.push(`thinking ${route.thinking}`);
  if (route.fallback.length > 0) parts.push(`then ${route.fallback.map(stepText).join(", ")}`);
  return parts.join(" · ");
}

/** The lines `/profile` shows: the profiles in force, then the route of the main turn and of each subagent, each with its source. */
export function routingReport({
  active,
  subagents,
  engine,
  problems = [],
}: {
  active: readonly ActiveProfile[];
  subagents: readonly { name: string; model?: string }[];
  engine: RoutingEngine;
  problems?: readonly string[];
}): string[] {
  const lines: string[] = [];
  if (active.length === 0) lines.push("No profile is in force: each subagent uses its agent file's model, else the turn's model.");
  for (const entry of active) lines.push(`${entry.source === "session" ? "Session profile" : "Default profile"}: ${entry.name}`);
  const primary = resolveRoute({ active, engine });
  lines.push(`Main turn (primary): ${primary.model ? routeText(primary) : "the model you chose"}`);
  for (const sub of subagents) lines.push(`${sub.name}: ${routeText(resolveRoute({ active, name: sub.name, agentModel: sub.model, engine }))}`);
  // A route that is skipped on this engine is said, or a profile for the other engine would seem to do nothing.
  for (const entry of active) {
    for (const [key, route] of Object.entries(entry.profile)) {
      if (!engine.fits(route.model)) lines.push(`Skipped on ${engine.id}: profile ${entry.name}, route ${key}: "${route.model}" does not fit.`);
    }
  }
  for (const problem of problems) lines.push(`Ignored: ${problem}`);
  return lines;
}

/**
 * The chain of a launch in the order to try it: the model, then its fallbacks, each once. Models that are cooling down go after the usable
 * ones (kept in their order), so a launch starts on the first model that can answer; when all are cooling the order is kept.
 */
export function launchChain(model: string, fallback: readonly ModelStep[], isCooling: (model: string) => boolean, thinking?: string): ModelStep[] {
  const seen = new Set<string>();
  const chain: ModelStep[] = [{ model, ...(thinking ? { thinking } : {}) }, ...fallback].filter((step) => !seen.has(step.model) && (seen.add(step.model), true));
  const usable = chain.filter((step) => !isCooling(step.model));
  return usable.length === 0 ? chain : [...usable, ...chain.filter((step) => isCooling(step.model))];
}
