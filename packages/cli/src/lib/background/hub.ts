import type { TurnHost } from "../engine/types";
import { registerTurn as registerQuitTurn, type QuitTurn } from "../quit";

/**
 * Where the background work of one session (terminals, subagents) hands its results to the model, each exactly once. A session
 * screen owns one hub for a pi session (headless `marcsh run` never has one) and disposes it when the session is left. The
 * delivery idea follows davi7's `result-delivery.ts` (MIT).
 *
 * - `finish(result)`: an item is done. Its result is announced unless a tool collected it first; results finishing within
 *   `debounceMs` of each other go out as one batch.
 * - `consume(ids)`: a tool (`bg_status`, `task_wait`...) reported these items' results to the model itself. Returns the ids this
 *   call was first to report; the rest were announced (or are on their way) already. A consumed id is never announced or
 *   requeued after, even if it finishes later.
 * - Delivery: a batch goes to the running turn's sink (`attachTurn`, a follow-up in that turn) or else to the idle sink
 *   (`setIdleSink`, a turn of its own). A sink that cannot take it now returns false and the batch waits for `retry()`
 *   (the chat calls it when it goes idle). A sink that took a batch but could not send it gives it back with `requeue(ids)`.
 * - `subscribe(listener)`: called on every change (and on `changed()`, which managers call when their own lists change), for the UI.
 * - `host`: the session's own ask channel (approvals that come after the turn that started the work has ended), set by the chat.
 * - `registerTurn(item)`: registers a running item with quit (`lib/quit.ts`), so quitting stops it and waits for it.
 * - `onDispose(fn)`: managers register their kill-all; `dispose()` runs them all, once, and the hub takes nothing more.
 */

export type BackgroundResult = {
  id: string;
  /** What finished ("terminal", "subagent"...). */
  kind: string;
  title: string;
  /** The one line the transcript shows. Default: `[background] <title> finished`. */
  notice?: string;
  /** What the model is told. */
  text: string;
};

/** Results delivered together: one notice line and one text block per result. */
export type BackgroundBatch = { ids: string[]; notice: string; text: string };

/** Takes a batch (true) or cannot take it now (false). */
export type BackgroundSink = (batch: BackgroundBatch) => boolean;

/** What background work may ask the user once no turn of its own is running. */
export type BackgroundHost = Pick<TurnHost, "askPermission" | "notify">;

export type BackgroundHubOptions = {
  /** How long a finished result waits for others to go with it. Default: 100 ms. */
  debounceMs?: number;
  /** Quit's registry (tests inject their own). Default: the app's. */
  registerTurn?: (turn: QuitTurn) => () => void;
};

export type BackgroundHub = {
  finish(result: BackgroundResult): void;
  consume(ids: readonly string[]): string[];
  /** The results waiting to be delivered, oldest first. */
  pending(): BackgroundResult[];
  attachTurn(sink: BackgroundSink): () => void;
  setIdleSink(sink: BackgroundSink | undefined): void;
  retry(): void;
  requeue(ids: readonly string[]): void;
  subscribe(listener: () => void): () => void;
  changed(): void;
  host: BackgroundHost | undefined;
  registerTurn(turn: QuitTurn): () => void;
  onDispose(disposer: () => unknown): () => void;
  dispose(): Promise<void>;
  readonly disposed: boolean;
};

/** The user message the transcript keeps for a batch: the notice lines, a blank line, then what the model got. */
export const backgroundMessageText = (batch: Pick<BackgroundBatch, "notice" | "text">) => `${batch.notice}\n\n${batch.text}`;

/** The notice lines of a `backgroundMessageText`, which is all the transcript shows of it. */
export function noticeOf(text: string): string {
  const end = text.indexOf("\n\n");
  return end === -1 ? text : text.slice(0, end);
}

const noticeFor = (result: BackgroundResult) => result.notice ?? `[background] ${result.title} finished`;

// pending: waiting for a sink; sent: a sink took it (it may still give it back); done: delivered or collected by a tool.
type Entry = { result: BackgroundResult; state: "pending" | "sent" };

export function createBackgroundHub({ debounceMs = 100, registerTurn = registerQuitTurn }: BackgroundHubOptions = {}): BackgroundHub {
  const entries = new Map<string, Entry>();
  const done = new Set<string>();
  const listeners = new Set<() => void>();
  const disposers = new Set<() => unknown>();
  let turnSink: BackgroundSink | undefined;
  let idleSink: BackgroundSink | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const changed = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {}
    }
  };

  const schedule = (ms: number) => {
    if (disposed || timer) return;
    timer = setTimeout(flush, ms);
  };

  function flush() {
    timer = undefined;
    if (disposed) return;
    const waiting = [...entries.values()].filter((entry) => entry.state === "pending");
    if (waiting.length === 0) return;
    const batch: BackgroundBatch = {
      ids: waiting.map((entry) => entry.result.id),
      notice: waiting.map((entry) => noticeFor(entry.result)).join("\n"),
      text: waiting.map((entry) => entry.result.text).join("\n\n"),
    };
    for (const sink of [turnSink, idleSink]) {
      if (!sink || !sink(batch)) continue;
      for (const entry of waiting) entry.state = "sent";
      changed();
      return;
    }
  }

  const hub: BackgroundHub = {
    finish(result) {
      if (disposed || done.has(result.id) || entries.get(result.id)?.state === "sent") return;
      entries.set(result.id, { result, state: "pending" });
      changed();
      schedule(debounceMs);
    },
    consume(ids) {
      const taken: string[] = [];
      let change = false;
      for (const id of ids) {
        if (done.has(id)) continue;
        // A result a sink took is on its way; the tool has reported it now, so a sink that gives it back does not bring it back.
        if (entries.get(id)?.state !== "sent") taken.push(id);
        change ||= entries.delete(id);
        done.add(id);
      }
      if (change || taken.length > 0) changed();
      return taken;
    },
    pending: () => [...entries.values()].filter((entry) => entry.state === "pending").map((entry) => entry.result),
    attachTurn(sink) {
      turnSink = sink;
      if (hub.pending().length > 0) schedule(debounceMs);
      return () => {
        if (turnSink === sink) turnSink = undefined;
      };
    },
    setIdleSink(sink) {
      idleSink = sink;
    },
    retry: () => schedule(0),
    requeue(ids) {
      let back = false;
      for (const id of ids) {
        const entry = entries.get(id);
        if (entry?.state !== "sent") continue;
        entry.state = "pending";
        back = true;
      }
      if (back) changed();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    changed,
    host: undefined,
    registerTurn: (turn) => registerTurn(turn),
    onDispose(disposer) {
      disposers.add(disposer);
      return () => void disposers.delete(disposer);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      turnSink = undefined;
      idleSink = undefined;
      hub.host = undefined;
      const running = [...disposers];
      disposers.clear();
      await Promise.allSettled(running.map(async (disposer) => disposer()));
      listeners.clear();
    },
    get disposed() {
      return disposed;
    },
  };
  return hub;
}
