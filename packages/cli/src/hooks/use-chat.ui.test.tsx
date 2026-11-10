import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";

const { testRender } = await import("@opentui/react/test-utils");
const { useChat } = await import("./use-chat");
const { getStorage } = await import("../lib/storage");
import type { Engine, NoticeLevel, TurnHost, TurnRequest } from "../lib/engine/types";

type Chat = ReturnType<typeof useChat>;
let latest: Chat;
let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const notices: { message: string; level: NoticeLevel }[] = [];
const settle = (ms = 20) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

function scriptedEngine(run: (request: TurnRequest, host: TurnHost) => Promise<void>) {
  const engine: Engine = {
    id: "fake",
    startTurn: (request, host) => ({ done: run(request, host), interrupt() {} }),
    warmUpCommands: async () => {},
  };
  return engine;
}

function Probe({ engine, id }: { engine: Engine; id: string }) {
  latest = useChat(getStorage().getSession(id)!, engine, { notify: (message, level) => notices.push({ message, level }) });
  return <text>probe</text>;
}

async function open(engine: Engine, sessionEngine = "claude") {
  const id = getStorage().createSession({ title: "t", cwd: "/tmp/x", engine: sessionEngine }).id;
  screen = await testRender(<Probe engine={engine} id={id} />, { width: 40, height: 5 });
  await settle();
  return id;
}

function start() {
  return latest.submit({ userText: "hi", mode: "BUILD", model: "opus" });
}

// The request on top of the queue, narrowed by kind.
function top<K extends NonNullable<Chat["pendingRequest"]>["kind"]>(kind: K) {
  const request = latest.pendingRequest;
  expect(request?.kind).toBe(kind);
  return request as Extract<NonNullable<Chat["pendingRequest"]>, { kind: K }>;
}

afterEach(() => {
  screen?.renderer.destroy();
  screen = null;
  notices.length = 0;
});

describe("useChat generic asks from an engine (S7)", () => {
  test("select, confirm, input and editor are queued one at a time, each shown with its text", async () => {
    const answers: unknown[] = [];
    const engine = scriptedEngine(async (_request, host) => {
      const signal = new AbortController().signal;
      await Promise.all([
        host.select!("Pick", ["a", "b"], signal).then((v) => answers.push(["select", v])),
        host.confirm!("Sure?", "Really", signal).then((v) => answers.push(["confirm", v])),
        host.input!("Name", "hint", signal).then((v) => answers.push(["input", v])),
        host.editor!("Edit", "pre", signal).then((v) => answers.push(["editor", v])),
      ]);
    });
    await open(engine);
    const running = start();
    await settle();

    const select = top("select");
    expect(select).toMatchObject({ title: "Pick", options: ["a", "b"] });
    select.respond("b");
    await settle();

    const confirm = top("confirm");
    expect(confirm).toMatchObject({ title: "Sure?", message: "Really" });
    confirm.respond(true);
    await settle();

    const input = top("input");
    expect(input).toMatchObject({ title: "Name", placeholder: "hint" });
    input.respond("typed");
    await settle();

    const editor = top("editor");
    expect(editor).toMatchObject({ title: "Edit", prefill: "pre" });
    editor.respond("edited");
    await running;
    await settle();

    expect(answers).toEqual([["select", "b"], ["confirm", true], ["input", "typed"], ["editor", "edited"]]);
    expect(latest.pendingRequest).toBeNull();
  });

  test("they share the queue with approvals and questions, in arrival order", async () => {
    const engine = scriptedEngine(async (_request, host) => {
      const signal = new AbortController().signal;
      void host.askPermission({ toolName: "Bash", input: {} }, signal);
      void host.select!("Pick", ["a"], signal);
      void host.askQuestions([], signal);
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    await open(engine);
    const running = start();
    await settle();

    expect(top("permission")).toBeDefined();
    top("permission").respond("deny");
    await settle();
    expect(top("select")).toBeDefined();
    top("select").respond(undefined);
    await settle();
    expect(top("question")).toBeDefined();
    await running;
  });

  test("an ask resolves once, with the first answer", async () => {
    const answers: unknown[] = [];
    const engine = scriptedEngine(async (_request, host) => {
      answers.push(await host.confirm!("Sure?", "m", new AbortController().signal));
    });
    await open(engine);
    const running = start();
    await settle();

    const confirm = top("confirm");
    confirm.respond(true);
    confirm.respond(false);
    await running;

    expect(answers).toEqual([true]);
  });

  test("aborting the turn cancels every open ask: select, input, editor give undefined and confirm gives false", async () => {
    const answers: unknown[] = [];
    const engine = scriptedEngine(async (request, host) => {
      await Promise.all([
        host.select!("Pick", ["a"], request.signal).then((v) => answers.push(["select", v])),
        host.confirm!("Sure?", "m", request.signal).then((v) => answers.push(["confirm", v])),
        host.input!("Name", undefined, request.signal).then((v) => answers.push(["input", v])),
        host.editor!("Edit", undefined, request.signal).then((v) => answers.push(["editor", v])),
      ]);
    });
    await open(engine);
    const running = start();
    await settle();
    expect(latest.pendingRequest?.kind).toBe("select");

    latest.abort();
    await running;
    await settle();

    expect(answers).toEqual([["select", undefined], ["confirm", false], ["input", undefined], ["editor", undefined]]);
    expect(latest.pendingRequest).toBeNull();
  });

  test("an ask still open when the engine ends the turn without aborting is cancelled, not dropped", async () => {
    const answers: unknown[] = [];
    const pending: Promise<unknown>[] = [];
    const engine = scriptedEngine(async (_request, host) => {
      const signal = new AbortController().signal;
      pending.push(
        host.select!("Pick", ["a"], signal).then((v) => answers.push(["select", v])),
        host.confirm!("Sure?", "m", signal).then((v) => answers.push(["confirm", v])),
        host.input!("Name", undefined, signal).then((v) => answers.push(["input", v])),
        host.editor!("Edit", undefined, signal).then((v) => answers.push(["editor", v])),
      );
    });
    await open(engine);

    await start();
    await Promise.all(pending);

    expect(answers).toEqual([["select", undefined], ["confirm", false], ["input", undefined], ["editor", undefined]]);
    expect(latest.pendingRequest).toBeNull();
  });

  test("an ask whose signal is already aborted is cancelled at once and never shown", async () => {
    const answers: unknown[] = [];
    const engine = scriptedEngine(async (_request, host) => {
      const cancelled = AbortSignal.abort();
      answers.push(await host.select!("Pick", ["a"], cancelled), await host.confirm!("Sure?", "m", cancelled));
    });
    await open(engine);

    await start();

    expect(answers).toEqual([undefined, false]);
    expect(latest.pendingRequest).toBeNull();
  });

  test("notify goes to the screen's notice callback with its level", async () => {
    const engine = scriptedEngine(async (_request, host) => {
      host.notify!("Saved", "info");
      host.notify!("Careful", "warning");
    });
    await open(engine);

    await start();

    expect(notices).toEqual([
      { message: "Saved", level: "info" },
      { message: "Careful", level: "warning" },
    ]);
  });
});

describe("the command list an engine reports (S11)", () => {
  const commands = [{ name: "deploy", description: "Ship", argumentHint: "", source: "extension" }];
  const reporting = scriptedEngine(async (_request, host) => {
    host.emit({ type: "commands", commands });
  });

  test("is cached under the session's engine: pi's list does not touch Claude's", async () => {
    getStorage().saveClaudeCommands([{ name: "kept", description: "", argumentHint: "" }]);
    await open(reporting, "pi");

    await start();

    expect(getStorage().getCommands("pi")).toEqual(commands);
    expect(getStorage().getClaudeCommands().map((c) => c.name)).toEqual(["kept"]);
  });

  test("a Claude session still caches under the Claude key", async () => {
    getStorage().saveCommands("pi", []);
    await open(reporting, "claude");

    await start();

    expect(getStorage().getClaudeCommands().map((c) => c.name)).toEqual(["deploy"]);
    expect(getStorage().getCommands("pi")).toEqual([]);
  });
});
