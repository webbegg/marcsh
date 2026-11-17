import { describe, expect, test } from "bun:test";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { parseSubagentFile } from "../agent-file";
import { turnSubagents } from "../agents";
import { Mode } from "../modes";
import { activeProfiles, parseProfiles } from "../profiles";
import { claudeQueryOptions } from "./claude";

// Model profiles on the Claude engine: a routed subagent model goes to the SDK's `agents` option, and the main turn's route gives its
// first fallback as `fallbackModel`. Thinking levels are pi's only.

const base = { cwd: "/tmp/marcsh-cwd", mode: Mode.BUILD, model: "opus", abortController: new AbortController(), plugins: [] as string[] };
const noAsk: CanUseTool = async () => ({ behavior: "deny", message: "unused" });
const file = (profiles: Record<string, unknown>, defaultName?: string) => parseProfiles({ version: 1, ...(defaultName ? { default: defaultName } : {}), profiles }).file;
const agent = (name: string, frontmatter = "") => parseSubagentFile(`---\nmode: subagent\n${frontmatter}\n---\nYou are ${name}.`, { pack: "user", file: `${name}.md` })!;

describe("Claude: the main turn's fallback", () => {
  test("the first fallback of the primary route that fits Claude is sent as fallbackModel", () => {
    const sent = claudeQueryOptions({ ...base, routing: { model: "opus", fallback: [{ model: "openai/gpt-5" }, { model: "sonnet" }, { model: "haiku" }] }, canUseTool: noAsk });
    expect(sent.fallbackModel).toBe("sonnet");
    expect(sent.model).toBe("opus");
  });

  test("none is sent without a chain, when no step fits Claude, or when the step is the turn's own model", () => {
    expect("fallbackModel" in claudeQueryOptions({ ...base, canUseTool: noAsk })).toBe(false);
    expect("fallbackModel" in claudeQueryOptions({ ...base, routing: { fallback: [] }, canUseTool: noAsk })).toBe(false);
    expect("fallbackModel" in claudeQueryOptions({ ...base, routing: { fallback: [{ model: "openai/gpt-5" }] }, canUseTool: noAsk })).toBe(false);
    expect("fallbackModel" in claudeQueryOptions({ ...base, model: "opus", routing: { fallback: [{ model: "opus" }] }, canUseTool: noAsk })).toBe(false);
    // The turn's own model is passed over for the next one that fits.
    expect(claudeQueryOptions({ ...base, model: "opus", routing: { fallback: [{ model: "opus" }, { model: "sonnet" }] }, canUseTool: noAsk }).fallbackModel).toBe("sonnet");
  });

  test("the turn's model is the session's, whatever the route says: thinking is not sent, there is none on Claude", () => {
    const sent = claudeQueryOptions({ ...base, model: "haiku", routing: { model: "opus", thinking: "high", fallback: [{ model: "sonnet", thinking: "low" }] }, canUseTool: noAsk });
    expect(sent.model).toBe("haiku");
    expect(sent.fallbackModel).toBe("sonnet");
    expect(JSON.stringify(sent)).not.toContain("thinking");
    expect("effort" in sent).toBe(false);
  });
});

describe("Claude: a routed subagent", () => {
  const route = (profiles: Record<string, unknown>, defaultName?: string, session?: string, frontmatter = "") =>
    claudeQueryOptions({ ...base, subagents: turnSubagents({ pack: undefined }, [agent("refuter", frontmatter)], { active: activeProfiles(file(profiles, defaultName), session), engine: "claude" }), canUseTool: noAsk }).agents!;

  test("the routed model is the `model` of its definition", () => {
    expect(route({ fast: { "review-*": { model: "sonnet" }, refuter: { model: "haiku" } } }, undefined, "fast").refuter!.model).toBe("haiku");
    expect(route({ fast: { "*": { model: "claude-sonnet-4-5" } } }, "fast").refuter!.model).toBe("claude-sonnet-4-5");
  });

  test("precedence: session profile, default profile, the agent file's model, then the session's (inherit)", () => {
    const profiles = { session: { refuter: { model: "haiku" } }, base: { "*": { model: "sonnet" } } };
    expect(route(profiles, "base", "session", "model: opus").refuter!.model).toBe("haiku");
    expect(route(profiles, "base", undefined, "model: opus").refuter!.model).toBe("sonnet");
    expect(route({}, undefined, undefined, "model: opus").refuter!.model).toBe("opus");
    expect(route({}, undefined, undefined, "").refuter!.model).toBe("inherit");
  });

  test("a route that is a pi model is skipped on Claude, as the agent file's would be", () => {
    expect(route({ p: { "*": { model: "anthropic/claude-sonnet-5-5" } } }, undefined, "p", "model: haiku").refuter!.model).toBe("haiku");
    expect(route({ p: { "*": { model: "anthropic/claude-sonnet-5-5" } } }, undefined, "p").refuter!.model).toBe("inherit");
  });

  test("the definition carries no thinking and no fallback: the SDK's agents have neither here", () => {
    const definition = route({ p: { "*": { model: "sonnet", thinking: "high", fallback: [{ model: "haiku" }] } } }, "p").refuter!;
    expect(definition.model).toBe("sonnet");
    expect(Object.keys(definition).sort()).toEqual(["description", "model", "prompt"].sort());
  });
});
