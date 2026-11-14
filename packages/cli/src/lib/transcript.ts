import type { ChatMessage, MessagePart } from "./chat-types";
import { escapeTranscriptText } from "./display-text";
import { printable } from "./safe-text";
import type { StoredSession } from "./storage";

export type TranscriptFormat = "md" | "json";

/** What a transcript needs of a session; notably not the engine resume ref, which never leaves storage. */
export type TranscriptSession = Pick<StoredSession, "id" | "title" | "cwd" | "engine" | "createdAt" | "updatedAt" | "messages">;

// Escape sequences a terminal would act on: CSI (colors, cursor, clear), OSC (title, hyperlinks, clipboard) ended by BEL or ST, and
// the other two-character escapes.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g;

/** Free text with its terminal control sequences removed; what is left of other control characters shows as visible escapes. */
const clean = (text: string): string => escapeTranscriptText(text.replace(ANSI, ""));

/** A single-line field (title, agent, model) with everything invisible removed. */
const field = (text: string): string => printable(text.replace(ANSI, ""));

const TOOL_INPUT_KEYS = ["command", "file_path", "path", "pattern", "url", "query", "description"];
const SUMMARY_LIMIT = 100;

const shorten = (text: string, limit = SUMMARY_LIMIT): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};

/** The one input value that says what a tool call did, or a cut-down JSON of the whole input. */
function toolInputSummary(input: Record<string, unknown>): string {
  for (const key of TOOL_INPUT_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value !== "") return shorten(clean(value));
  }
  const keys = Object.keys(input);
  return keys.length === 0 ? "" : shorten(clean(JSON.stringify(input)));
}

/** The model that answered, from the first assistant message that names one. */
const sessionModel = (messages: ChatMessage[]): string | undefined =>
  messages.find((message) => message.role === "assistant" && message.metadata?.model)?.metadata?.model;

const day = (date: Date) => date.toISOString().slice(0, 10);

const speaker = (message: ChatMessage): string =>
  message.role === "user" ? "You" : field(message.metadata?.agent ?? "") || "Assistant";

const code = (text: string) => `\`${text.replaceAll("`", "'")}\``;

function markdownPart(part: MessagePart): string | null {
  switch (part.type) {
    case "text":
      return clean(part.text).trim() || null;
    case "reasoning":
      return null;
    case "tool": {
      const summary = toolInputSummary(part.input);
      const error = part.state === "error" ? ` (failed${part.errorText ? `: ${shorten(clean(part.errorText))}` : ""})` : "";
      return `- Tool ${code(field(part.toolName))}${summary ? ` ${code(summary)}` : ""}${error}`;
    }
    case "task": {
      const summary = part.summary ? `: ${shorten(clean(part.summary), 300)}` : "";
      return `- Task (${part.status}) ${shorten(clean(part.description))}${summary}`;
    }
  }
}

function renderMarkdown(session: TranscriptSession): string {
  const model = sessionModel(session.messages);
  const lines = [`# ${field(session.title)}`, "", `- Date: ${day(session.createdAt)}`, `- Engine: ${field(session.engine)}${model ? ` (${field(model)})` : ""}`];

  for (const message of session.messages) {
    const blocks = [
      ...message.parts.map(markdownPart).filter((block): block is string => block !== null),
      ...(message.metadata?.attachments ?? []).map((attachment) => `- Attached ${attachment.kind} ${code(field(attachment.path))}`),
    ];
    // Consecutive tool lines stay one list; everything else is a paragraph of its own.
    const body = blocks.reduce((out, block, index) => {
      if (index === 0) return block;
      const list = block.startsWith("- ") && blocks[index - 1]!.startsWith("- ");
      return `${out}${list ? "\n" : "\n\n"}${block}`;
    }, "");
    lines.push("", `## ${speaker(message)}`, "", body);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** Every string in a JSON value cleaned of terminal control sequences. */
function cleanJson(value: unknown): unknown {
  if (typeof value === "string") return value.replace(ANSI, "").replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
  if (Array.isArray(value)) return value.map(cleanJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, cleanJson(inner)]));
  }
  return value;
}

function jsonPart(part: MessagePart): Record<string, unknown> | null {
  switch (part.type) {
    case "text":
      return { type: "text", text: cleanJson(part.text) };
    case "reasoning":
      return null;
    case "tool":
      return {
        type: "tool",
        name: cleanJson(part.toolName),
        input: cleanJson(part.input),
        state: part.state,
        ...(part.errorText !== undefined && { error: cleanJson(part.errorText) }),
      };
    case "task":
      return {
        type: "task",
        description: cleanJson(part.description),
        status: part.status,
        ...(part.summary !== undefined && { summary: cleanJson(part.summary) }),
      };
  }
}

function renderJson(session: TranscriptSession): string {
  const model = sessionModel(session.messages);
  const transcript = {
    version: 1,
    session: {
      id: session.id,
      title: cleanJson(session.title),
      cwd: session.cwd,
      engine: session.engine,
      ...(model !== undefined && { model: cleanJson(model) }),
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
    },
    messages: session.messages.map((message) => ({
      id: message.id,
      role: message.role,
      ...(message.metadata?.agent !== undefined && { agent: cleanJson(message.metadata.agent) }),
      ...(message.metadata?.model !== undefined && { model: cleanJson(message.metadata.model) }),
      ...(message.metadata?.attachments?.length && {
        attachments: message.metadata.attachments.map(({ path, mime, kind }) => ({ path: cleanJson(path), mime: cleanJson(mime), kind })),
      }),
      parts: message.parts.map(jsonPart).filter((part) => part !== null),
    })),
  };
  return `${JSON.stringify(transcript, null, 2)}\n`;
}

/** The session as a shareable document: reasoning is left out, tool calls are summarized (markdown) or kept structured (json). */
export function renderTranscript(session: TranscriptSession, format: TranscriptFormat): string {
  return format === "json" ? renderJson(session) : renderMarkdown(session);
}

/** `marcsh-<first 8 characters of the id>-<YYYY-MM-DD>.<md|json>`: a file name for the current directory. */
export function defaultExportPath(session: Pick<TranscriptSession, "id">, format: TranscriptFormat, now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `marcsh-${session.id.slice(0, 8)}-${date}.${format}`;
}
