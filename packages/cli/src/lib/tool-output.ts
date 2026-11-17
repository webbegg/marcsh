import { redactSecrets } from "./engine/pi-auth";

/** The most lines of a tool's output a saved message keeps: the last ones. */
export const MAX_OUTPUT_LINES = 200;
/** The most bytes (UTF-8) of a tool's output a saved message keeps: the last ones. */
export const MAX_OUTPUT_BYTES = 16 * 1024;
/** The largest patch a saved message carries. A bigger one is left out (the tool's input still shows what it wrote). */
export const MAX_PATCH_BYTES = 64 * 1024;

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

/** The last `MAX_OUTPUT_BYTES` of one line, starting on a character. */
function tailOfLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  let start = bytes.length - MAX_OUTPUT_BYTES;
  // Bytes 10xxxxxx continue a character: step past them so the first kept byte starts one.
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

/**
 * Keeps the tail of a tool's output: the last `MAX_OUTPUT_LINES` lines or `MAX_OUTPUT_BYTES` bytes, whichever is
 * less. It cuts between lines and never inside a UTF-8 character. The one exception is a single last line that is
 * itself over the byte cap: its tail is kept, from a character boundary. Newlines at the end are dropped.
 */
export function capOutput(text: string): { text: string; truncated: boolean } {
  const lines = text.replace(/(?:\r?\n)+$/, "").split("\n");
  let truncated = false;
  let first = 0;

  if (lines.length > MAX_OUTPUT_LINES) {
    first = lines.length - MAX_OUTPUT_LINES;
    truncated = true;
  }

  let size = byteLength(lines.slice(first).join("\n"));
  while (size > MAX_OUTPUT_BYTES && first < lines.length - 1) {
    size -= byteLength(lines[first]!) + 1;
    first++;
    truncated = true;
  }

  let kept = lines.slice(first).join("\n");
  if (size > MAX_OUTPUT_BYTES) {
    kept = tailOfLine(kept);
    truncated = true;
  }
  return { text: kept, truncated };
}

export type StoredOutput = { output?: string; outputTruncated?: true };

/**
 * What a saved tool part keeps of a successful call's output: redacted first (so a secret in the part that is cut off
 * never matters, and one cut in half cannot slip past), then capped. Output that is empty or blank is not kept.
 * The redaction is `redactSecrets`: a secret it does not recognise is saved.
 */
export function storedOutput(text: string): StoredOutput {
  const redacted = redactSecrets(text);
  if (redacted.trim() === "") return {};

  const { text: output, truncated } = capOutput(redacted);
  return truncated ? { output, outputTruncated: true } : { output };
}

/** A patch as it is saved: left out (undefined) when empty or over `MAX_PATCH_BYTES`. */
export function boundedPatch(patch: string | undefined): string | undefined {
  if (patch === undefined || patch.trim() === "") return undefined;
  return byteLength(patch) > MAX_PATCH_BYTES ? undefined : patch;
}

/**
 * Writes the hunks Claude gives for Edit, MultiEdit and Write (`structuredPatch`: `{ oldStart, oldLines, newStart,
 * newLines, lines }`, lines already marked with ` `, `-` or `+`) as unified diff text with standard `@@ -a,b +c,d @@`
 * headers. There is no `---`/`+++` file header: the tool part knows the file. Undefined when there are no usable hunks.
 */
export function patchFromHunks(hunks: unknown): string | undefined {
  if (!Array.isArray(hunks) || hunks.length === 0) return undefined;

  const out: string[] = [];
  for (const hunk of hunks) {
    const { oldStart, oldLines, newStart, newLines, lines } = (hunk ?? {}) as Record<string, unknown>;
    if (![oldStart, oldLines, newStart, newLines].every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
    if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) return undefined;
    out.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`, ...(lines as string[]));
  }
  return boundedPatch(out.join("\n"));
}
