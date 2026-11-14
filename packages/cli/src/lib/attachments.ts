import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, normalize, relative, resolve } from "node:path";
import type { MessageAttachment } from "./chat-types";

/** The most an image or PDF may weigh to be sent as input. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
// A terminal drop is a handful of files; more than this is text that happens to look like paths.
const MAX_PASTED_PATHS = 32;

/** `bytes` are read when the message is sent, only for images and PDFs; what is stored with the message never has them. */
export type Attachment = MessageAttachment & { bytes?: Uint8Array };

/** The file system the attachments are read from; injectable for tests. */
export type AttachmentFs = {
  /** Rejects when the path cannot be read (`code` set, like Node's errors). */
  stat(path: string): Promise<{ size: number; isFile: boolean }>;
  readFile(path: string): Promise<Uint8Array>;
};

const nodeFs: AttachmentFs = {
  stat: async (path) => {
    const info = await stat(path);
    return { size: info.size, isFile: info.isFile() };
  },
  readFile: (path) => readFile(path),
};

// Only the types an engine takes as input are attached as such: Claude takes these four images and PDFs.
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const PDF_MIME = "application/pdf";
const OTHER_MIME: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
};

/** What a file is, from its extension alone. */
function classify(path: string): Pick<MessageAttachment, "mime" | "kind"> {
  const extension = extname(path).toLowerCase();
  if (IMAGE_MIME[extension]) return { mime: IMAGE_MIME[extension]!, kind: "image" };
  if (extension === ".pdf") return { mime: PDF_MIME, kind: "pdf" };
  return { mime: OTHER_MIME[extension] ?? "application/octet-stream", kind: "file" };
}

const readsBytes = (attachment: MessageAttachment) => attachment.kind !== "file";

function decodeFileUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.hostname && url.hostname !== "localhost") return null;
    if (/%2f|%5c/i.test(url.pathname)) return null;
    return decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
}

// A token worth a file system look: a path (absolute, home or dot-relative) or the bare name of an image or PDF. A plain word that
// happens to name a file of the project (`package.json`) is the user's text.
const looksLikePath = (token: string) => token.startsWith("/") || token.startsWith("~/") || token.startsWith("./") || token.startsWith("../") || classify(token).kind !== "file";

/**
 * The paths in pasted text: terminals paste a dropped file as its path, quoted or with `\ ` escapes, or as a `file://` URL, one per
 * file. Null when the text is not made of paths only, so ordinary text never reaches the file system.
 */
export function parsePastedPaths(text: string): string[] | null {
  // `text/uri-list` drops carry comment lines.
  const input = text.includes("file://")
    ? text
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n")
    : text;
  const tokens: string[] = [];
  let current = "";
  let quote = "";
  let started = false;
  const push = () => {
    if (started) tokens.push(current);
    current = "";
    started = false;
  };
  for (let index = 0; index < input.length; index++) {
    const character = input[index]!;
    if (quote) {
      if (character === quote) quote = "";
      else if (character === "\\" && quote === '"' && index + 1 < input.length) current += input[++index];
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (character === "\\" && index + 1 < input.length) {
      current += input[++index];
      started = true;
    } else if (/\s/.test(character)) {
      push();
      if (tokens.length > MAX_PASTED_PATHS) return null;
    } else {
      current += character;
      started = true;
    }
  }
  if (quote) return null;
  push();
  if (tokens.length === 0 || tokens.length > MAX_PASTED_PATHS) return null;

  const paths: string[] = [];
  for (const token of tokens) {
    if (/^https?:\/\//i.test(token)) return null;
    const path = token.startsWith("file://") ? decodeFileUrl(token) : token;
    if (!path || !looksLikePath(path)) return null;
    paths.push(path);
  }
  return paths;
}

const codeOf = (error: unknown) => (error as { code?: string } | null)?.code ?? (error instanceof Error ? error.message : String(error));
const unreadable = (path: string, error: unknown) => `Could not read ${basename(path)}: ${codeOf(error)}.`;
const tooBig = (path: string) => `${basename(path)} is larger than 20 MB`;

export type PasteResolution = { attachments: Attachment[]; problems: string[] };

/**
 * What pasted text attaches: every path in it must be an existing file, else it is ordinary text (null). Paths resolve against `cwd`.
 * An image or PDF over 20 MB, or one that cannot be read, is left out with a reason in `problems`. Nothing is read here: the bytes
 * are read when the message is sent.
 */
export async function resolvePastedAttachments(text: string, cwd: string, fs: AttachmentFs = nodeFs): Promise<PasteResolution | null> {
  const paths = parsePastedPaths(text);
  if (!paths) return null;

  const attachments: Attachment[] = [];
  const problems: string[] = [];
  for (const typed of paths) {
    const path = typed.startsWith("~/") ? resolve(homedir(), typed.slice(2)) : resolve(cwd, typed);
    let info: Awaited<ReturnType<AttachmentFs["stat"]>>;
    try {
      info = await fs.stat(path);
    } catch (error) {
      const code = codeOf(error);
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      problems.push(unreadable(path, error));
      continue;
    }
    if (!info.isFile) return null;
    const kind = classify(path);
    if (kind.kind !== "file" && info.size > MAX_ATTACHMENT_BYTES) {
      problems.push(`${tooBig(path)}, so it was not attached.`);
      continue;
    }
    attachments.push({ path, ...kind });
  }
  return { attachments, problems };
}

/** Reads the bytes of the images and PDFs at send time (the others go as `@path` and are not read). A file that changed since it was attached is reported, not sent. */
export async function loadAttachments(
  attachments: readonly Attachment[],
  fs: AttachmentFs = nodeFs,
): Promise<{ loaded: Attachment[]; failed: { attachment: Attachment; reason: string }[] }> {
  const loaded: Attachment[] = [];
  const failed: { attachment: Attachment; reason: string }[] = [];
  for (const attachment of attachments) {
    if (!readsBytes(attachment)) {
      loaded.push(attachment);
      continue;
    }
    try {
      const info = await fs.stat(attachment.path);
      if (!info.isFile) throw Object.assign(new Error("not a file"), { code: "EISDIR" });
      if (info.size > MAX_ATTACHMENT_BYTES) {
        failed.push({ attachment, reason: `${tooBig(attachment.path)}.` });
        continue;
      }
      loaded.push({ ...attachment, bytes: await fs.readFile(attachment.path) });
    } catch (error) {
      failed.push({ attachment, reason: unreadable(attachment.path, error) });
    }
  }
  return { loaded, failed };
}

/** The `@path` mention of a file (the form the input's `@` menu inserts): relative inside `cwd`, absolute outside it. */
export function mentionFor(path: string, cwd: string): string {
  const inside = relative(cwd, path);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return `@${normalize(path)}`;
  return `@${inside.split("\\").join("/")}`;
}

/** The prompt followed by the files it refers to, as `@path` mentions on a line of their own. */
export function referenceText(prompt: string, references: readonly MessageAttachment[], cwd: string): string {
  if (references.length === 0) return prompt;
  return [prompt, references.map((attachment) => mentionFor(attachment.path, cwd)).join(" ")].filter(Boolean).join("\n");
}

/** How an attachment shows in the input and the chat. */
export const attachmentLabel = (attachment: MessageAttachment) => `[${attachment.kind}: ${basename(attachment.path)}]`;

/**
 * Which attachments an engine takes as input (`inline`) and which go as `@path` mentions (`references`: other files, and whatever the
 * engine cannot take), with what to tell the user about the latter.
 */
export function splitAttachments(
  attachments: readonly Attachment[],
  accepts: { image: boolean; pdf: boolean },
): { inline: Attachment[]; references: Attachment[]; notices: string[] } {
  const inline: Attachment[] = [];
  const references: Attachment[] = [];
  const refused = { image: [] as Attachment[], pdf: [] as Attachment[] };
  for (const attachment of attachments) {
    if (attachment.kind === "image" && accepts.image) inline.push(attachment);
    else if (attachment.kind === "pdf" && accepts.pdf) inline.push(attachment);
    else {
      references.push(attachment);
      if (attachment.kind !== "file") refused[attachment.kind].push(attachment);
    }
  }
  const notices: string[] = [];
  const names = (list: Attachment[]) => list.map((attachment) => basename(attachment.path)).join(", ");
  const goes = (list: Attachment[]) => (list.length === 1 ? "goes as an @path reference" : "go as @path references");
  if (refused.image.length > 0) notices.push(`This model cannot take images as input, so ${names(refused.image)} ${goes(refused.image)}.`);
  if (refused.pdf.length > 0) notices.push(`This engine cannot take PDFs as input, so ${names(refused.pdf)} ${goes(refused.pdf)}.`);
  return { inline, references, notices };
}
