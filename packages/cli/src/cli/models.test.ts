import { beforeEach, describe, expect, test } from "bun:test";
import { SUPPORTED_CHAT_MODELS } from "../lib/models";
import { modelsCommand, type PiModelSource } from "./models";

let out: string;
let err: string;
const io = { stdout: (text: string) => void (out += text), stderr: (text: string) => void (err += text) };

const model = (provider: string, id: string, name: string) => ({ provider, id, name });
/** A runtime that knows three models and has credentials for anthropic only. */
const runtime: PiModelSource = {
  getModels: () => [model("openai", "gpt-x", "GPT X"), model("anthropic", "claude-b", "Claude B"), model("anthropic", "claude-a", "Claude A")] as never,
  getAvailable: async () => [model("anthropic", "claude-b", "Claude B"), model("anthropic", "claude-a", "Claude A")] as never,
};

beforeEach(() => {
  out = "";
  err = "";
});

describe("models", () => {
  test("--engine claude lists the aliases, one per line", async () => {
    expect(await modelsCommand({ kind: "models", engine: "claude" }, { io })).toBe(0);
    expect(out).toBe(`${SUPPORTED_CHAT_MODELS.map((m) => m.id).join("\n")}\n`);
  });

  test("--engine pi lists every model, marking the ones with credentials", async () => {
    expect(await modelsCommand({ kind: "models", engine: "pi" }, { io, getRuntime: async () => runtime })).toBe(0);
    expect(out).toBe(
      ["* anthropic/claude-a  Claude A", "* anthropic/claude-b  Claude B", "  openai/gpt-x  GPT X", "", "* has credentials; /login in the interface adds more", ""].join("\n"),
    );
    expect(err).toBe("");
  });

  test("without --engine both engines are listed under their names", async () => {
    expect(await modelsCommand({ kind: "models" }, { io, getRuntime: async () => runtime })).toBe(0);
    expect(out).toStartWith("claude\n  opus\n  sonnet\n  haiku\n\npi\n  * anthropic/claude-a  Claude A\n");
  });

  test("a pi runtime that fails exits 1, and the Claude models are still listed", async () => {
    const code = await modelsCommand(
      { kind: "models" },
      {
        io,
        getRuntime: async () => {
          throw new Error("no runtime");
        },
      },
    );
    expect(code).toBe(1);
    expect(out).toStartWith("claude\n  opus\n");
    expect(err).toBe("marcsh: cannot list the pi models: no runtime\n");
  });

  test("--engine pi with no model at all says so", async () => {
    const empty: PiModelSource = { getModels: () => [], getAvailable: async () => [] };
    expect(await modelsCommand({ kind: "models", engine: "pi" }, { io, getRuntime: async () => empty })).toBe(0);
    expect(out).toBe("No pi models.\n");
  });

  test("model names cannot send terminal escapes", async () => {
    const evil: PiModelSource = { getModels: () => [model("p", "i", "bad\x1b[2Jname")] as never, getAvailable: async () => [] };
    await modelsCommand({ kind: "models", engine: "pi" }, { io, getRuntime: async () => evil });
    expect(out).not.toContain("\x1b");
  });
});
