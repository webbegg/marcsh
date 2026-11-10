import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createQuit, installQuitSignals, type QuitEnv } from "./quit";

// Timers are fake: the test fires the bound by hand, so nothing waits and nothing real is killed.
function setup() {
  const exits: number[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const env: QuitEnv = {
    exit: (code) => void exits.push(code),
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    graceMs: 5000,
  };
  const quit = createQuit(env);
  const fireTimers = () => timers.filter((t) => !t.cleared).forEach((t) => t.fn());
  return { quit, exits, timers, fireTimers };
}

function fakeTurn() {
  let finish!: () => void;
  const turn = {
    stopped: 0,
    done: new Promise<void>((resolve) => (finish = resolve)),
    stop() {
      turn.stopped++;
    },
    finish: () => finish(),
  };
  return turn;
}

function fakeRenderer(log: string[] = []) {
  return { destroyed: 0, destroy() { this.destroyed++; log.push("destroy"); } };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("quitApp (S20)", () => {
  test("with no running turn it destroys the renderer and exits at once with 0", async () => {
    const { quit, exits, timers } = setup();
    const renderer = fakeRenderer();
    await quit.quitApp(renderer);
    expect(renderer.destroyed).toBe(1);
    expect(exits).toEqual([0]);
    expect(timers).toEqual([]);
  });

  test("it aborts every running turn, destroys the renderer, and exits only after all of them settle", async () => {
    const { quit, exits } = setup();
    const a = fakeTurn();
    const b = fakeTurn();
    quit.registerTurn(a);
    quit.registerTurn(b);
    const renderer = fakeRenderer();

    const quitting = quit.quitApp(renderer);
    expect([a.stopped, b.stopped, renderer.destroyed]).toEqual([1, 1, 1]);
    await tick();
    expect(exits).toEqual([]);

    a.finish();
    await tick();
    expect(exits).toEqual([]);
    b.finish();
    await quitting;
    expect(exits).toEqual([0]);
  });

  test("the turns are stopped before the renderer is destroyed", async () => {
    const { quit } = setup();
    const log: string[] = [];
    const turn = fakeTurn();
    turn.stop = () => void log.push("stop");
    quit.registerTurn(turn);
    void quit.quitApp(fakeRenderer(log));
    expect(log).toEqual(["stop", "destroy"]);
  });

  test("a turn that never settles holds the exit only for the bound", async () => {
    const { quit, exits, timers, fireTimers } = setup();
    quit.registerTurn(fakeTurn());
    const quitting = quit.quitApp(fakeRenderer());
    expect(timers.map((t) => t.ms)).toEqual([5000]);
    await tick();
    expect(exits).toEqual([]);
    fireTimers();
    await quitting;
    expect(exits).toEqual([0]);
  });

  test("a turn that settles in time cancels the bound; exit is called once", async () => {
    const { quit, exits, timers, fireTimers } = setup();
    const turn = fakeTurn();
    quit.registerTurn(turn);
    const quitting = quit.quitApp(fakeRenderer());
    turn.finish();
    await quitting;
    expect(timers[0]!.cleared).toBe(true);
    fireTimers();
    expect(exits).toEqual([0]);
  });

  test("a turn whose done rejects still lets quit finish", async () => {
    const { quit, exits } = setup();
    const turn = fakeTurn();
    const rejecting = { stop: () => {}, done: Promise.reject(new Error("boom")) };
    quit.registerTurn(rejecting);
    quit.registerTurn(turn);
    const quitting = quit.quitApp(fakeRenderer());
    turn.finish();
    await quitting;
    expect(exits).toEqual([0]);
  });

  test("a turn that throws while stopping does not stop the others or the exit", async () => {
    const { quit, exits } = setup();
    const bad = fakeTurn();
    bad.stop = () => {
      throw new Error("stop failed");
    };
    const good = fakeTurn();
    quit.registerTurn(bad);
    quit.registerTurn(good);
    const quitting = quit.quitApp({ destroy: () => { throw new Error("destroy failed"); } });
    expect(good.stopped).toBe(1);
    bad.finish();
    good.finish();
    await quitting;
    expect(exits).toEqual([0]);
  });

  test("a second quit while waiting exits at once, and exit is called once", async () => {
    const { quit, exits, fireTimers } = setup();
    const turn = fakeTurn();
    quit.registerTurn(turn);
    const renderer = fakeRenderer();
    void quit.quitApp(renderer);
    expect(exits).toEqual([]);

    await quit.quitApp(renderer);
    expect(exits).toEqual([0]);
    expect(turn.stopped).toBe(1);
    expect(renderer.destroyed).toBe(1);

    turn.finish();
    await tick();
    fireTimers();
    expect(exits).toEqual([0]);
  });

  test("a turn that finished before the quit is not waited for", async () => {
    const { quit, exits } = setup();
    const turn = fakeTurn();
    const unregister = quit.registerTurn(turn);
    unregister();
    await quit.quitApp(fakeRenderer());
    expect(turn.stopped).toBe(0);
    expect(exits).toEqual([0]);
  });

  test("a turn registered after the quit started is stopped at once", async () => {
    const { quit } = setup();
    const first = fakeTurn();
    quit.registerTurn(first);
    void quit.quitApp(fakeRenderer());
    const late = fakeTurn();
    quit.registerTurn(late);
    expect(late.stopped).toBe(1);
  });

  test("a quit still waiting when the state is reset never exits afterwards", async () => {
    const { quit, exits, fireTimers } = setup();
    const turn = fakeTurn();
    quit.registerTurn(turn);
    void quit.quitApp(fakeRenderer());
    quit.reset();
    turn.finish();
    await tick();
    fireTimers();
    expect(exits).toEqual([]);
  });

  test("the exit code is the one given", async () => {
    const { quit, exits } = setup();
    await quit.quitApp(fakeRenderer(), 143);
    expect(exits).toEqual([143]);
  });
});

describe("installQuitSignals (S20)", () => {
  test("SIGINT, SIGTERM and SIGHUP run the quit path with 128 + the signal number", async () => {
    for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
      const { quit, exits } = setup();
      const turn = fakeTurn();
      quit.registerTurn(turn);
      const proc = new EventEmitter();
      const renderer = fakeRenderer();
      installQuitSignals(renderer, proc, quit);

      proc.emit(signal);
      expect(turn.stopped).toBe(1);
      expect(renderer.destroyed).toBe(1);
      turn.finish();
      await tick();
      expect(exits).toEqual([code]);
    }
  });

  test("a second signal while waiting exits at once", async () => {
    const { quit, exits } = setup();
    quit.registerTurn(fakeTurn());
    const proc = new EventEmitter();
    installQuitSignals(fakeRenderer(), proc, quit);
    proc.emit("SIGTERM");
    expect(exits).toEqual([]);
    proc.emit("SIGTERM");
    expect(exits).toEqual([143]);
  });

  test("the returned function removes the handlers", () => {
    const { quit } = setup();
    const proc = new EventEmitter();
    const remove = installQuitSignals(fakeRenderer(), proc, quit);
    expect(["SIGINT", "SIGTERM", "SIGHUP"].map((s) => proc.listenerCount(s))).toEqual([1, 1, 1]);
    remove();
    expect(["SIGINT", "SIGTERM", "SIGHUP"].map((s) => proc.listenerCount(s))).toEqual([0, 0, 0]);
  });
});
