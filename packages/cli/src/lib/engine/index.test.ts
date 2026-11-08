import { describe, expect, test } from "bun:test";
import { claudeEngine } from "./claude";
import {
  DEFAULT_ENGINE_ID,
  ENGINE_IDS,
  ENGINE_LABELS,
  createEngineRegistry,
  getEngine,
  isEngineId,
  unknownEngine,
} from "./index";
import type { Engine, EngineEvent, TurnHost, TurnRequest } from "./types";

const fakeEngine = (id: string): Engine => ({
  id,
  startTurn: () => ({ done: Promise.resolve(), interrupt() {} }),
  warmUpCommands: async () => {},
});

describe("engine registry", () => {
  test("lists claude and pi, with claude as the default and a label for each", () => {
    expect([...ENGINE_IDS]).toEqual(["claude", "pi"]);
    expect(DEFAULT_ENGINE_ID).toBe("claude");
    expect(ENGINE_LABELS).toEqual({ claude: "Claude (Agent SDK)", pi: "pi" });
  });

  test("isEngineId accepts only the listed ids", () => {
    expect(isEngineId("claude")).toBe(true);
    expect(isEngineId("pi")).toBe(true);
    expect(isEngineId("gpt")).toBe(false);
    expect(isEngineId(undefined)).toBe(false);
    expect(isEngineId(3)).toBe(false);
  });

  test("getEngine returns the Claude engine and a pi engine, and undefined for anything else", () => {
    expect(getEngine("claude")).toBe(claudeEngine);
    expect(getEngine("pi")?.id).toBe("pi");
    expect(getEngine("pi")).toBe(getEngine("pi"));
    expect(getEngine("gpt")).toBeUndefined();
    expect(getEngine("")).toBeUndefined();
    expect(getEngine("toString")).toBeUndefined();
  });

  test("the pi engine is created lazily and only once", () => {
    let created = 0;
    const pi = fakeEngine("pi");
    const registry = createEngineRegistry(() => {
      created += 1;
      return pi;
    });

    expect(created).toBe(0);
    expect(registry.get("claude")).toBe(claudeEngine);
    expect(created).toBe(0);
    expect(registry.get("pi")).toBe(pi);
    expect(registry.get("pi")).toBe(pi);
    expect(created).toBe(1);
  });

  test("a replaced engine is returned until it is cleared", () => {
    const registry = createEngineRegistry(() => fakeEngine("pi"));
    const replacement = fakeEngine("claude");

    registry.set("claude", replacement);
    expect(registry.get("claude")).toBe(replacement);

    registry.set("claude", undefined);
    expect(registry.get("claude")).toBe(claudeEngine);
  });
});

describe("unknownEngine", () => {
  test("a turn reports the unknown engine id and ends without running anything", async () => {
    const events: EngineEvent[] = [];
    const host: TurnHost = {
      emit: (event) => events.push(event),
      askPermission: async () => "deny",
      askQuestions: async () => null,
    };
    const request: TurnRequest = {
      prompt: "hi",
      cwd: "/tmp",
      mode: "BUILD",
      model: "opus",
      signal: new AbortController().signal,
    };

    const turn = unknownEngine("gpt").startTurn(request, host);
    await turn.done;

    expect(events).toEqual([{ type: "error", message: "This session uses an unknown engine: gpt" }]);
  });
});
