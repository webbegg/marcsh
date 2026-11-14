import type { ChatMessage } from "../lib/chat-types";
import { renderTranscript, type TranscriptSession } from "../lib/transcript";

/** How much of the transcript goes in front of a prompt: the newest part, so a long session does not fill the new conversation's context. */
export const MAX_PRIMER_CHARS = 40_000;

/**
 * The first turn of a session whose engine has no conversation to continue (a fork copies the messages, not the engine's reference)
 * is sent with the transcript so far in front of the prompt, so the fresh engine conversation knows what was said. The chat still shows
 * the prompt as typed. A `/command` is left alone: the engine must see it at the start of the line.
 */
export function primeWithTranscript(prompt: string, session: Omit<TranscriptSession, "messages">, messages: ChatMessage[]): string {
  if (prompt.startsWith("/")) return prompt;
  const said = messages.filter((message) => message.parts.some((part) => part.type === "text" && part.text.trim() !== ""));
  if (said.length === 0) return prompt;

  let transcript = renderTranscript({ ...session, messages: said }, "md").trim();
  let omitted = false;
  if (transcript.length > MAX_PRIMER_CHARS) {
    const tail = transcript.slice(-MAX_PRIMER_CHARS);
    // Start at a message boundary.
    const boundary = tail.indexOf("\n## ");
    transcript = tail.slice(boundary >= 0 ? boundary + 1 : 0);
    omitted = true;
  }

  return [
    "This conversation continues an earlier session. Its history is not available to you, so here is the transcript so far:",
    "",
    transcript,
    ...(omitted ? ["", "(The earlier messages are left out: only the most recent part is shown.)"] : []),
    "",
    "Continue from there. The user's new message:",
    "",
    prompt,
  ].join("\n");
}
