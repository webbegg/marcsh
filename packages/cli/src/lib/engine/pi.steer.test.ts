import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, InMemoryCredentialStore, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { ChatMessage } from "../chat-types";
import { Mode } from "../modes";
import { openStorage } from "../storage";
import { createPiEngine } from "./pi";
import { trustEveryProject } from "./test-trust";
import { TurnClosedError, type EngineEvent, type TurnHost } from "./types";

let dir: string;
let agentDir: string;
let cwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-steer-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function setup(responses: FauxResponseStep[]) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }], tokensPerSecond: 2000, tokenSize: { min: 1, max: 1 } });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses(responses);
  const engine = createPiEngine({ agentDir, modelRuntime, permissionRules: openStorage(":memory:"), projectTrust: trustEveryProject });
  return { engine, faux, model: "faux/faux-1" };
}

// A response the test holds back until `release()`; `started` resolves once the model is asked for it.
function gated(text: string) {
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const contexts: string[][] = [];
  const step: FauxResponseStep = async (context) => {
    contexts.push(userTexts(context.messages));
    started.resolve();
    await gate.promise;
    return fauxAssistantMessage([fauxText(text)]);
  };
  return { step, started: started.promise, release: () => gate.resolve(), contexts };
}

// A response that records what the model was shown.
function recording(text: string) {
  const contexts: string[][] = [];
  const step: FauxResponseStep = (context) => {
    contexts.push(userTexts(context.messages));
    return fauxAssistantMessage([fauxText(text)]);
  };
  return { step, contexts };
}

function userTexts(messages: ReadonlyArray<{ role: string; content?: unknown }>): string[] {
  return messages
    .filter((m) => m.role === "user")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : (m.content as Array<{ type: string; text?: string }>).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join(""),
    );
}

function begin(engine: ReturnType<typeof createPiEngine>, model: string) {
  const events: EngineEvent[] = [];
  let reply: ChatMessage = { id: "reply", role: "assistant", parts: [] };
  const host: TurnHost = {
    emit: (event) => {
      events.push(event);
      if (event.type === "reply") reply = event.update(reply);
    },
    askPermission: async () => "allow",
    askQuestions: async () => null,
  };
  const controller = new AbortController();
  const turn = engine.startTurn({ prompt: "hello", cwd, mode: Mode.BUILD, model, signal: controller.signal }, host);
  return { turn, events, controller, reply: () => reply };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const textOf = (reply: ChatMessage) => reply.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("|");
const queues = (events: EngineEvent[]) => events.flatMap((e) => (e.type === "queue" ? [{ steering: e.steering, followUp: e.followUp }] : []));
const delivered = (events: EngineEvent[]) => events.flatMap((e) => (e.type === "delivered" ? [{ kind: e.kind, text: e.text }] : []));

describe("a pi turn takes steers and follow-ups (S4)", () => {
  test("offers steer and followUp on the turn", async () => {
    const first = recording("ok");
    const { engine, model } = await setup([first.step]);

    const running = begin(engine, model);
    await running.turn.done;

    expect(typeof running.turn.steer).toBe("function");
    expect(typeof running.turn.followUp).toBe("function");
  }, 20000);

  test("a steer sent while the response is generated reaches the model in the same turn", async () => {
    const first = gated("first answer");
    const second = recording("second answer");
    const { engine, faux, model } = await setup([first.step, second.step]);

    const running = begin(engine, model);
    await first.started;
    await running.turn.steer!("take the other road");
    first.release();
    await running.turn.done;

    expect(faux.state.callCount).toBe(2);
    expect(second.contexts[0]).toEqual(["hello", "take the other road"]);
    // The host heard it was waiting, then that it was delivered, and the reply carries both answers.
    expect(queues(running.events)[0]).toEqual({ steering: ["take the other road"], followUp: [] });
    expect(queues(running.events).at(-1)).toEqual({ steering: [], followUp: [] });
    expect(delivered(running.events)).toEqual([{ kind: "steer", text: "take the other road" }]);
    expect(textOf(running.reply())).toBe("first answer|second answer");
  }, 20000);

  test("the first answer reaches the host before the steer is reported as delivered", async () => {
    const first = gated("first answer");
    const second = recording("second answer");
    const { engine, model } = await setup([first.step, second.step]);

    const running = begin(engine, model);
    await first.started;
    await running.turn.steer!("redirect");
    first.release();
    await running.turn.done;

    const order = running.events.flatMap((e, i) => {
      if (e.type === "delivered") return [{ i, what: "delivered" }];
      if (e.type === "reply" && textOf(e.update({ id: "x", role: "assistant", parts: [] })) === "first answer") return [{ i, what: "first" }];
      return [];
    });
    expect(order.map((o) => o.what)).toEqual(["first", "delivered"]);
  }, 20000);

  test("a follow-up is sent after the current response, as a message of its own", async () => {
    const first = gated("first answer");
    const second = recording("second answer");
    const { engine, faux, model } = await setup([first.step, second.step]);

    const running = begin(engine, model);
    await first.started;
    await running.turn.followUp!("and then this");
    await sleep(50);
    // Still generating the first response: nothing else was asked of the model yet.
    expect(faux.state.callCount).toBe(1);
    expect(queues(running.events).at(-1)).toEqual({ steering: [], followUp: ["and then this"] });
    first.release();
    await running.turn.done;

    expect(faux.state.callCount).toBe(2);
    expect(first.contexts[0]).toEqual(["hello"]);
    expect(second.contexts[0]).toEqual(["hello", "and then this"]);
    expect(delivered(running.events)).toEqual([{ kind: "followUp", text: "and then this" }]);
    expect(queues(running.events).at(-1)).toEqual({ steering: [], followUp: [] });
    expect(textOf(running.reply())).toBe("first answer|second answer");
  }, 20000);

  test("a steer sent before the model is asked is not lost", async () => {
    const first = recording("first answer");
    const second = recording("second answer");
    const { engine, model } = await setup([first.step, second.step]);

    const running = begin(engine, model);
    await running.turn.steer!("early words");
    await running.turn.done;

    const seen = [...first.contexts, ...second.contexts].flat();
    expect(seen).toContain("early words");
    expect(delivered(running.events)).toEqual([{ kind: "steer", text: "early words" }]);
  }, 20000);

  test("interrupting discards the follow-ups pi has not sent, and nothing runs after", async () => {
    const first = gated("first answer");
    const second = recording("never asked");
    const { engine, faux, model } = await setup([first.step, second.step]);

    const running = begin(engine, model);
    await first.started;
    await running.turn.followUp!("later one");
    await running.turn.followUp!("later two");
    await running.turn.steer!("and a steer");
    expect(queues(running.events).at(-1)).toEqual({ steering: ["and a steer"], followUp: ["later one", "later two"] });

    running.turn.interrupt();
    first.release();
    await running.turn.done;
    await sleep(100);

    expect(queues(running.events).at(-1)).toEqual({ steering: [], followUp: [] });
    expect(delivered(running.events)).toEqual([]);
    expect(faux.state.callCount).toBe(1);
    expect(second.contexts).toEqual([]);
  }, 20000);

  test("an abort signal discards them the same way, and later steers are ignored", async () => {
    const first = gated("first answer");
    const second = recording("never asked");
    const { engine, faux, model } = await setup([first.step, second.step]);

    const running = begin(engine, model);
    await first.started;
    await running.turn.followUp!("later one");
    running.controller.abort();
    // After the interrupt the turn takes nothing more.
    await running.turn.followUp!("too late");
    await running.turn.steer!("too late");
    first.release();
    await running.turn.done;
    await sleep(100);

    expect(faux.state.callCount).toBe(1);
    expect(delivered(running.events)).toEqual([]);
    expect(queues(running.events).at(-1)).toEqual({ steering: [], followUp: [] });
  }, 20000);

  test("a follow-up sent before the model is asked and then interrupted never runs", async () => {
    const first = gated("first answer");
    const second = recording("never asked");
    const { engine, faux, model } = await setup([first.step, second.step]);

    const running = begin(engine, model);
    await running.turn.followUp!("too early");
    running.turn.interrupt();
    first.release();
    await running.turn.done;
    await sleep(100);

    expect(delivered(running.events)).toEqual([]);
    expect(second.contexts).toEqual([]);
    expect(faux.state.callCount).toBeLessThanOrEqual(1);
  }, 20000);

  // B2: pi's session shutdown can take seconds after the answer; a text accepted then would be shown as pending and never sent.
  test("once pi has settled, the host is told the turn takes no more input, and steers and follow-ups are refused", async () => {
    const first = recording("first answer");
    const second = recording("never asked");
    const { engine, faux, model } = await setup([first.step, second.step]);

    const running = begin(engine, model);
    await running.turn.done;
    await sleep(50);

    expect(running.events.filter((e) => e.type === "input-closed")).toHaveLength(1);
    await expect(running.turn.steer!("too late")).rejects.toBeInstanceOf(TurnClosedError);
    await expect(running.turn.followUp!("too late")).rejects.toBeInstanceOf(TurnClosedError);
    await sleep(50);
    expect(faux.state.callCount).toBe(1);
    expect(second.contexts).toEqual([]);
    expect(delivered(running.events)).toEqual([]);
  }, 20000);

  test("input closes before the answer is final, so no steer is taken between the last reply and the end", async () => {
    const first = recording("first answer");
    const { engine, model } = await setup([first.step]);

    const running = begin(engine, model);
    await running.turn.done;

    const closedAt = running.events.findIndex((e) => e.type === "input-closed");
    const finalReplyAt = running.events.findLastIndex((e) => e.type === "reply");
    expect(closedAt).toBeGreaterThanOrEqual(0);
    expect(closedAt).toBeLessThan(finalReplyAt);
  }, 20000);

  test("a follow-up still unsent when pi goes idle is sent as the next prompt, not lost", async () => {
    const first = gated("first answer");
    const second = recording("second answer");
    const { engine, model } = await setup([first.step, second.step]);

    const running = begin(engine, model);
    await first.started;
    await running.turn.followUp!("after the answer");
    first.release();
    await running.turn.done;

    expect(second.contexts[0]).toEqual(["hello", "after the answer"]);
    expect(delivered(running.events)).toEqual([{ kind: "followUp", text: "after the answer" }]);
  }, 20000);
});
