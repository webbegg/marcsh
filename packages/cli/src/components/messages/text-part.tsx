import type { SyntaxStyle } from "@opentui/core";
import type { MessagePart } from "../../lib/chat-types";
import { escapeTranscriptText as safe } from "../../lib/display-text";

type TextPartData = Extract<MessagePart, { type: "text" }>;

/**
 * One block of the reply's text, drawn as markdown (headings, emphasis, lists, tables, fenced code).
 *
 * The text goes through the transcript escape first, so a control character shows as `\uXXXX` before markdown sees it: the
 * escape adds no markdown syntax of its own (a backslash before a letter is a plain backslash). Fenced code is coloured
 * only for the grammars OpenTUI bundles (typescript, tsx, javascript, markdown, zig); any other language, and any code
 * while the highlight has not landed yet, shows as plain monospace text. No tree-sitter client is passed, so nothing is
 * downloaded or written.
 *
 * `streaming` is true while this is the part still being written: an emphasis or fence not yet closed draws as closed.
 * `syntaxStyle` comes from one `useSyntaxStyle()` per message, not one per part.
 */
export function TextPart({ part, syntaxStyle, streaming = false }: { part: TextPartData; syntaxStyle: SyntaxStyle; streaming?: boolean }) {
  return (
    <box paddingX={3} width="100%">
      <markdown content={safe(part.text)} syntaxStyle={syntaxStyle} streaming={streaming} />
    </box>
  );
}
