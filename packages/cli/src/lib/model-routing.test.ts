import { describe, expect, test } from "bun:test";
import { agentModelFits } from "./agents";
import { launchChain, matchRoute, primaryModel, resolveRoute, routeText, routingReport, type RoutingEngine } from "./model-routing";
import { activeProfiles, parseProfiles, type Profile } from "./profiles";

const pi: RoutingEngine = { id: "pi", fits: (model) => agentModelFits(model, "pi") };
const claude: RoutingEngine = { id: "claude", fits: (model) => agentModelFits(model, "claude") };

const file = (profiles: Record<string, Profile>, defaultName?: string) => parseProfiles({ version: 1, ...(defaultName ? { default: defaultName } : {}), profiles }).file;

describe("matchRoute", () => {
  const profile: Profile = {
    refuter: { model: "a/exact" },
    "review-*": { model: "a/review" },
    "review-sec*": { model: "a/review-sec" },
    "*": { model: "a/any" },
    primary: { model: "a/primary" },
  };

  test("the exact name, then the longest prefix glob, then `*`", () => {
    expect(matchRoute(profile, "refuter")).toMatchObject({ key: "refuter" });
    expect(matchRoute(profile, "review-style")).toMatchObject({ key: "review-*" });
    expect(matchRoute(profile, "review-security")).toMatchObject({ key: "review-sec*" });
    expect(matchRoute(profile, "worker")).toMatchObject({ key: "*" });
  });

  test("a glob does not match a shorter name, and without `*` there is no match", () => {
    const { "*": _any, ...noAny } = profile;
    expect(matchRoute(noAny, "review")).toBeUndefined();
    expect(matchRoute(noAny, "worker")).toBeUndefined();
  });

  test("`primary` is the main turn's key: a subagent named primary gets `*`, and `*` never matches the main turn", () => {
    expect(matchRoute(profile, "primary")).toMatchObject({ key: "*" });
    const active = activeProfiles(file({ p: { "*": { model: "a/any" } } }), "p");
    expect(resolveRoute({ active, engine: pi }).source.kind).toBe("turn");
  });
});

describe("resolveRoute precedence", () => {
  const f = file({ session: { "review-*": { model: "s/review", thinking: "high", fallback: [{ model: "s/fb" }] } }, base: { "*": { model: "d/any", thinking: "low" }, "review-x": { model: "d/exact" } } }, "base");

  test("session profile, then default profile, then the agent file's model, then the turn's", () => {
    const withSession = activeProfiles(f, "session");
    // The session's `review-*` wins over the default's exact key: sources are tried in order, then keys inside one.
    expect(resolveRoute({ active: withSession, name: "review-x", agentModel: "f/front", engine: pi })).toMatchObject({ model: "s/review", thinking: "high", source: { kind: "profile", origin: "session", profile: "session", key: "review-*" } });
    // Nothing in the session profile matches `worker`: the default's `*`.
    expect(resolveRoute({ active: withSession, name: "worker", agentModel: "f/front", engine: pi })).toMatchObject({ model: "d/any", thinking: "low", source: { origin: "default", key: "*" } });
    // No profile at all: the agent file, then the turn.
    expect(resolveRoute({ active: [], name: "worker", agentModel: "f/front", engine: pi })).toEqual({ model: "f/front", fallback: [], source: { kind: "agent" } });
    expect(resolveRoute({ active: [], name: "worker", engine: pi })).toEqual({ fallback: [], source: { kind: "turn" } });
  });

  test("the default alone applies when the session chose nothing", () => {
    expect(resolveRoute({ active: activeProfiles(f, undefined), name: "review-x", engine: pi })).toMatchObject({ model: "d/exact", source: { origin: "default" } });
  });

  test("a route whose model does not fit the engine is skipped, and the next source is tried", () => {
    const g = file({ session: { "*": { model: "sonnet" } }, base: { "*": { model: "d/any" } } }, "base");
    // On pi `sonnet` is not provider/id: the default's route is used instead.
    expect(resolveRoute({ active: activeProfiles(g, "session"), name: "w", engine: pi })).toMatchObject({ model: "d/any", source: { origin: "default" } });
    // On Claude it is `d/any` that does not fit; the session's route is first anyway.
    expect(resolveRoute({ active: activeProfiles(g, "session"), name: "w", engine: claude })).toMatchObject({ model: "sonnet", source: { origin: "session" } });
    // Nothing fits: the agent file's model, if it fits, else the turn's.
    const h = file({ p: { "*": { model: "gpt-4o" } } });
    expect(resolveRoute({ active: activeProfiles(h, "p"), name: "w", agentModel: "haiku", engine: claude })).toMatchObject({ model: "haiku", source: { kind: "agent" } });
    expect(resolveRoute({ active: activeProfiles(h, "p"), name: "w", agentModel: "haiku", engine: pi })).toEqual({ fallback: [], source: { kind: "turn" } });
  });

  test("an agent file model that does not fit the engine is skipped, as before", () => {
    expect(resolveRoute({ active: [], name: "w", agentModel: "sonnet", engine: pi })).toEqual({ fallback: [], source: { kind: "turn" } });
    expect(resolveRoute({ active: [], name: "w", agentModel: "gpt-4o", engine: claude })).toEqual({ fallback: [], source: { kind: "turn" } });
  });

  test("a route is a unit: thinking and fallback come from the route that gave the model, never mixed from another profile", () => {
    const g = file({ session: { "*": { model: "s/m" } }, base: { "*": { model: "d/m", thinking: "max", fallback: [{ model: "d/fb" }] } } }, "base");
    expect(resolveRoute({ active: activeProfiles(g, "session"), name: "w", engine: pi })).toEqual({ model: "s/m", fallback: [], source: { kind: "profile", profile: "session", origin: "session", key: "*" } });
  });

  test("the fallback chain keeps the models that fit the engine, without the route's own model", () => {
    const g = file({ p: { "*": { model: "a/m", fallback: [{ model: "sonnet" }, { model: "b/x", thinking: "high" }, { model: "a/m" }] } } });
    expect(resolveRoute({ active: activeProfiles(g, "p"), name: "w", engine: pi }).fallback).toEqual([{ model: "b/x", thinking: "high" }]);
  });

  test("thinking is pi's only: on Claude it is dropped, from the route and from its fallbacks", () => {
    const g = file({ p: { "*": { model: "opus", thinking: "high", fallback: [{ model: "haiku", thinking: "low" }] } } });
    const route = resolveRoute({ active: activeProfiles(g, "p"), name: "w", engine: claude });
    expect(route).toMatchObject({ model: "opus", fallback: [{ model: "haiku" }] });
    expect(route.thinking).toBeUndefined();
    expect(route.fallback[0]!.thinking).toBeUndefined();
  });

  test("the main turn's route is `primary`: the first profile that has a usable one", () => {
    const g = file({ session: { primary: { model: "gpt-4o" } }, base: { primary: { model: "a/p", thinking: "medium", fallback: [{ model: "b/q" }] } } }, "base");
    expect(primaryModel(activeProfiles(g, "session"), pi)).toBe("a/p");
    expect(resolveRoute({ active: activeProfiles(g, "session"), engine: pi })).toMatchObject({ thinking: "medium", fallback: [{ model: "b/q" }] });
    expect(primaryModel(activeProfiles(g, "session"), claude)).toBeUndefined();
    expect(primaryModel([], pi)).toBeUndefined();
  });
});

describe("launchChain", () => {
  test("the model, then its fallbacks, each once", () => {
    expect(launchChain("a/1", [{ model: "a/2" }, { model: "a/1" }, { model: "a/3", thinking: "low" }], () => false).map((s) => s.model)).toEqual(["a/1", "a/2", "a/3"]);
  });

  test("a cooling model goes behind the usable ones; with all cooling the order is kept", () => {
    const chain = (cooling: string[]) => launchChain("a/1", [{ model: "a/2" }, { model: "a/3" }], (m) => cooling.includes(m)).map((s) => s.model);
    expect(chain(["a/1"])).toEqual(["a/2", "a/3", "a/1"]);
    expect(chain(["a/1", "a/3"])).toEqual(["a/2", "a/1", "a/3"]);
    expect(chain(["a/1", "a/2", "a/3"])).toEqual(["a/1", "a/2", "a/3"]);
  });

  test("the route's thinking belongs to its model", () => {
    expect(launchChain("a/1", [{ model: "a/2" }], () => false, "high")[0]).toEqual({ model: "a/1", thinking: "high" });
  });
});

describe("what /profile shows", () => {
  const f = file({ fast: { primary: { model: "a/main", fallback: [{ model: "a/backup", thinking: "low" }] }, "review-*": { model: "a/cheap", thinking: "low" }, "*": { model: "sonnet" } } }, "fast");

  test("the profiles in force, the main turn, and each subagent with the source of its model", () => {
    const text = routingReport({
      active: activeProfiles(f, undefined),
      subagents: [{ name: "review-style" }, { name: "worker", model: "a/own" }, { name: "plain" }],
      engine: pi,
    }).join("\n");
    expect(text).toContain("Default profile: fast");
    expect(text).toContain("Main turn (primary): a/main (default profile fast, route primary) · then a/backup (low)");
    expect(text).toContain("review-style: a/cheap (default profile fast, route review-*) · thinking low");
    // `*` has a Claude name: skipped on pi, so the agent file's model, then the turn's.
    expect(text).toContain("worker: a/own (agent file)");
    expect(text).toContain("plain: the turn's model");
    expect(text).toContain('Skipped on pi: profile fast, route *: "sonnet" does not fit.');
  });

  test("with no profile it says so, and invalid parts are listed", () => {
    const text = routingReport({ active: [], subagents: [], engine: claude, problems: ["profile \"x\" must be an object of routes"] }).join("\n");
    expect(text).toContain("No profile is in force");
    expect(text).toContain("Main turn (primary): the model you chose");
    expect(text).toContain('Ignored: profile "x" must be an object of routes');
  });

  test("routeText names the model's source", () => {
    expect(routeText(resolveRoute({ active: activeProfiles(f, "fast"), name: "review-a", engine: pi }))).toBe("a/cheap (session profile fast, route review-*) · thinking low");
    expect(routeText({ fallback: [], source: { kind: "turn" } })).toBe("the turn's model");
  });
});
