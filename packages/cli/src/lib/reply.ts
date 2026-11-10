import type { ChatMessage, MessagePart } from "./chat-types";

/** Ends a turn: tools still running will never get a result, so they are saved as interrupted errors; running tasks as stopped. */
export function finishReply(reply: ChatMessage): ChatMessage {
  const unfinished = (p: MessagePart) => (p.type === "tool" && p.state === "running") || (p.type === "task" && p.status === "running");
  if (!reply.parts.some(unfinished)) return reply;

  const parts = reply.parts.map((p): MessagePart => {
    if (p.type === "tool" && p.state === "running") return { ...p, state: "error", errorText: "Interrupted" };
    if (p.type === "task" && p.status === "running") return { ...p, status: "stopped" };
    return p;
  });
  return { ...reply, parts };
}
