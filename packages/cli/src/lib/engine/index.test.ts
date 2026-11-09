import { describe, expect, test } from "bun:test";
import { claudeEngine } from "./claude";
import {
  DEFAULT_ENGINE_ID,
  ENGINE_IDS,
  ENGINE_LABELS,
  createEngineRegistry,
  getEngine,
  isEngineId,
  piHandle,
  unknownEngine,
  warmUpEngineCommands,
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

describe("warmUpEngineCommands", () => {
  const commands = [{ name: "deploy", description: "", argumentHint: "", source: "extension" }];

  test("warms up only the engine asked for: Claude's warm-up never creates pi", async () => {
    let created = 0;
    const warmed: string[] = [];
    const claude: Engine = { ...fakeEngine("claude"), warmUpCommands: async () => void warmed.push("claude") };
    const registry = createEngineRegistry(() => {
      created += 1;
      return fakeEngine("pi");
    });
    registry.set("claude", claude);

    await warmUpEngineCommands("claude", { registry, save: () => {} });

    expect(warmed).toEqual(["claude"]);
    expect(created).toBe(0);
  });

  test("passes the directory and the saver to the engine, and what it lists is saved", async () => {
    const saved: unknown[] = [];
    const seen: string[] = [];
    const registry = createEngineRegistry(() => ({
      ...fakeEngine("pi"),
      warmUpCommands: async ({ cwd, save }) => {
        seen.push(cwd);
        save(commands);
      },
    }));

    await warmUpEngineCommands("pi", { cwd: "/work", registry, save: (list) => saved.push(list) });

    expect(seen).toEqual(["/work"]);
    expect(saved).toEqual([commands]);
  });

  test("never throws: an engine that fails, or an id nobody knows, is ignored", async () => {
    const registry = createEngineRegistry(() => ({
      ...fakeEngine("pi"),
      warmUpCommands: async () => {
        throw new Error("pi could not start");
      },
    }));

    await warmUpEngineCommands("pi", { registry, save: () => {} });
    await warmUpEngineCommands("gpt", { registry, save: () => {} });
  });
});

describe("pi runtime handle", () => {
  test("getPiRuntime and getPiDeviceId go through the registered pi engine, so the engine and the dialogs share one runtime", async () => {
    const runtime = { marker: "shared" } as never;
    const pi = { ...fakeEngine("pi"), getRuntime: async () => runtime, getDeviceId: async () => "device-1" };
    const registry = createEngineRegistry(() => pi);
    registry.set("pi", pi);

    expect(await piHandle(registry).getRuntime()).toBe(runtime);
    expect(await piHandle(registry).getDeviceId()).toBe("device-1");
  });

  test("an engine without a runtime (a test double) rejects with a clear message", async () => {
    const registry = createEngineRegistry(() => fakeEngine("pi"));

    await expect(piHandle(registry).getRuntime()).rejects.toThrow("The pi engine has no model runtime");
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
