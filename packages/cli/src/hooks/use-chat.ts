import { useCallback, useRef, useState } from "react";
import type { AgentTools } from "../lib/agent-tools";
import type { ModeType } from "../lib/modes";
import type { ChatMessage } from "../lib/chat-types";
import type { AskQuestion } from "../lib/ask-user-question";
import { claudeEngine } from "../lib/engine/claude";
import type { ProjectChanges, ProjectResource, TrustAnswer } from "../lib/engine/pi-trust";
import { type Engine, type EngineEvent, type EngineTurn, type NoticeLevel, type PermissionAsk, type PermissionDecision, type TurnHost } from "../lib/engine/types";
import { registerTurn } from "../lib/quit";
import { finishReply } from "../lib/reply";
import { getStorage, type StoredSession } from "../lib/storage";

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
};

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
export type SubmitParams = { userText: string; mode: ModeType; model: string; turnAgent?: TurnAgent };

/** What the user typed during the turn that the engine has not sent yet. */
export type QueuedInput = { steering: string[]; followUp: string[] };

const NOTHING_QUEUED: QueuedInput = { steering: [], followUp: [] };

export function useChat(session: StoredSession, engine: Engine = claudeEngine, options: ChatOptions = {}) {
  const [messages, setMessages] = useState<ChatMessage[]>(session.messages);
  const [status, setStatus] = useState<ChatStatus>("ready");
  const [error, setError] = useState<string | null>(null);
  const [permissionQueue, setPermissionQueue] = useState<PendingRequest[]>([]);
  const [queued, setQueued] = useState<QueuedInput>(NOTHING_QUEUED);
  const [canSteer, setCanSteer] = useState(false);
  // The turn is still winding down but takes no more text: the engine has settled, or the turn was interrupted.
  const [inputClosed, setInputClosed] = useState(false);

  const messagesRef = useRef(messages);
  const statusRef = useRef<ChatStatus>("ready");
  const resumeRefRef = useRef(session.engineSessionRef);
  const turnRef = useRef<EngineTurn | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const interruptedRef = useRef(false);
  const inputClosedRef = useRef(false);
  const pendingRequestsRef = useRef(new Set<PendingRequest>());
  const notifyRef = useRef(options.notify);
  notifyRef.current = options.notify;
  const restoreRef = useRef(options.restore);
  restoreRef.current = options.restore;

  const updateMessages = useCallback((update: (prev: ChatMessage[]) => ChatMessage[]) => {
    messagesRef.current = update(messagesRef.current);
    setMessages(messagesRef.current);
  }, []);

  const updateStatus = useCallback((next: ChatStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const submit = useCallback(
    async ({ userText, mode, model, turnAgent }: SubmitParams) => {
      if (statusRef.current !== "ready") return;
      updateStatus("submitted");
      setError(null);
      interruptedRef.current = false;
      inputClosedRef.current = false;

      // A message delivered to the turn closes this reply: what follows is a new one, so the ids are kept.
      let replyId = crypto.randomUUID();
      const replyIds = [replyId];
      const metadata = { mode, model, ...(turnAgent ? { agent: turnAgent.name } : {}) };
      updateMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: userText }], metadata },
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

      // One queue for approvals, questions and the engine's dialogs; each request resolves its promise once and an abort declines it.
      const waitForUser = <T,>(signal: AbortSignal, declined: T, build: (respond: (value: T) => void) => PendingRequest) =>
        new Promise<T>((resolve) => {
          // An abort that already happened would never be heard: decline without showing anything.
          if (signal.aborted) return resolve(declined);
          const respond = (value: T) => {
            // Already answered, declined by abort, or declined at turn end: never resolve twice.
            if (!pendingRequestsRef.current.delete(request)) return;
            signal.removeEventListener("abort", onAbort);
            setPermissionQueue((queue) => queue.filter((r) => r !== request));
            resolve(value);
          };
          const onAbort = () => respond(declined);
          const request = build(respond);
          signal.addEventListener("abort", onAbort, { once: true });
          pendingRequestsRef.current.add(request);
          setPermissionQueue((queue) => [...queue, request]);
        });

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
                metadata: event.kind === "steer" ? { ...metadata, steered: true } : metadata,
              },
              { id: next, role: "assistant", parts: [], metadata },
            ]);
            break;
          }
        }
      };

      const host: TurnHost = {
        emit: onEvent,
        askPermission: (ask, signal) =>
          waitForUser<PermissionDecision>(signal, "deny", (respond) => ({ ...ask, kind: "permission", respond })),
        askQuestions: (questions, signal) =>
          waitForUser<Record<string, string> | null>(signal, null, (respond) => ({
            kind: "question",
            id: crypto.randomUUID(),
            questions,
            respond,
          })),
        select: (title, options, signal) =>
          waitForUser<string | undefined>(signal, undefined, (respond) => ({
            kind: "select",
            id: crypto.randomUUID(),
            title,
            options,
            respond,
          })),
        confirm: (title, message, signal) =>
          waitForUser<boolean>(signal, false, (respond) => ({ kind: "confirm", id: crypto.randomUUID(), title, message, respond })),
        input: (title, placeholder, signal) =>
          waitForUser<string | undefined>(signal, undefined, (respond) => ({
            kind: "input",
            id: crypto.randomUUID(),
            title,
            placeholder,
            respond,
          })),
        editor: (title, prefill, signal) =>
          waitForUser<string | undefined>(signal, undefined, (respond) => ({
            kind: "editor",
            id: crypto.randomUUID(),
            title,
            prefill,
            respond,
          })),
        askProjectTrust: (ask, signal) =>
          waitForUser<TrustAnswer>(signal, "skip", (respond) => ({ kind: "trust", id: crypto.randomUUID(), ...ask, respond })),
        notify: (message, level) => notifyRef.current?.(message, level),
      };

      try {
        const turn = engine.startTurn(
          {
            prompt: userText,
            cwd: session.cwd,
            mode,
            model,
            systemPromptAppend: turnAgent?.prompt,
            ...(turnAgent?.pluginDir ? { packPluginPath: turnAgent.pluginDir } : {}),
            ...(turnAgent?.tools && turnAgent.tools.deny.length > 0 ? { deniedTools: turnAgent.tools.deny } : {}),
            resumeRef: resumeRefRef.current ?? undefined,
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
        abortControllerRef.current = null;
        setCanSteer(false);
        setInputClosed(false);
        setQueued(NOTHING_QUEUED);
        // Requests the engine is still waiting on (it can end the turn without aborting) are declined, not just dropped.
        for (const request of [...pendingRequestsRef.current]) decline(request);
        setPermissionQueue([]);
        for (const id of replyIds) applyToReply(finishReply, id);
        updateStatus("ready");

        try {
          getStorage().saveMessages(session.id, messagesRef.current, resumeRefRef.current ?? undefined);
        } catch (err) {
          setError(`Could not save session: ${err instanceof Error ? err.message : String(err)}`);
        }
        unregisterTurn();
        finishTurn();
      }
    },
    [session.id, session.cwd, session.engine, engine, updateMessages, updateStatus],
  );

  const interrupt = useCallback(() => {
    interruptedRef.current = true;
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

  return {
    messages,
    status,
    error,
    submit,
    interrupt,
    abort,
    steer,
    followUp,
    queued,
    canSteer,
    inputClosed,
    pendingRequest: permissionQueue[0] ?? null,
  };
}
