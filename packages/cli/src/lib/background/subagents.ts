import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ChatMessage, MessagePart } from "../chat-types";
import type { ChildProgress, ChildRun } from "../engine/pi-subagent";
import { applyPiEvent } from "../engine/pi-events";
import type { QuitTurn } from "../quit";
import { formatElapsed } from "./terminals";

/**
 * Background subagents: child pi sessions the model starts with `Task` and `background: true`, which keep running after the
 * tool call (and the turn) returns. Each has its own abort signal; at most `MAX_RUNNING_SUBAGENTS` run at once, and a start
 * takes its slot before anything awaits. Cancelling aborts the child and marks it stopped after a grace if it has not ended by
 * then. Its events build a live transcript for `/subagents`. The shape follows `terminals.ts`; the idea is davi7's background
 * subagents (MIT license; see THIRD_PARTY_NOTICES.md).
 */

export const MAX_RUNNING_SUBAGENTS = 4;
export const MAX_TRACKED_SUBAGENTS = 32;
/** How long a cancelled child may take to end before it is marked stopped anyway. */
export const STOP_GRACE_MS = 5_000;
/** The same on quit and when the session is left: under quit's 5 s grace. */
export const QUIT_STOP_GRACE_MS = 2_000;

/** The live transcript keeps at most this many parts, the newest. */
export const MAX_TRANSCRIPT_PARTS = 200;
/** ...and about this much text (text, reasoning, tool inputs and errors), the newest. */
export const MAX_TRANSCRIPT_CHARS = 256 * 1024;
/** A tool call's input over this size has its long values cut. */
export const MAX_TOOL_INPUT_CHARS = 4 * 1024;

const NO_TEXT = "The subagent finished without returning any text.";
const ERROR_MAX = 4_096;

/** completed = the child answered; failed = it errored; stopped = cancelled, or ended by quit or leaving the session. */
export type SubagentStatus = "running" | "completed" | "failed" | "stopped";

export type SubagentSnapshot = {
  readonly id: string;
  /** The `description` the model gave (3-5 words). */
  readonly description: string;
  readonly prompt: string;
  readonly status: SubagentStatus;
  readonly createdAt: number;
  readonly settledAt?: number;
  readonly toolUses: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly lastToolName?: string;
  /** The child's latest assistant text so far; its final text once completed. */
  readonly text: string;
  readonly error?: string;
  /** What the child has done, as one assistant reply (text, reasoning, tool calls), for the transcript view. */
  readonly transcript: ChatMessage;
  /** Changes on every update. */
  readonly version: number;
};

/** What a run gets: its abort signal, and where its progress and events go. */
export type SubagentRunContext = {
  signal: AbortSignal;
  onProgress(progress: ChildProgress): void;
  onEvent(event: AgentSessionEvent): void;
};

export type StartSubagent = {
  description: string;
  prompt: string;
  run(context: SubagentRunContext): Promise<ChildRun>;
};

export type SubagentsOptions = {
  /** A subagent settled while not disposed. */
  onSettled?: (snapshot: SubagentSnapshot) => void;
  /** Started, settled, pruned or disposed: the list changed (progress does not count). */
  onChange?: () => void;
  /** Quit's registry: each running subagent is stopped on quit, which waits for it. Default: none. */
  registerTurn?: (turn: QuitTurn) => () => void;
  stopGraceMs?: number;
  quitGraceMs?: number;
};

export type BackgroundSubagents = {
  /** Starts a subagent; throws when at the running cap or disposed. Synchronous: the slot is taken before the run awaits. */
  start(options: StartSubagent): SubagentSnapshot;
  get(id: string): SubagentSnapshot | undefined;
  /** Oldest first. */
  list(): SubagentSnapshot[];
  running(): number;
  /** Cancels these subagents and resolves once each has settled (or been marked stopped after the grace). */
  cancel(ids: readonly string[]): Promise<SubagentSnapshot[]>;
  /** Cancels one without waiting (the `/subagents` `x` key). */
  requestCancel(id: string): void;
  /** Resolves when the subagent has settled (at once for a settled or unknown id). */
  settled(id: string): Promise<void>;
  /** Called on every change, progress and transcript included. */
  subscribe(listener: () => void): () => void;
  /** Stops everything and waits (bounded) for it. */
  dispose(): Promise<void>;
  readonly disposed: boolean;
};

const bounded = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, ERROR_MAX);

/** The text of an assistant message's text blocks. */
function assistantText(message: { content?: unknown }): string {
  const content = Array.isArray(message.content) ? (message.content as { type?: string; text?: string }[]) : [];
  return content.map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : "")).join("");
}

/** "3 tool uses, 1200 tokens" */
function usageOf(snapshot: Pick<SubagentSnapshot, "toolUses" | "totalTokens">): string {
  return `${snapshot.toolUses} tool use${snapshot.toolUses === 1 ? "" : "s"}, ${snapshot.totalTokens} tokens`;
}

/** What the model is told when a subagent has settled: who it was and how it ended, then the child's own text. */
export function buildSubagentResult(snapshot: SubagentSnapshot): string {
  const who = `Background subagent ${snapshot.id} "${snapshot.description}"`;
  const after = `${formatElapsed(snapshot)} (${usageOf(snapshot)})`;
  if (snapshot.status === "completed") return `${who} completed in ${after}.\n\n${snapshot.text || NO_TEXT}`;
  if (snapshot.status === "failed") return `${who} failed after ${after}: ${snapshot.error ?? "unknown error"}`;
  if (snapshot.status === "stopped") return `${who} was stopped after ${after}.${snapshot.text ? `\n\nIts last text:\n${snapshot.text}` : ""}`;
  return `${who} is still running (${formatElapsed(snapshot)}, ${usageOf(snapshot)}).`;
}

const TRUNCATED = "… [truncated]";
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}${TRUNCATED}` : text);

/** A tool input over the cap with each long value cut (a value that is not a string is cut as JSON); the keys stay, so the view still finds `command` or `path`. */
function cappedInput(input: Record<string, unknown>): Record<string, unknown> {
  if ((JSON.stringify(input) ?? "").length <= MAX_TOOL_INPUT_CHARS) return input;
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => {
      if (typeof value === "string") return [key, cut(value, MAX_TOOL_INPUT_CHARS)];
      const json = JSON.stringify(value) ?? "";
      return [key, json.length > MAX_TOOL_INPUT_CHARS ? cut(json, MAX_TOOL_INPUT_CHARS) : value];
    }),
  );
}

// Parts already capped, with their size: each event only measures what is new.
const cappedSize = new WeakMap<MessagePart, number>();

function capPart(part: MessagePart): { part: MessagePart; size: number } {
  const known = cappedSize.get(part);
  if (known !== undefined) return { part, size: known };
  let next = part;
  if (part.type === "tool") {
    const input = cappedInput(part.input);
    const errorText = part.errorText === undefined ? undefined : cut(part.errorText, MAX_TOOL_INPUT_CHARS);
    if (input !== part.input || errorText !== part.errorText) next = { ...part, input, ...(errorText === undefined ? {} : { errorText }) };
  }
  const size =
    next.type === "text" || next.type === "reasoning"
      ? next.text.length
      : next.type === "tool"
        ? (JSON.stringify(next.input) ?? "").length + (next.errorText?.length ?? 0)
        : (next.summary?.length ?? 0) + next.description.length;
  cappedSize.set(next, size);
  return { part: next, size };
}

/**
 * The transcript with at most `MAX_TRANSCRIPT_PARTS` parts and about `MAX_TRANSCRIPT_CHARS` of text, the newest kept; a newest part
 * over the whole cap keeps its tail. Returns the same message when nothing changes. Only applied when no part is streaming
 * (after a message or a tool call ended): pi's event folding finds a streamed part by identity.
 */
export function capTranscript(message: ChatMessage): ChatMessage {
  const kept: MessagePart[] = [];
  let total = 0;
  let changed = false;
  for (let at = message.parts.length - 1; at >= 0; at--) {
    const original = message.parts[at]!;
    if (kept.length >= MAX_TRANSCRIPT_PARTS) break;
    let { part, size } = capPart(original);
    if (total + size > MAX_TRANSCRIPT_CHARS) {
      // Only the newest part may be cut to fit; older ones are dropped whole.
      if (kept.length > 0 || (part.type !== "text" && part.type !== "reasoning")) break;
      part = { ...part, text: `[truncated]…${part.text.slice(-MAX_TRANSCRIPT_CHARS)}` };
      size = MAX_TRANSCRIPT_CHARS;
      cappedSize.set(part, size);
    }
    if (part !== original) changed = true;
    kept.push(part);
    total += size;
  }
  if (!changed && kept.length === message.parts.length) return message;
  return { ...message, parts: kept.reverse() };
}

type Mutable = { -readonly [K in keyof SubagentSnapshot]: SubagentSnapshot[K] };

type Entry = {
  snapshot: Mutable;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  settled: Promise<void>;
  resolveSettled: () => void;
  unregister: () => void;
};

export function createSubagents({
  onSettled,
  onChange,
  registerTurn = () => () => {},
  stopGraceMs = STOP_GRACE_MS,
  quitGraceMs = QUIT_STOP_GRACE_MS,
}: SubagentsOptions = {}): BackgroundSubagents {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let counter = 0;
  let disposed = false;

  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {}
    }
  };
  const changed = () => {
    notify();
    try {
      onChange?.();
    } catch {}
  };

  const running = () => [...entries.values()].filter((entry) => entry.snapshot.status === "running").length;

  const prune = () => {
    if (entries.size <= MAX_TRACKED_SUBAGENTS) return;
    const candidates = [...entries.values()]
      .filter((entry) => entry.snapshot.status !== "running")
      .sort((a, b) => (a.snapshot.settledAt ?? a.snapshot.createdAt) - (b.snapshot.settledAt ?? b.snapshot.createdAt));
    for (const entry of candidates) {
      if (entries.size <= MAX_TRACKED_SUBAGENTS) break;
      entries.delete(entry.snapshot.id);
    }
  };

  const settle = (entry: Entry, status: Exclude<SubagentStatus, "running">, error?: string) => {
    const snapshot = entry.snapshot;
    if (snapshot.status !== "running") return;
    snapshot.status = status;
    // Settled, it only keeps the capped tail (a part that was still streaming is capped now too).
    snapshot.transcript = capTranscript(snapshot.transcript);
    snapshot.settledAt = Date.now();
    if (error !== undefined) snapshot.error = error;
    snapshot.version += 1;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.unregister();
    entry.resolveSettled();
    if (!disposed) {
      try {
        onSettled?.(snapshot);
      } catch {}
    }
    prune();
    changed();
  };

  /** Aborts the child; if it has not ended `graceMs` later, it is marked stopped anyway. */
  const stop = (entry: Entry, graceMs: number) => {
    if (entry.snapshot.status !== "running") return;
    entry.controller.abort();
    // A shorter grace (quit) replaces a longer one already counting.
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => settle(entry, "stopped"), graceMs);
  };

  const start = ({ description, prompt, run }: StartSubagent): SubagentSnapshot => {
    if (disposed) throw new Error("Background subagents are shutting down.");
    // Counted and taken here, before anything awaits: starts made together cannot pass the cap.
    if (running() >= MAX_RUNNING_SUBAGENTS) {
      throw new Error(
        `At most ${MAX_RUNNING_SUBAGENTS} background subagents can run at once. Wait for one with task_wait or stop one with task_cancel before starting another.`,
      );
    }
    const id = `sa-${++counter}`;
    let resolveSettled = () => {};
    const settled = new Promise<void>((resolve) => (resolveSettled = resolve));
    const snapshot: Mutable = {
      id,
      description,
      prompt,
      status: "running",
      createdAt: Date.now(),
      toolUses: 0,
      totalTokens: 0,
      costUsd: 0,
      text: "",
      transcript: { id: `${id}-transcript`, role: "assistant", parts: [] },
      version: 0,
    };
    const entry: Entry = { snapshot, controller: new AbortController(), settled, resolveSettled, unregister: () => {} };
    entries.set(id, entry);

    const context: SubagentRunContext = {
      signal: entry.controller.signal,
      onProgress(progress) {
        if (snapshot.status !== "running") return;
        snapshot.toolUses = progress.toolUses;
        snapshot.totalTokens = progress.totalTokens;
        if (progress.lastToolName !== undefined) snapshot.lastToolName = progress.lastToolName;
        snapshot.version += 1;
        notify();
      },
      onEvent(event) {
        if (snapshot.status !== "running") return;
        const folded = applyPiEvent(snapshot.transcript, event);
        // Capped when nothing streams: once a message or a tool call has ended.
        const next = folded !== snapshot.transcript && (event.type === "message_end" || event.type === "tool_execution_end") ? capTranscript(folded) : folded;
        if (event.type === "message_end" && event.message.role === "assistant") {
          const text = assistantText(event.message);
          if (text) snapshot.text = text;
        }
        if (next === snapshot.transcript && event.type !== "message_end") return;
        snapshot.transcript = next;
        snapshot.costUsd = next.metadata?.costUsd ?? snapshot.costUsd;
        snapshot.version += 1;
        notify();
      },
    };

    entry.unregister = registerTurn({ stop: () => stop(entry, quitGraceMs), done: settled });
    changed();

    void (async () => run(context))().then(
      (result) => {
        if (snapshot.status !== "running") return;
        snapshot.toolUses = result.toolUses;
        snapshot.totalTokens = result.totalTokens;
        snapshot.costUsd = result.costUsd;
        if (result.lastToolName !== undefined) snapshot.lastToolName = result.lastToolName;
        snapshot.text = result.text;
        // A child that answered as the abort arrived did not finish its work for the user.
        settle(entry, entry.controller.signal.aborted ? "stopped" : "completed");
      },
      (error: unknown) => settle(entry, entry.controller.signal.aborted ? "stopped" : "failed", entry.controller.signal.aborted ? undefined : bounded(error)),
    );
    return snapshot;
  };

  return {
    start,
    get: (id) => entries.get(id)?.snapshot,
    list: () => [...entries.values()].map((entry) => entry.snapshot),
    running,
    async cancel(ids) {
      const known = [...new Set(ids)].map((id) => entries.get(id)).filter((entry): entry is Entry => entry !== undefined);
      for (const entry of known) stop(entry, stopGraceMs);
      await Promise.all(known.map((entry) => entry.settled));
      return known.map((entry) => entry.snapshot);
    },
    requestCancel(id) {
      const entry = entries.get(id);
      if (entry) stop(entry, stopGraceMs);
    },
    settled: (id) => entries.get(id)?.settled ?? Promise.resolve(),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const all = [...entries.values()];
      for (const entry of all) stop(entry, quitGraceMs);
      await Promise.all(all.map((entry) => entry.settled));
      changed();
      listeners.clear();
    },
    get disposed() {
      return disposed;
    },
  };
}
