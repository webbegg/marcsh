import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";

const { testRender } = await import("@opentui/react/test-utils");
const { useChat } = await import("./use-chat");
const { getStorage } = await import("../lib/storage");
import type { ChatMessage } from "../lib/chat-types";
import { TurnClosedError, type Engine, type EngineEvent, type EngineTurn, type NoticeLevel, type TurnHost, type TurnRequest } from "../lib/engine/types";

let latest: ReturnType<typeof useChat>;
let screen: Awaited<ReturnType<typeof testRender>> | null = null;
let notices: Array<{ message: string; level: NoticeLevel }> = [];
const settle = (ms = 20) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

type Script = {
  host: TurnHost;
  steered: string[];
  followedUp: string[];
  interrupted: number;
  emit: (event: EngineEvent) => void;
  finish: () => void;
  failSteer?: string | Error;
};

// A pi-like engine: its turn runs until the test finishes it, takes steer/followUp, and reports what the test makes it emit.
function steerableEngine(withSteer = true) {
  const scripts: Script[] = [];
  const engine: Engine = {
    id: "fake",
    startTurn(_request: TurnRequest, host: TurnHost): EngineTurn {
      const ended = Promise.withResolvers<void>();
      const script: Script = {
        host,
        steered: [],
        followedUp: [],
        interrupted: 0,
        emit: (event) => {
          act(() => host.emit(event));
        },
        finish: () => ended.resolve(),
      };
      scripts.push(script);
      const turn: EngineTurn = {
        done: ended.promise,
        interrupt() {
          script.interrupted++;
          ended.resolve();
        },
      };
      if (withSteer) {
        turn.steer = async (text) => {
          if (script.failSteer) throw typeof script.failSteer === "string" ? new Error(script.failSteer) : script.failSteer;
          script.steered.push(text);
        };
        turn.followUp = async (text) => {
          script.followedUp.push(text);
        };
      }
      return turn;
    },
    warmUpCommands: async () => {},
  };
  return { engine, scripts };
}

function Probe({ engine, id }: { engine: Engine; id: string }) {
  latest = useChat(getStorage().getSession(id)!, engine, { notify: (message, level) => notices.push({ message, level }) });
  return <text>probe</text>;
}

async function open(engine: Engine) {
  notices = [];
  const id = getStorage().createSession({ title: "t", cwd: "/tmp/x" }).id;
  screen = await testRender(<Probe engine={engine} id={id} />, { width: 40, height: 5 });
  await settle();
  return id;
}

function start(text = "hi") {
  const done = latest.submit({ userText: text, mode: "BUILD", model: "opus" });
  return done;
}

const say = (text: string) => (reply: ChatMessage): ChatMessage => ({ ...reply, parts: [...reply.parts, { type: "text", text }] });
const shape = (messages: ChatMessage[]) =>
  messages.map((m) => ({
    role: m.role,
    text: m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join(""),
    steered: m.metadata?.steered === true,
  }));

afterEach(() => {
  screen?.renderer.destroy();
  screen = null;
});

describe("typing during a turn (S4)", () => {
  test("an engine with steer lets the input stay on; one without keeps today's behavior", async () => {
    const withSteer = steerableEngine(true);
    await open(withSteer.engine);
    expect(latest.canSteer).toBe(false);
    const running = start();
    await settle();
    expect(latest.canSteer).toBe(true);
    withSteer.scripts[0]!.finish();
    await running;
    await settle();
    expect(latest.canSteer).toBe(false);

    screen!.renderer.destroy();
    const without = steerableEngine(false);
    await open(without.engine);
    const other = start();
    await settle();
    expect(latest.status).not.toBe("ready");
    expect(latest.canSteer).toBe(false);
    // Nothing to forward to: typing is dropped, not queued behind the engine's back.
    latest.steer("ignored");
    latest.followUp("ignored");
    await settle();
    expect(without.scripts[0]!.steered).toEqual([]);
    without.scripts[0]!.finish();
    await other;
  });

  test("a steer goes to the running turn, and its delivery splits the transcript there", async () => {
    const { engine, scripts } = steerableEngine();
    const id = await open(engine);
    const running = start("go");
    await settle();
    const turn = scripts[0]!;

    turn.emit({ type: "reply", update: say("before ") });
    latest.steer("change course");
    await settle();
    expect(turn.steered).toEqual(["change course"]);

    turn.emit({ type: "queue", steering: ["change course"], followUp: [] });
    await settle();
    expect(latest.queued).toEqual({ steering: ["change course"], followUp: [] });

    turn.emit({ type: "queue", steering: [], followUp: [] });
    turn.emit({ type: "delivered", text: "change course", kind: "steer" });
    turn.emit({ type: "reply", update: say("after") });
    await settle();
    turn.finish();
    await running;
    await settle();

    expect(latest.queued).toEqual({ steering: [], followUp: [] });
    expect(shape(latest.messages)).toEqual([
      { role: "user", text: "go", steered: false },
      { role: "assistant", text: "before ", steered: false },
      { role: "user", text: "change course", steered: true },
      { role: "assistant", text: "after", steered: false },
    ]);
    // Saved with the session, marker included.
    expect(shape(getStorage().getSession(id)!.messages)).toEqual(shape(latest.messages));
    expect(latest.status).toBe("ready");
  });

  test("a follow-up waits as pending, then becomes a normal user message", async () => {
    const { engine, scripts } = steerableEngine();
    const id = await open(engine);
    const running = start("go");
    await settle();
    const turn = scripts[0]!;

    turn.emit({ type: "reply", update: say("working") });
    latest.followUp("then this");
    await settle();
    expect(turn.followedUp).toEqual(["then this"]);
    turn.emit({ type: "queue", steering: [], followUp: ["then this"] });
    await settle();
    expect(latest.queued.followUp).toEqual(["then this"]);
    // Pending text is not in the transcript yet, so it is not saved as a message either.
    expect(shape(latest.messages).map((m) => m.text)).toEqual(["go", "working"]);

    turn.emit({ type: "queue", steering: [], followUp: [] });
    turn.emit({ type: "delivered", text: "then this", kind: "followUp" });
    turn.emit({ type: "reply", update: say("done too") });
    await settle();
    turn.finish();
    await running;
    await settle();

    expect(shape(getStorage().getSession(id)!.messages)).toEqual([
      { role: "user", text: "go", steered: false },
      { role: "assistant", text: "working", steered: false },
      { role: "user", text: "then this", steered: false },
      { role: "assistant", text: "done too", steered: false },
    ]);
  });

  test("a steer delivered before any output leaves no empty reply behind", async () => {
    const { engine, scripts } = steerableEngine();
    await open(engine);
    const running = start("go");
    await settle();
    const turn = scripts[0]!;

    turn.emit({ type: "delivered", text: "quick", kind: "steer" });
    turn.emit({ type: "reply", update: say("answer") });
    await settle();
    turn.finish();
    await running;
    await settle();

    expect(shape(latest.messages)).toEqual([
      { role: "user", text: "go", steered: false },
      { role: "user", text: "quick", steered: true },
      { role: "assistant", text: "answer", steered: false },
    ]);
  });

  test("tools still running in the reply before a steer are not left running when the turn ends", async () => {
    const { engine, scripts } = steerableEngine();
    await open(engine);
    const running = start("go");
    await settle();
    const turn = scripts[0]!;

    turn.emit({
      type: "reply",
      update: (reply) => ({ ...reply, parts: [{ type: "tool", toolCallId: "t1", toolName: "bash", input: {}, state: "running" }] }),
    });
    turn.emit({ type: "delivered", text: "stop that", kind: "steer" });
    await settle();
    turn.finish();
    await running;
    await settle();

    const tools = latest.messages.flatMap((m) => m.parts.filter((p) => p.type === "tool"));
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ state: "error" });
  });

  test("interrupting discards what was queued and stops taking input", async () => {
    const { engine, scripts } = steerableEngine();
    await open(engine);
    const running = start("go");
    await settle();
    const turn = scripts[0]!;

    turn.emit({ type: "queue", steering: [], followUp: ["later"] });
    await settle();
    expect(latest.queued.followUp).toEqual(["later"]);

    act(() => latest.interrupt());
    await settle();
    expect(turn.interrupted).toBe(1);
    expect(latest.queued).toEqual({ steering: [], followUp: [] });
    expect(latest.canSteer).toBe(false);
    latest.steer("too late");
    latest.followUp("too late");
    await settle();
    expect(turn.steered).toEqual([]);
    expect(turn.followedUp).toEqual([]);

    await running;
    await settle();
    expect(latest.status).toBe("ready");
  });

  test("a turn that ends clears the queue shown", async () => {
    const { engine, scripts } = steerableEngine();
    await open(engine);
    const running = start("go");
    await settle();
    scripts[0]!.emit({ type: "queue", steering: ["x"], followUp: ["y"] });
    await settle();
    expect(latest.queued).toEqual({ steering: ["x"], followUp: ["y"] });

    scripts[0]!.finish();
    await running;
    await settle();
    expect(latest.queued).toEqual({ steering: [], followUp: [] });
  });

  test("a text the engine cannot take is reported as a warning, not as a chat error", async () => {
    const { engine, scripts } = steerableEngine();
    await open(engine);
    const running = start("go");
    await settle();
    scripts[0]!.failSteer = 'Extension command "/x" cannot be queued.';

    latest.steer("/x");
    await settle();

    expect(notices).toEqual([{ message: 'Extension command "/x" cannot be queued.', level: "warning" }]);
    expect(latest.error).toBeNull();
    scripts[0]!.finish();
    await running;
  });
});

// B2: once the engine has settled the turn takes no more text; a refused text stays with the user (the caller keeps it in the input).
describe("a turn that has settled takes no more input (S4)", () => {
  test("steer and followUp say whether the turn took the text", async () => {
    const { engine, scripts } = steerableEngine();
    await open(engine);
    expect(latest.steer("nobody listens")).toBe(false);

    const running = start("go");
    await settle();
    expect(latest.steer("now")).toBe(true);
    expect(latest.followUp("later")).toBe(true);
    await settle();
    expect(scripts[0]!.steered).toEqual(["now"]);
    expect(scripts[0]!.followedUp).toEqual(["later"]);

    act(() => latest.interrupt());
    expect(latest.steer("too late")).toBe(false);
    expect(latest.followUp("too late")).toBe(false);
    await running;
  });

  test("after input-closed the chat stops advertising input and refuses text without forwarding it", async () => {
    const { engine, scripts } = steerableEngine();
    await open(engine);
    const running = start("go");
    await settle();
    const turn = scripts[0]!;
    turn.emit({ type: "queue", steering: [], followUp: ["queued"] });
    await settle();
    expect(latest.canSteer).toBe(true);
    expect(latest.inputClosed).toBe(false);

    turn.emit({ type: "input-closed" });
    await settle();
    expect(latest.canSteer).toBe(false);
    expect(latest.inputClosed).toBe(true);
    expect(latest.queued).toEqual({ steering: [], followUp: [] });
    expect(latest.status).not.toBe("ready");

    expect(latest.steer("too late")).toBe(false);
    expect(latest.followUp("too late")).toBe(false);
    await settle();
    expect(turn.steered).toEqual([]);
    expect(turn.followedUp).toEqual([]);
    expect(notices).toEqual([]);

    turn.finish();
    await running;
    await settle();
    expect(latest.status).toBe("ready");
    expect(latest.inputClosed).toBe(false);
    // The next turn takes input again.
    const next = start("again");
    await settle();
    expect(latest.canSteer).toBe(true);
    expect(latest.steer("works")).toBe(true);
    scripts[1]!.finish();
    await next;
  });

  test("an engine that refuses after taking the call is reported with the text, not silently", async () => {
    const { engine, scripts } = steerableEngine();
    await open(engine);
    const running = start("go");
    await settle();
    const turn = scripts[0]!;
    turn.failSteer = new TurnClosedError();

    latest.steer("just too late");
    await settle();

    expect(notices).toHaveLength(1);
    expect(notices[0]!.level).toBe("warning");
    expect(notices[0]!.message).toContain("just too late");
    turn.finish();
    await running;
  });
});
