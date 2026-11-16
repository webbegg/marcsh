import { describe, expect, mock, test } from "bun:test";

// The options `query()` of the Claude SDK really receives for a turn with a profile's route: its model, subagents' models and fallbackModel.

let calls: Array<{ prompt: unknown; options: Record<string, any> }> = [];

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt, options }: { prompt: unknown; options: Record<string, any> }) => {
    calls.push({ prompt, options });
    const messages = (async function* () {
      yield { type: "system", subtype: "init", session_id: "claude-1", model: options.model };
      yield { type: "result", subtype: "success", is_error: false, result: "ok", duration_ms: 1, total_cost_usd: 0 };
    })();
    return Object.assign(messages, { interrupt: async () => {}, supportedCommands: async () => [] });
  },
}));

const { Mode } = await import("../modes");
const { claudeEngine } = await import("./claude");

async function run(overrides: Record<string, unknown>) {
  calls = [];
  const host = { emit: () => {}, askPermission: async () => "deny" as const, askQuestions: async () => null };
  await claudeEngine.startTurn({ prompt: "hi", cwd: "/tmp/marcsh-cwd", mode: Mode.BUILD, model: "opus", signal: new AbortController().signal, ...overrides } as never, host as never).done;
  return calls[0]!.options;
}

describe("a Claude turn with a profile's routes", () => {
  test("the SDK gets the primary route's first fallback as fallbackModel and each routed subagent's model", async () => {
    const options = await run({
      routing: { model: "opus", fallback: [{ model: "sonnet" }, { model: "haiku" }] },
      subagents: [
        { name: "refuter", readOnly: true, model: "haiku" },
        { name: "worker", readOnly: false },
      ],
    });
    expect(options.model).toBe("opus");
    expect(options.fallbackModel).toBe("sonnet");
    expect(options.agents.refuter.model).toBe("haiku");
    expect(options.agents.worker.model).toBe("inherit");
  });

  test("without a profile the options are what they were: no fallbackModel", async () => {
    const options = await run({});
    expect("fallbackModel" in options).toBe(false);
  });
});
