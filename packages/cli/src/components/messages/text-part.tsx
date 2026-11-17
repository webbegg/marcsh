import type { MessagePart } from "../../lib/chat-types";
import { escapeTranscriptText as safe } from "../../lib/display-text";

type TextPartData = Extract<MessagePart, { type: "text" }>;

/** One block of the reply's text. */
export function TextPart({ part }: { part: TextPartData }) {
  return (
    <box paddingX={3} width="100%">
      <text>{safe(part.text)}</text>
    </box>
  );
}
