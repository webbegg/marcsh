import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import type { ClaudeCommand } from "./claude-commands";
import { marcshPluginPath } from "./plugin";

type Call = { prompt: AsyncIterable<unknown>; options: any };

let calls: Call[] = [];
let received: unknown[] = [];
let pumps: Promise<void>[] = [];
let closeCalls = 0;
let fetchCommands: () => Promise<unknown> = async () => [];
let closeError: Error | null = null;
let queryError: Error | null = null;

// Fake query(): consumes the prompt like the SDK does and never answers it (no model call is made).
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt, options }: Call) => {
    if (queryError) throw queryError;
    calls.push({ prompt, options });
    pumps.push(
      (async () => {
        for await (const message of prompt) received.push(message);
      })(),
    );
    const messages = (async function* () {})();
    return Object.assign(messages, {
      supportedCommands: () => fetchCommands(),
      close: () => {
        closeCalls += 1;
        if (closeError) throw closeError;
      },
    });
  },
}));

const { warmUpClaudeCommands } = await import("./command-warmup");

const PROBE = { name: "marcsh:feature", description: "Create a feature doc", argumentHint: "<feature-name>", builtin: false };

let saved: ClaudeCommand[][] = [];
const save = (commands: ClaudeCommand[]) => {
  saved.push(commands);
};

beforeEach(() => {
  calls = [];
  received = [];
  pumps = [];
  closeCalls = 0;
  saved = [];
  closeError = null;
  queryError = null;
  fetchCommands = async () => [PROBE];
});

describe("warmUpClaudeCommands", () => {
  test("starts a query with an idle streaming prompt, no persisted session, the settings sources and the marcsh plugin", async () => {
    await warmUpClaudeCommands({ cwd: "/tmp/warm", save });

    expect(calls).toHaveLength(1);
    const { prompt, options } = calls[0]!;
    expect(typeof prompt).toBe("object");
    expect(typeof (prompt as any)[Symbol.asyncIterator]).toBe("function");
    expect(options.cwd).toBe("/tmp/warm");
    expect(options.persistSession).toBe(false);
    expect(options.settingSources).toEqual(["user", "project", "local"]);
    expect(options.plugins).toEqual([{ type: "local", path: marcshPluginPath() }]);
    expect(options.plugins[0].path).toBe(join(import.meta.dir, "..", "..", "plugin"));
  });

  test("saves the normalized list and closes the query", async () => {
    await warmUpClaudeCommands({ cwd: "/tmp/warm", save });

    expect(saved).toEqual([[{ name: "marcsh:feature", description: "Create a feature doc", argumentHint: "<feature-name>" }]]);
    expect(closeCalls).toBe(1);
  });

  test("never sends a message through the prompt, and the idle prompt ends after the warm-up", async () => {
    await warmUpClaudeCommands({ cwd: "/tmp/warm", save });
    await Promise.all(pumps);

    expect(received).toEqual([]);
  });

  test("does not save an empty list", async () => {
    fetchCommands = async () => [];
    await warmUpClaudeCommands({ cwd: "/tmp/warm", save });

    expect(saved).toEqual([]);
    expect(closeCalls).toBe(1);
  });

  test("closes and resolves when supportedCommands() throws", async () => {
    fetchCommands = async () => {
      throw new Error("not supported");
    };
    await warmUpClaudeCommands({ cwd: "/tmp/warm", save });
    await Promise.all(pumps);

    expect(saved).toEqual([]);
    expect(closeCalls).toBe(1);
  });

  test("closes and resolves when supportedCommands() does not answer in time", async () => {
    fetchCommands = () => new Promise(() => {});
    await warmUpClaudeCommands({ cwd: "/tmp/warm", save, timeoutMs: 20 });
    await Promise.all(pumps);

    expect(saved).toEqual([]);
    expect(closeCalls).toBe(1);
  });

  test("never throws: a failing save, a failing close", async () => {
    closeError = new Error("close failed");
    await warmUpClaudeCommands({
      cwd: "/tmp/warm",
      save: () => {
        throw new Error("disk full");
      },
    });

    expect(closeCalls).toBe(1);
  });

  test("never throws when query() itself throws", async () => {
    queryError = new Error("no cli");

    await warmUpClaudeCommands({ cwd: "/tmp/warm", save });

    expect(saved).toEqual([]);
  });
});
