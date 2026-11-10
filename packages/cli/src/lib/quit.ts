import { constants } from "node:os";

/**
 * Quitting marcsh (Ctrl+C, `/exit`, SIGINT/SIGTERM/SIGHUP) must not leave work behind. A pi turn runs in this process and
 * starts its bash commands in their own process groups, so exiting without aborting the turn leaves a turn with no UI (its
 * asks can never be answered) and, once the process is gone, commands running as orphans. Every chat registers its running
 * turn here; quitting aborts them all, waits (bounded) for their cleanup, then exits.
 */

/** A running turn as quit sees it: `stop` aborts it; `done` settles when it has finished cleaning up. */
export type QuitTurn = { stop: () => void; done: Promise<unknown> };

export type QuitRenderer = { destroy: () => void };

export type QuitEnv = {
  exit: (code: number) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** The longest quit waits for the running turns in total (pi's own shutdown is bounded to 3 s). */
  graceMs: number;
};

export function createQuit(env: QuitEnv) {
  const turns = new Set<QuitTurn>();
  let quitting = false;
  let exited = false;
  // `reset` starts a new generation: a quit still waiting from before it must never exit the process.
  let generation = 0;

  const finish = (code: number, startedIn = generation) => {
    if (exited || startedIn !== generation) return;
    exited = true;
    env.exit(code);
  };

  const stop = (turn: QuitTurn) => {
    try {
      turn.stop();
    } catch {}
  };

  /** Returns the function that unregisters the turn (call it when the turn has ended). */
  function registerTurn(turn: QuitTurn): () => void {
    // A turn that starts while quitting is already stopped; nothing waits for it.
    if (quitting) {
      stop(turn);
      return () => {};
    }
    turns.add(turn);
    return () => void turns.delete(turn);
  }

  /** Exit code 0 for a user quit; 128 + the signal number for a signal. A second call while waiting exits immediately. */
  function quitApp(renderer: QuitRenderer, code = 0): Promise<void> {
    if (quitting) {
      finish(code);
      return Promise.resolve();
    }
    quitting = true;
    const startedIn = generation;

    const running = [...turns];
    for (const turn of running) stop(turn);
    try {
      renderer.destroy();
    } catch {}

    if (running.length === 0) {
      finish(code);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = env.setTimeout(() => {
        finish(code, startedIn);
        resolve();
      }, env.graceMs);
      void Promise.allSettled(running.map((turn) => turn.done)).then(() => {
        env.clearTimeout(timer);
        finish(code, startedIn);
        resolve();
      });
    });
  }

  /** Test seam: forget a finished quit. */
  function reset() {
    turns.clear();
    quitting = false;
    exited = false;
    generation++;
  }

  return { registerTurn, quitApp, reset };
}

const QUIT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

type SignalSource = { on: (signal: string, handler: () => void) => unknown; off: (signal: string, handler: () => void) => unknown };

/**
 * Runs the quit path on SIGINT, SIGTERM and SIGHUP (a closed terminal). The exit code is the shell convention for a process
 * ended by a signal: 128 + the signal number (130, 143, 129). Returns the function that removes the handlers.
 */
export function installQuitSignals(
  renderer: QuitRenderer,
  source: SignalSource = process,
  quit: Pick<ReturnType<typeof createQuit>, "quitApp"> = app,
): () => void {
  const handlers = QUIT_SIGNALS.map((signal) => {
    const handler = () => void quit.quitApp(renderer, 128 + constants.signals[signal]);
    source.on(signal, handler);
    return [signal, handler] as const;
  });
  return () => handlers.forEach(([signal, handler]) => source.off(signal, handler));
}

/** The app's quit: tests of screens replace `exit` here so the runner is not killed. */
export const quitEnv: QuitEnv = {
  exit: (code) => process.exit(code),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  graceMs: 5000,
};

const app = createQuit(quitEnv);

export const registerTurn = app.registerTurn;
export const quitApp = app.quitApp;
export const resetQuit = app.reset;
