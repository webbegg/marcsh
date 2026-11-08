import { useCallback, useRef, useState } from "react";
import type { ModeType } from "../lib/modes";
import type { ChatMessage } from "../lib/chat-types";
import type { AskQuestion } from "../lib/ask-user-question";
import { claudeEngine } from "../lib/engine/claude";
import type { Engine, EngineEvent, EngineTurn, PermissionAsk, PermissionDecision, TurnHost } from "../lib/engine/types";
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

export type PendingRequest = PermissionRequest | QuestionRequest;

export type SubmitParams = { userText: string; mode: ModeType; model: string };

export function useChat(session: StoredSession, engine: Engine = claudeEngine) {
  const [messages, setMessages] = useState<ChatMessage[]>(session.messages);
  const [status, setStatus] = useState<ChatStatus>("ready");
  const [error, setError] = useState<string | null>(null);
  const [permissionQueue, setPermissionQueue] = useState<PendingRequest[]>([]);

  const messagesRef = useRef(messages);
  const statusRef = useRef<ChatStatus>("ready");
  const resumeRefRef = useRef(session.claudeSessionId);
  const turnRef = useRef<EngineTurn | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const interruptedRef = useRef(false);
  const pendingRequestsRef = useRef(new Set<PendingRequest>());

  const updateMessages = useCallback((update: (prev: ChatMessage[]) => ChatMessage[]) => {
    messagesRef.current = update(messagesRef.current);
    setMessages(messagesRef.current);
  }, []);

  const updateStatus = useCallback((next: ChatStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const submit = useCallback(
    async ({ userText, mode, model }: SubmitParams) => {
      if (statusRef.current !== "ready") return;
      updateStatus("submitted");
      setError(null);
      interruptedRef.current = false;

      const replyId = crypto.randomUUID();
      const metadata = { mode, model };
      updateMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: userText }], metadata },
        { id: replyId, role: "assistant", parts: [], metadata },
      ]);

      const applyToReply = (update: (reply: ChatMessage) => ChatMessage) =>
        updateMessages((prev) => prev.map((m) => (m.id === replyId ? update(m) : m)));

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      // One queue for approvals and questions; each request resolves its promise once and an abort declines it.
      const waitForUser = <T,>(signal: AbortSignal, declined: T, build: (respond: (value: T) => void) => PendingRequest) =>
        new Promise<T>((resolve) => {
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
              getStorage().saveClaudeCommands(event.commands);
            } catch {}
            break;
          case "error":
            if (!interruptedRef.current) setError(event.message);
            break;
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
      };

      try {
        const turn = engine.startTurn(
          {
            prompt: userText,
            cwd: session.cwd,
            mode,
            model,
            resumeRef: resumeRefRef.current ?? undefined,
            signal: abortController.signal,
          },
          host,
        );
        turnRef.current = turn;
        await turn.done;
      } catch (err) {
        if (!abortController.signal.aborted && !interruptedRef.current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        turnRef.current = null;
        abortControllerRef.current = null;
        // Requests the engine is still waiting on (it can end the turn without aborting) are declined, not just dropped.
        for (const request of [...pendingRequestsRef.current]) {
          if (request.kind === "question") request.respond(null);
          else request.respond("deny");
        }
        setPermissionQueue([]);
        applyToReply(finishReply);
        updateStatus("ready");

        try {
          getStorage().saveMessages(session.id, messagesRef.current, resumeRefRef.current ?? undefined);
        } catch (err) {
          setError(`Could not save session: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
    [session.id, session.cwd, engine, updateMessages, updateStatus],
  );

  const interrupt = useCallback(() => {
    interruptedRef.current = true;
    turnRef.current?.interrupt();
  }, []);

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
    pendingRequest: permissionQueue[0] ?? null,
  };
}
