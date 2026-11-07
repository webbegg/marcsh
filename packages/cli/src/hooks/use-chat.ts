import { useCallback, useRef, useState } from "react";
import { query, type CanUseTool, type Query } from "@anthropic-ai/claude-agent-sdk";
import type { ModeType } from "@marcsh/shared";
import type { ChatMessage } from "../lib/chat-types";
import {
  applySdkMessage,
  resultError,
  toPermissionMode,
  toPermissionResult,
  type PermissionDecision,
} from "../lib/sdk-messages";
import { getStorage, type StoredSession } from "../lib/storage";

export type ChatStatus = "ready" | "submitted" | "streaming";

export type PermissionRequest = {
  toolName: string;
  input: Record<string, unknown>;
  respond: (decision: PermissionDecision) => void;
};

export type SubmitParams = { userText: string; mode: ModeType; model: string };

export function useChat(session: StoredSession) {
  const [messages, setMessages] = useState<ChatMessage[]>(session.messages);
  const [status, setStatus] = useState<ChatStatus>("ready");
  const [error, setError] = useState<string | null>(null);
  const [permissionQueue, setPermissionQueue] = useState<PermissionRequest[]>([]);

  const messagesRef = useRef(messages);
  const statusRef = useRef<ChatStatus>("ready");
  const claudeSessionIdRef = useRef(session.claudeSessionId);
  const queryRef = useRef<Query | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const interruptedRef = useRef(false);

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
          const request: PermissionRequest = {
            toolName,
            input,
            respond(decision) {
              options.signal.removeEventListener("abort", onAbort);
              setPermissionQueue((queue) => queue.filter((r) => r !== request));
              resolve(toPermissionResult(decision, input, options.suggestions));
            },
          };
          const onAbort = () => request.respond("deny");

          options.signal.addEventListener("abort", onAbort, { once: true });
          setPermissionQueue((queue) => [...queue, request]);
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
        setPermissionQueue([]);
        updateStatus("ready");
        getStorage().saveMessages(session.id, messagesRef.current, claudeSessionIdRef.current ?? undefined);
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
    permissionRequest: permissionQueue[0] ?? null,
  };
}
