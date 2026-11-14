import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentTools } from "../lib/agent-tools";
import type { ModeType } from "../lib/modes";
import { loadAttachments, referenceText, type Attachment } from "../lib/attachments";
import type { ChatMessage, MessageAttachment } from "../lib/chat-types";
import type { AskQuestion } from "../lib/ask-user-question";
import type { BackgroundBatch, BackgroundHost, BackgroundHub } from "../lib/background/hub";
import { claudeEngine } from "../lib/engine/claude";
import type { ProjectChanges, ProjectResource, TrustAnswer } from "../lib/engine/pi-trust";
import { type Engine, type EngineEvent, type EngineTurn, type NoticeLevel, type PermissionAsk, type PermissionDecision, type TurnHost } from "../lib/engine/types";
import { useApprovalMode } from "../providers/prompt-config";
import { registerTurn } from "../lib/quit";
import { finishReply } from "../lib/reply";
import { dropRedo, SNAPSHOT_TIMEOUT_MS, trackWithin, withSnapshot } from "../lib/session-snapshots";
import { primeWithTranscript } from "./transcript-primer";
import type { SnapshotStoreResult } from "../lib/snapshot";
import { getStorage, type StoredSession } from "../lib/storage";
import { mergeUsage, reported } from "../lib/usage";

export type ChatStatus = "ready" | "submitted" | "streaming";

export type PermissionRequest = PermissionAsk & {
  kind: "permission";
  respond: (decision: PermissionDecision) => void;
};

/** `AskUserQuestion`: `respond` takes the answers keyed by question text, or null to decline. */
export type QuestionRequest = {
  kind: "question";
  id: string;
  questions: AskQuestion[];
  respond: (answers: Record<string, string> | null) => void;
};

/** An engine's own dialogs (pi extensions): each `respond` takes the answer, or the cancelled value. */
export type SelectRequest = {
  kind: "select";
  id: string;
  title: string;
  options: string[];
  respond: (choice: string | undefined) => void;
};

export type ConfirmRequest = {
  kind: "confirm";
  id: string;
  title: string;
  message: string;
  respond: (confirmed: boolean) => void;
};

export type InputRequest = {
  kind: "input";
  id: string;
  title: string;
  placeholder?: string;
  respond: (text: string | undefined) => void;
};

export type EditorRequest = {
  kind: "editor";
  id: string;
  title: string;
  prefill?: string;
  respond: (text: string | undefined) => void;
};

/** marcsh's own question before pi loads a project's pi files (not an extension dialog): `respond` takes the answer; "skip" = untrusted for this turn only. `changes` is set when the project was trusted before (see `ProjectTrustAsk`). */
export type TrustRequest = {
  kind: "trust";
  id: string;
  cwd: string;
  resources: ProjectResource[];
  changes?: ProjectChanges;
  respond: (answer: TrustAnswer) => void;
};

export type PendingRequest = PermissionRequest | QuestionRequest | SelectRequest | ConfirmRequest | InputRequest | EditorRequest | TrustRequest;

export type ChatOptions = {
  /** Shows a message from the engine that needs no answer (a toast). */
  notify?: (message: string, level: NoticeLevel) => void;
  /**
   * Puts a text the engine did not take back into the input the user typed it in (merged with what is there). Returns false when
   * nothing could take it, and the notice then carries the whole text.
   */
  restore?: (text: string) => boolean;
  /** The project's snapshot store: each turn is bracketed by two snapshots of the files. Absent: nothing is snapshotted. */
  snapshots?: SnapshotStoreResult;
  /** How long a snapshot may take before the turn goes on without it. Default: `SNAPSHOT_TIMEOUT_MS`. */
  snapshotTimeoutMs?: number;
  /**
   * The session's background hub (a pi session's screen has one): each turn gets it, the chat is its ask channel (`host`) for
   * background work, and the chat tells it to retry delivery whenever it goes idle.
   */
  background?: BackgroundHub;
};

/** How a compaction ended; `reason` is for the user. */
export type CompactOutcome = { ok: true; tokensBefore?: number; tokensAfter?: number } | { ok: false; reason: string };

// An aborted turn (the user left or quit) must not hold the exit up for a slow snapshot.
const ABORTED_SNAPSHOT_TIMEOUT_MS = 3_000;

/**
 * What the session's conversation had cost in all after its last reply that says so, to subtract from a resumed turn's running total.
 * A reply saved before the total was kept has it as its cost: it stored the engine's running total as it was.
 */
export function priorCumulativeCost(messages: ChatMessage[]): number | undefined {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue;
    const usage = message.metadata?.usage;
    const total = reported(usage?.cumulativeCostUsd) ?? reported(usage?.costUsd) ?? reported(message.metadata?.costUsd);
    if (total !== undefined) return total;
  }
  return undefined;
}

/** Cancels a request the user never answered. */
function decline(request: PendingRequest) {
  switch (request.kind) {
    case "permission":
      return request.respond("deny");
    case "question":
      return request.respond(null);
    case "confirm":
      return request.respond(false);
    case "trust":
      return request.respond("skip");
    default:
      return request.respond(undefined);
  }
}

/** The agent answering a turn: its name labels the messages and its prompt goes to the engine, with its pack's plugin view (`pluginDir`) when it has one, and the tool groups it does not get (`tools`). */
export type TurnAgent = { name: string; prompt?: string; pluginDir?: string; tools?: AgentTools };
/**
 * `attachments`: the files attached to the message, as the input knew them; their bytes are read when the turn starts.
 * `background`: the turn delivers this batch of background results; `userText` is what the transcript keeps of it, and the engine
 * gets only the batch's text, as it is.
 */
export type SubmitParams = { userText: string; mode: ModeType; model: string; turnAgent?: TurnAgent; attachments?: MessageAttachment[]; background?: BackgroundBatch };

/** What the user typed during the turn that the engine has not sent yet. */
export type QueuedInput = { steering: string[]; followUp: string[] };

const NOTHING_QUEUED: QueuedInput = { steering: [], followUp: [] };

export function useChat(session: StoredSession, engine: Engine = claudeEngine, options: ChatOptions = {}) {
  // The mode in force when a turn starts; outside a provider (tests) it is normal.
  const approvalMode = useApprovalMode();
  // Read by the engine when each tool call is decided, so a /permissions switch during a turn applies to the next call.
  const approvalModeRef = useRef(approvalMode);
  approvalModeRef.current = approvalMode;
  const [messages, setMessages] = useState<ChatMessage[]>(session.messages);
  const [status, setStatus] = useState<ChatStatus>("ready");
  const [error, setError] = useState<string | null>(null);
  const [permissionQueue, setPermissionQueue] = useState<PendingRequest[]>([]);
  const [queued, setQueued] = useState<QueuedInput>(NOTHING_QUEUED);
  const [canSteer, setCanSteer] = useState(false);
  // The turn is still winding down but takes no more text: the engine has settled, or the turn was interrupted.
  const [inputClosed, setInputClosed] = useState(false);
  // The engine is compacting the context: busy, but no turn runs, so the input takes nothing (a prompt sent now would be dropped).
  const [compacting, setCompacting] = useState(false);

  const messagesRef = useRef(messages);
  const statusRef = useRef<ChatStatus>("ready");
  const resumeRefRef = useRef(session.engineSessionRef);
  const needsPrimerRef = useRef(!session.engineSessionRef && session.messages.length > 0);
  const turnRef = useRef<EngineTurn | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const interruptedRef = useRef(false);
  const inputClosedRef = useRef(false);
  const pendingRequestsRef = useRef(new Set<PendingRequest>());
  const backgroundRef = useRef(options.background);
  backgroundRef.current = options.background;
  const notifyRef = useRef(options.notify);
  notifyRef.current = options.notify;
  const restoreRef = useRef(options.restore);
  restoreRef.current = options.restore;
  const snapshotsRef = useRef(options.snapshots);
  snapshotsRef.current = options.snapshots;
  const snapshotTimeoutRef = useRef(options.snapshotTimeoutMs ?? SNAPSHOT_TIMEOUT_MS);
  snapshotTimeoutRef.current = options.snapshotTimeoutMs ?? SNAPSHOT_TIMEOUT_MS;
  // Why the last turn has no snapshot (a failure or a timeout), for `/undo` to say.
  const snapshotIssueRef = useRef<string | undefined>(undefined);
  // A snapshot that was given up on keeps running in the background, so the next would only queue behind it: this session takes no more.
  const snapshotsGaveUpRef = useRef(false);
  const compactingRef = useRef<AbortController | null>(null);

  const updateMessages = useCallback((update: (prev: ChatMessage[]) => ChatMessage[]) => {
    messagesRef.current = update(messagesRef.current);
    setMessages(messagesRef.current);
  }, []);

  const updateStatus = useCallback((next: ChatStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  // One queue for approvals, questions and the engine's dialogs; each request resolves its promise once and an abort declines it.
  // `owner` holds the requests of whoever asked (a turn, or the session's background work), so a turn ending declines only its own.
  const waitForUser = useCallback(
    <T,>(owner: Set<PendingRequest>, signal: AbortSignal, declined: T, build: (respond: (value: T) => void) => PendingRequest) =>
      new Promise<T>((resolve) => {
        // An abort that already happened would never be heard: decline without showing anything.
        if (signal.aborted) return resolve(declined);
        const respond = (value: T) => {
          // Already answered, declined by abort, or declined at turn end: never resolve twice.
          if (!pendingRequestsRef.current.delete(request)) return;
          owner.delete(request);
          signal.removeEventListener("abort", onAbort);
          setPermissionQueue((queue) => queue.filter((r) => r !== request));
          resolve(value);
          // The last answer an idle chat waited for: background results held back by it may go now.
          if (pendingRequestsRef.current.size === 0 && statusRef.current === "ready") backgroundRef.current?.retry();
        };
        const onAbort = () => respond(declined);
        const request = build(respond);
        signal.addEventListener("abort", onAbort, { once: true });
        pendingRequestsRef.current.add(request);
        owner.add(request);
        setPermissionQueue((queue) => [...queue, request]);
      }),
    [],
  );

  const makeHost = useCallback(
    (owner: Set<PendingRequest>, emit: (event: EngineEvent) => void): TurnHost => ({
      emit,
      askPermission: (ask, signal) => waitForUser<PermissionDecision>(owner, signal, "deny", (respond) => ({ ...ask, kind: "permission", respond })),
      askQuestions: (questions, signal) =>
        waitForUser<Record<string, string> | null>(owner, signal, null, (respond) => ({
          kind: "question",
          id: crypto.randomUUID(),
          questions,
          respond,
        })),
      select: (title, options, signal) =>
        waitForUser<string | undefined>(owner, signal, undefined, (respond) => ({
          kind: "select",
          id: crypto.randomUUID(),
          title,
          options,
          respond,
        })),
      confirm: (title, message, signal) =>
        waitForUser<boolean>(owner, signal, false, (respond) => ({ kind: "confirm", id: crypto.randomUUID(), title, message, respond })),
      input: (title, placeholder, signal) =>
        waitForUser<string | undefined>(owner, signal, undefined, (respond) => ({
          kind: "input",
          id: crypto.randomUUID(),
          title,
          placeholder,
          respond,
        })),
      editor: (title, prefill, signal) =>
        waitForUser<string | undefined>(owner, signal, undefined, (respond) => ({
          kind: "editor",
          id: crypto.randomUUID(),
          title,
          prefill,
          respond,
        })),
      askProjectTrust: (ask, signal) =>
        waitForUser<TrustAnswer>(owner, signal, "skip", (respond) => ({ kind: "trust", id: crypto.randomUUID(), ...ask, respond })),
      notify: (message, level) => notifyRef.current?.(message, level),
    }),
    [waitForUser],
  );

  // Background work asks the user through the session, not through the turn that started it (which may have ended).
  const hub = options.background;
  useEffect(() => {
    if (!hub) return;
    // What background work asked: no turn's end declines it, leaving the session does.
    const requests = new Set<PendingRequest>();
    const { askPermission, notify } = makeHost(requests, () => {});
    const channel: BackgroundHost = { askPermission, notify };
    hub.host = channel;
    return () => {
      if (hub.host === channel) hub.host = undefined;
      for (const request of [...requests]) decline(request);
    };
  }, [hub, makeHost]);

  const submit = useCallback(
    async ({ userText, mode, model, turnAgent, attachments, background }: SubmitParams) => {
      if (statusRef.current !== "ready") return;
      updateStatus("submitted");
      setError(null);
      interruptedRef.current = false;
      inputClosedRef.current = false;

      // A session opened with messages but no engine conversation (a fork) starts one primed with what was said, once; the chat shows only
      // what was typed. An engine that never reports a conversation is not primed again on each turn.
      const said = background ? background.text : userText;
      let enginePrompt = said;
      if (needsPrimerRef.current && !resumeRefRef.current) {
        enginePrompt = primeWithTranscript(said, session, messagesRef.current);
        if (enginePrompt !== said) needsPrimerRef.current = false;
      }

      // A message delivered to the turn closes this reply: what follows is a new one, so the ids are kept.
      let replyId = crypto.randomUUID();
      const replyIds = [replyId];
      const metadata = { mode, model, ...(turnAgent ? { agent: turnAgent.name } : {}) };
      const userMetadata = { ...metadata, ...(attachments?.length ? { attachments } : {}), ...(background ? { background: true } : {}) };
      updateMessages((prev) => [
        // A new turn ends every redo: what an undo took back stays gone.
        ...dropRedo(prev),
        { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: userText }], metadata: userMetadata },
        { id: replyId, role: "assistant", parts: [], metadata },
      ]);

      const applyToReply = (update: (reply: ChatMessage) => ChatMessage, id = replyId) =>
        updateMessages((prev) => prev.map((m) => (m.id === id ? update(m) : m)));

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      // Quitting the app aborts this turn and waits for `finished`, which settles after the reply has been saved.
      let finishTurn = () => {};
      const finished = new Promise<void>((resolve) => (finishTurn = resolve));
      const unregisterTurn = registerTurn({ stop: () => abortController.abort(), done: finished });
      // What this turn asked the user: declined when it ends unanswered.
      const turnRequests = new Set<PendingRequest>();

      const onEvent = (event: EngineEvent) => {
        switch (event.type) {
          case "reply":
            updateStatus("streaming");
            applyToReply(event.update);
            break;
          case "session":
            resumeRefRef.current = event.ref;
            break;
          case "commands":
            // The command list only feeds the `/` menu: failing to save it never affects the turn.
            try {
              getStorage().saveCommands(session.engine, event.commands);
            } catch {}
            break;
          case "error":
            if (!interruptedRef.current) setError(event.message);
            break;
          case "queue":
            if (!interruptedRef.current) setQueued({ steering: event.steering, followUp: event.followUp });
            break;
          case "input-closed":
            inputClosedRef.current = true;
            setInputClosed(true);
            setCanSteer(false);
            setQueued(NOTHING_QUEUED);
            break;
          case "delivered": {
            const closed = replyId;
            replyId = crypto.randomUUID();
            replyIds.push(replyId);
            const next = replyId;
            updateStatus("streaming");
            updateMessages((prev) => [
              // A reply that said nothing before the message came leaves no empty bot row behind.
              ...prev.filter((m) => !(m.id === closed && m.parts.length === 0)),
              {
                id: crypto.randomUUID(),
                role: "user",
                parts: [{ type: "text", text: event.text }],
                metadata: event.kind === "steer" ? { ...metadata, steered: true } : event.kind === "background" ? { ...metadata, background: true } : metadata,
              },
              { id: next, role: "assistant", parts: [], metadata },
            ]);
            break;
          }
        }
      };

      const host = makeHost(turnRequests, onEvent);

      let before: string | undefined;
      let started = false;
      try {
        // The files as the turn finds them. Never blocks the turn for long, and a failure only means `/undo` has nothing for it.
        const store = snapshotsRef.current?.available && !snapshotsGaveUpRef.current ? snapshotsRef.current.store : undefined;
        if (store) {
          const tracked = await trackWithin(store, snapshotTimeoutRef.current);
          before = "tree" in tracked ? tracked.tree : undefined;
          snapshotIssueRef.current = "reason" in tracked ? tracked.reason : undefined;
          if ("timedOut" in tracked) snapshotsGaveUpRef.current = true;
        }
        // Esc or leaving the session while the files were being captured: the turn never starts.
        if (interruptedRef.current || abortController.signal.aborted) return;

        // The files are read now, not when they were attached. One that cannot be read any more is mentioned as `@path` instead.
        let loaded: Attachment[] | undefined;
        if (attachments?.length) {
          const result = await loadAttachments(attachments);
          loaded = result.loaded;
          for (const { reason } of result.failed) notifyRef.current?.(`${reason} It goes as an @path reference.`, "warning");
          enginePrompt = referenceText(enginePrompt, result.failed.map((failure) => failure.attachment), session.cwd);
          if (interruptedRef.current || abortController.signal.aborted) return;
        }

        started = true;
        const turn = engine.startTurn(
          {
            prompt: enginePrompt,
            ...(loaded ? { attachments: loaded } : {}),
            cwd: session.cwd,
            mode,
            approvalMode: approvalModeRef.current,
            currentApprovalMode: () => approvalModeRef.current,
            model,
            systemPromptAppend: turnAgent?.prompt,
            ...(turnAgent?.pluginDir ? { packPluginPath: turnAgent.pluginDir } : {}),
            ...(turnAgent?.tools && turnAgent.tools.deny.length > 0 ? { deniedTools: turnAgent.tools.deny } : {}),
            resumeRef: resumeRefRef.current ?? undefined,
            ...(resumeRefRef.current ? { priorCostUsd: priorCumulativeCost(messagesRef.current) } : {}),
            ...(backgroundRef.current ? { background: backgroundRef.current } : {}),
            ...(background ? { promptKind: "background" as const } : {}),
            signal: abortController.signal,
          },
          host,
        );
        turnRef.current = turn;
        setCanSteer(typeof turn.steer === "function" && typeof turn.followUp === "function");
        await turn.done;
      } catch (err) {
        if (!abortController.signal.aborted && !interruptedRef.current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        turnRef.current = null;
        // Requests the engine is still waiting on (it can end the turn without aborting) are declined, not just dropped.
        // Only this turn's: what background work asked through the session stays until it is answered.
        for (const request of [...turnRequests]) decline(request);
        for (const id of replyIds) applyToReply(finishReply, id);
        const save = () => {
          try {
            getStorage().saveMessages(session.id, messagesRef.current, resumeRefRef.current ?? undefined);
          } catch (err) {
            setError(`Could not save session: ${err instanceof Error ? err.message : String(err)}`);
          }
        };
        const settle = () => {
          abortControllerRef.current = null;
          setCanSteer(false);
          setInputClosed(false);
          setQueued(NOTHING_QUEUED);
          updateStatus("ready");
          unregisterTurn();
          finishTurn();
        };

        // The turn's messages are stored before anything slow: quitting waits only so long for the turn, and then ends the process.
        save();
        const aborted = abortController.signal.aborted;
        // An aborted turn (the user left or quit) is done now and does not wait for the snapshot; a finished one does, so that
        // the input stays as the turn left it until the reply has the pair `/undo` needs.
        if (aborted) settle();
        // The files as the turn left them, kept on its last reply: stored again once they are known.
        if (before !== undefined && started && snapshotsRef.current?.available) {
          const after = await trackWithin(snapshotsRef.current.store, aborted ? ABORTED_SNAPSHOT_TIMEOUT_MS : snapshotTimeoutRef.current);
          if ("tree" in after) {
            updateMessages((prev) => withSnapshot(prev, replyId, { before: before!, after: after.tree }));
            save();
          } else {
            snapshotIssueRef.current = after.reason;
            if ("timedOut" in after) snapshotsGaveUpRef.current = true;
          }
        }
        if (!aborted) settle();
        // Idle again, after the snapshot: results that finished meanwhile go now. Not after Esc: the user stopped the agent, so nothing restarts it by itself.
        if (!interruptedRef.current) backgroundRef.current?.retry();
      }
    },
    [session, engine, updateMessages, updateStatus, makeHost],
  );

  const interrupt = useCallback(() => {
    interruptedRef.current = true;
    compactingRef.current?.abort();
    // The engine discards what it has not sent; the turn takes no more input while it winds down.
    setCanSteer(false);
    if (turnRef.current) {
      inputClosedRef.current = true;
      setInputClosed(true);
    }
    setQueued(NOTHING_QUEUED);
    turnRef.current?.interrupt();
  }, []);

  // Typing during a turn: only an engine whose turn takes it (and only until it is interrupted or has settled) gets the text.
  // Returns whether the text was handed over; the caller keeps a refused text where the user typed it. An engine that
  // refuses afterwards (it settled in between, rejected the text, or the turn ended before it was sent) gets the text put back in
  // the input, whatever the error was, and the reason is shown; typed text is never lost silently or cut.
  // A text only reaches the engine's queue from here, so this is the one place a refusal has to be handled.
  const sendToTurn = useCallback((kind: "steer" | "followUp", text: string) => {
    const turn = turnRef.current;
    const send = kind === "steer" ? turn?.steer : turn?.followUp;
    if (!turn || !send || interruptedRef.current || inputClosedRef.current) return false;
    send.call(turn, text).catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      const restored = restoreRef.current?.(text) === true;
      notifyRef.current?.(restored ? `${reason} Your message is back in the input.` : `${reason} Your message was not sent: ${text}`, "warning");
    });
    return true;
  }, []);
  const steer = useCallback((text: string) => sendToTurn("steer", text), [sendToTurn]);
  const followUp = useCallback((text: string) => sendToTurn("followUp", text), [sendToTurn]);

  const abort = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  // Changes the messages outside a turn (an undo marks its reply) and saves them. Returns the reason when saving failed.
  const editMessages = useCallback(
    (update: (prev: ChatMessage[]) => ChatMessage[]): string | undefined => {
      updateMessages(update);
      try {
        getStorage().saveMessages(session.id, messagesRef.current, resumeRefRef.current ?? undefined);
        return undefined;
      } catch (err) {
        return `Could not save session: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    [session.id, updateMessages],
  );

  const getMessages = useCallback(() => messagesRef.current, []);
  // Whether the engine has a conversation of this session to continue (its first turn reported one).
  const hasConversation = useCallback(() => resumeRefRef.current != null, []);
  const snapshotIssue = useCallback(() => snapshotIssueRef.current, []);
  // Whether a turn could start now: none runs, nothing is compacting, and no request waits for the user.
  const isIdle = useCallback(() => statusRef.current === "ready" && compactingRef.current === null && pendingRequestsRef.current.size === 0, []);

  // Asks the engine to compact the conversation outside a turn. The session is busy meanwhile; Esc or leaving it cancels.
  const compact = useCallback(
    async (model: string): Promise<CompactOutcome> => {
      if (!engine.compact) return { ok: false, reason: "This engine cannot compact its context." };
      if (statusRef.current !== "ready") return { ok: false, reason: "Wait for the current turn to finish." };
      const resumeRef = resumeRefRef.current;
      if (!resumeRef) return { ok: false, reason: "Nothing to compact yet: this session has no conversation." };

      const controller = new AbortController();
      abortControllerRef.current = controller;
      compactingRef.current = controller;
      interruptedRef.current = false;
      setCompacting(true);
      updateStatus("submitted");
      try {
        const result = await engine.compact({ cwd: session.cwd, model, resumeRef, signal: controller.signal });
        if (controller.signal.aborted) return { ok: false, reason: "Compaction was cancelled." };
        const { tokensAfter } = result;
        // The status line shows the smaller context until the next reply reports its own.
        if (tokensAfter !== undefined) {
          const last = [...messagesRef.current].reverse().find((m) => m.role === "assistant" && m.metadata?.usage?.contextTokens !== undefined);
          if (last) {
            const failure = editMessages((prev) =>
              prev.map((m) => (m.id === last.id ? { ...m, metadata: { ...m.metadata, usage: mergeUsage(m.metadata?.usage, { contextTokens: tokensAfter }) } } : m)),
            );
            if (failure) setError(failure);
          }
        }
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      } finally {
        if (abortControllerRef.current === controller) abortControllerRef.current = null;
        compactingRef.current = null;
        setCompacting(false);
        updateStatus("ready");
        if (!controller.signal.aborted) backgroundRef.current?.retry();
      }
    },
    [engine, session.cwd, editMessages, updateStatus],
  );

  return {
    messages,
    status,
    error,
    submit,
    interrupt,
    abort,
    editMessages,
    compacting,
    getMessages,
    hasConversation,
    snapshotIssue,
    isIdle,
    compact,
    steer,
    followUp,
    queued,
    canSteer,
    inputClosed,
    pendingRequest: permissionQueue[0] ?? null,
  };
}
