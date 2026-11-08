import { useCallback, useRef, useState } from "react";
import { query, type CanUseTool, type PermissionResult, type Query } from "@anthropic-ai/claude-agent-sdk";
import type { ModeType } from "../lib/modes";
import type { ChatMessage } from "../lib/chat-types";
import {
  applySdkMessage,
  finishReply,
  parseAskUserQuestion,
  resultError,
  toAnswersResult,
  toDeclinedResult,
  toPermissionMode,
  toPermissionResult,
  type AskQuestion,
  type PermissionDecision,
} from "../lib/sdk-messages";
import { normalizeClaudeCommands } from "../lib/claude-commands";
import { getStorage, type StoredSession } from "../lib/storage";

export type ChatStatus = "ready" | "submitted" | "streaming";

export type PermissionRequest = {
  kind: "permission";
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  /** The ask must not be approvable by one keystroke: no one-key approve, no always-allow. */
  defaultToNo?: boolean;
  suppressAlwaysAllowRule?: boolean;
  respond: (decision: PermissionDecision) => void;
};

/** Claude's `AskUserQuestion`: `respond` takes the answers keyed by question text, or null to decline. */
export type QuestionRequest = {
  kind: "question";
  id: string;
  questions: AskQuestion[];
  respond: (answers: Record<string, string> | null) => void;
};

export type PendingRequest = PermissionRequest | QuestionRequest;

export type SubmitParams = { userText: string; mode: ModeType; model: string };

// The command list only feeds the `/` menu: failing to fetch or save it never affects the turn.
function cacheClaudeCommands(commands: unknown) {
  try {
    getStorage().saveClaudeCommands(normalizeClaudeCommands(commands));
  } catch {}
}

async function refreshClaudeCommands(chat: Query) {
  try {
    cacheClaudeCommands(await chat.supportedCommands());
  } catch {}
}

export function useChat(session: StoredSession) {
  const [messages, setMessages] = useState<ChatMessage[]>(session.messages);
  const [status, setStatus] = useState<ChatStatus>("ready");
  const [error, setError] = useState<string | null>(null);
  const [permissionQueue, setPermissionQueue] = useState<PendingRequest[]>([]);

  const messagesRef = useRef(messages);
  const statusRef = useRef<ChatStatus>("ready");
  const claudeSessionIdRef = useRef(session.claudeSessionId);
  const queryRef = useRef<Query | null>(null);
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

      const canUseTool: CanUseTool = (toolName, input, options) =>
        new Promise((resolve) => {
          // One queue for approvals and questions; each request resolves its promise once and an abort denies it.
          const enqueue = (request: PendingRequest, deny: () => void) => {
            options.signal.addEventListener("abort", deny, { once: true });
            pendingRequestsRef.current.add(request);
            setPermissionQueue((queue) => [...queue, request]);
          };
          const dequeue = (request: PendingRequest, onAbort: () => void, result: PermissionResult) => {
            // Already answered, denied by abort, or denied at turn end: never resolve twice.
            if (!pendingRequestsRef.current.delete(request)) return;
            options.signal.removeEventListener("abort", onAbort);
            setPermissionQueue((queue) => queue.filter((r) => r !== request));
            resolve(result);
          };

          const asked = toolName === "AskUserQuestion" ? parseAskUserQuestion(input) : null;
          if (asked) {
            const question: QuestionRequest = {
              kind: "question",
              id: crypto.randomUUID(),
              questions: asked.questions,
              respond(answers) {
                dequeue(question, onAbort, answers ? toAnswersResult(input, answers) : toDeclinedResult());
              },
            };
            const onAbort = () => question.respond(null);
            enqueue(question, onAbort);
            return;
          }

          const request: PermissionRequest = {
            kind: "permission",
            toolName,
            input,
            title: options.title,
            description: options.description,
            decisionReason: options.decisionReason,
            blockedPath: options.blockedPath,
            defaultToNo: options.defaultToNo,
            suppressAlwaysAllowRule: options.suppressAlwaysAllowRule,
            respond(decision) {
              dequeue(
                request,
                onAbort,
                toPermissionResult(decision, input, options.suggestions, {
                  suppressAlwaysAllowRule: options.suppressAlwaysAllowRule || options.defaultToNo,
                }),
              );
            },
          };
          const onAbort = () => request.respond("deny");
          enqueue(request, onAbort);
        });

      try {
        const chat = query({
          prompt: userText,
          options: {
            cwd: session.cwd,
            model,
            permissionMode: toPermissionMode(mode),
            resume: claudeSessionIdRef.current ?? undefined,
            abortController,
            systemPrompt: { type: "preset", preset: "claude_code" },
            settingSources: ["user", "project", "local"],
            canUseTool,
          },
        });
        queryRef.current = chat;

        for await (const message of chat) {
          updateStatus("streaming");

          if (message.type === "system" && message.subtype === "init") {
            claudeSessionIdRef.current = message.session_id;
            void refreshClaudeCommands(chat);
          }

          // "Clients should REPLACE their cached command list"
          if (message.type === "system" && message.subtype === "commands_changed") {
            cacheClaudeCommands(message.commands);
          }

          applyToReply((reply) => applySdkMessage(reply, message));

          const failure = resultError(message);
          if (failure && !interruptedRef.current) setError(failure);
        }
      } catch (err) {
        if (!abortController.signal.aborted && !interruptedRef.current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        queryRef.current = null;
        abortControllerRef.current = null;
        // Requests the SDK is still waiting on (it can end the stream without aborting) are denied, not just dropped.
        for (const request of [...pendingRequestsRef.current]) {
          if (request.kind === "question") request.respond(null);
          else request.respond("deny");
        }
        setPermissionQueue([]);
        applyToReply(finishReply);
        updateStatus("ready");

        try {
          getStorage().saveMessages(session.id, messagesRef.current, claudeSessionIdRef.current ?? undefined);
        } catch (err) {
          setError(`Could not save session: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
    [session.id, session.cwd, updateMessages, updateStatus],
  );

  const interrupt = useCallback(() => {
    interruptedRef.current = true;
    void queryRef.current?.interrupt();
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
