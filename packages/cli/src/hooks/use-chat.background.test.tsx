import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";

const { testRender } = await import("@opentui/react/test-utils");
const { useChat } = await import("./use-chat");
const { getStorage } = await import("../lib/storage");
const { backgroundMessageText, createBackgroundHub } = await import("../lib/background/hub");
import type { BackgroundBatch, BackgroundHub } from "../lib/background/hub";
import type { ChatMessage } from "../lib/chat-types";
import type { Engine, EngineEvent, EngineTurn, PermissionDecision, TurnHost, TurnRequest } from "../lib/engine/types";

let latest: ReturnType<typeof useChat>;
let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = (ms = 20) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

type Script = { request: TurnRequest; host: TurnHost; emit: (event: EngineEvent) => void; finish: () => void };

// An engine whose turn runs until the test finishes it.
function scriptedEngine() {
  const scripts: Script[] = [];
  const engine: Engine = {
    id: "fake",
    startTurn(request: TurnRequest, host: TurnHost): EngineTurn {
      const ended = Promise.withResolvers<void>();
      scripts.push({ request, host, emit: (event) => act(() => host.emit(event)), finish: () => ended.resolve() });
      return { done: ended.promise, interrupt: () => ended.resolve() };
    },
    warmUpCommands: async () => {},
  };
  return { engine, scripts };
}

function Probe({ engine, id, hub }: { engine: Engine; id: string; hub?: BackgroundHub }) {
  latest = useChat(getStorage().getSession(id)!, engine, { background: hub });
  return <text>probe</text>;
}

async function open(engine: Engine, hub?: BackgroundHub) {
  const id = getStorage().createSession({ title: "t", cwd: "/tmp/x" }).id;
  screen = await testRender(<Probe engine={engine} id={id} hub={hub} />, { width: 40, height: 5 });
  await settle();
  return id;
}

const say = (text: string) => (reply: ChatMessage): ChatMessage => ({ ...reply, parts: [...reply.parts, { type: "text", text }] });
const shape = (messages: ChatMessage[]) =>
  messages.map((m) => ({ role: m.role, text: m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join(""), background: m.metadata?.background === true }));

// The screen's idle path, reduced: it takes a batch only while the chat can start a turn.
function idleSink(hub: BackgroundHub) {
  const batches: BackgroundBatch[] = [];
  hub.setIdleSink((batch) => {
    if (!latest.isIdle()) return false;
    batches.push(batch);
    return true;
  });
  return batches;
}

const result = { id: "bg-1", kind: "terminal", title: "build", text: "bg-1 exited with code 0" };

afterEach(() => {
  screen?.renderer.destroy();
  screen = null;
});

describe("background results in the chat (S2)", () => {
  test("every turn gets the hub, and a delivered background batch is a user message marked as background", async () => {
    const hub = createBackgroundHub({ debounceMs: 5 });
    const { engine, scripts } = scriptedEngine();
    const id = await open(engine, hub);
    const running = latest.submit({ userText: "go", mode: "BUILD", model: "opus" });
    await settle();
    const turn = scripts[0]!;
    expect(turn.request.background).toBe(hub);

    turn.emit({ type: "reply", update: say("working") });
    const text = backgroundMessageText({ notice: "[background] build finished", text: "bg-1 exited with code 0" });
    turn.emit({ type: "delivered", kind: "background", text });
    turn.emit({ type: "reply", update: say("it built") });
    turn.finish();
    await running;
    await settle();

    const expected: ReturnType<typeof shape> = [
      { role: "user", text: "go", background: false },
      { role: "assistant", text: "working", background: false },
      { role: "user", text, background: true },
      { role: "assistant", text: "it built", background: false },
    ];
    expect(shape(latest.messages)).toEqual(expected);
    // Saved as it is shown, so a resumed session shows the notice again.
    expect(shape(getStorage().getSession(id)!.messages)).toEqual(expected);
  });

  test("a background turn shows the notice and its result, and sends the model only the result, as it is", async () => {
    const hub = createBackgroundHub({ debounceMs: 5 });
    const { engine, scripts } = scriptedEngine();
    await open(engine, hub);
    const batch = { ids: ["bg-1"], notice: "[background] build finished", text: "bg-1 exited with code 0" };
    const running = latest.submit({ userText: backgroundMessageText(batch), mode: "BUILD", model: "opus", background: batch });
    await settle();
    expect(scripts[0]!.request.prompt).toBe("bg-1 exited with code 0");
    expect(scripts[0]!.request.promptKind).toBe("background");
    scripts[0]!.finish();
    await running;
    await settle();
    expect(shape(latest.messages)[0]).toEqual({ role: "user", text: backgroundMessageText(batch), background: true });
    expect(latest.messages[0]!.metadata?.mode).toBe("BUILD");
  });

  test("a result that finished during the turn is offered to the idle path once the turn ends, not after an interrupt", async () => {
    const hub = createBackgroundHub({ debounceMs: 5 });
    const idle = idleSink(hub);
    const { engine, scripts } = scriptedEngine();
    await open(engine, hub);
    let running = latest.submit({ userText: "go", mode: "BUILD", model: "opus" });
    await settle();
    hub.finish(result);
    await settle(30);
    // Busy: refused, still pending.
    expect(idle).toEqual([]);
    expect(hub.pending()).toHaveLength(1);
    scripts[0]!.finish();
    await running;
    await settle(30);
    expect(idle.map((batch) => batch.ids)).toEqual([["bg-1"]]);

    // After Esc the results wait: the user stopped the agent, so nothing starts it again by itself.
    running = latest.submit({ userText: "again", mode: "BUILD", model: "opus" });
    await settle();
    hub.finish({ ...result, id: "bg-2" });
    await settle(30);
    act(() => latest.interrupt());
    await running;
    await settle(30);
    expect(idle).toHaveLength(1);
    expect(hub.pending().map((r) => r.id)).toEqual(["bg-2"]);
  });

  test("the session's ask channel outlives turns: a turn ending declines only its own requests", async () => {
    const hub = createBackgroundHub({ debounceMs: 5 });
    const { engine, scripts } = scriptedEngine();
    await open(engine, hub);
    expect(hub.host).toBeDefined();

    const running = latest.submit({ userText: "go", mode: "BUILD", model: "opus" });
    await settle();
    const background = new AbortController();
    let childAnswer: PermissionDecision | undefined;
    void hub.host!.askPermission({ toolName: "bash", input: { command: "ls" } }, background.signal).then((decision) => (childAnswer = decision));
    let turnAnswer: PermissionDecision | undefined;
    void scripts[0]!.host.askPermission({ toolName: "bash", input: { command: "pwd" } }, new AbortController().signal).then((decision) => (turnAnswer = decision));
    await settle();

    scripts[0]!.finish();
    await running;
    await settle();
    expect(turnAnswer).toBe("deny");
    expect(childAnswer).toBeUndefined();
    expect(latest.pendingRequest?.kind).toBe("permission");
    expect(latest.pendingRequest?.kind === "permission" && latest.pendingRequest.input.command).toBe("ls");
    // A request still waits for the user: the chat cannot start a background turn now.
    expect(latest.isIdle()).toBe(false);

    act(() => (latest.pendingRequest as { respond: (decision: PermissionDecision) => void }).respond("allow"));
    await settle();
    expect(childAnswer).toBe("allow");
    expect(latest.pendingRequest).toBeNull();
    expect(latest.isIdle()).toBe(true);
  });

  test("answering the last request while idle retries delivery", async () => {
    const hub = createBackgroundHub({ debounceMs: 5 });
    const idle = idleSink(hub);
    const { engine } = scriptedEngine();
    await open(engine, hub);
    void hub.host!.askPermission({ toolName: "bash", input: { command: "ls" } }, new AbortController().signal);
    await settle();
    hub.finish(result);
    await settle(30);
    expect(idle).toEqual([]);
    act(() => (latest.pendingRequest as { respond: (decision: PermissionDecision) => void }).respond("deny"));
    await settle(30);
    expect(idle.map((batch) => batch.ids)).toEqual([["bg-1"]]);
  });

  test("after Esc, answering a background request does not start a turn: the results keep waiting (R3-8)", async () => {
    const hub = createBackgroundHub({ debounceMs: 5 });
    const idle = idleSink(hub);
    const { engine } = scriptedEngine();
    await open(engine, hub);
    const running = latest.submit({ userText: "go", mode: "BUILD", model: "opus" });
    await settle();
    void hub.host!.askPermission({ toolName: "bash", input: { command: "ls" } }, new AbortController().signal);
    hub.finish(result);
    await settle(30);
    act(() => latest.interrupt());
    await running;
    await settle(30);
    expect(idle).toEqual([]);

    act(() => (latest.pendingRequest as { respond: (decision: PermissionDecision) => void }).respond("allow"));
    await settle(30);
    expect(idle).toEqual([]);
    expect(hub.pending().map((r) => r.id)).toEqual(["bg-1"]);
  });

  test("the ask channel is dropped when the chat unmounts", async () => {
    const hub = createBackgroundHub({ debounceMs: 5 });
    const { engine } = scriptedEngine();
    await open(engine, hub);
    expect(hub.host).toBeDefined();
    act(() => screen!.renderer.destroy());
    screen = null;
    await settle();
    expect(hub.host).toBeUndefined();
  });
});
