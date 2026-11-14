import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, TurnSnapshot } from "./chat-types";
import { createSnapshotStore, defaultSnapshotRoot, type SnapshotStore, type SnapshotStoreResult } from "./snapshot";

/**
 * What `/undo`, `/redo` and `/diff` need around the project snapshots (see `snapshot.ts`): taking one without ever blocking a turn,
 * keeping the pair of trees a turn produced on its last reply, and walking those pairs back and forth. Everything takes the store
 * as an argument, so none of it touches a real project unless it is given one.
 */

/** A snapshot of a big project can take a while; the turn goes on without one rather than wait longer than this. */
export const SNAPSHOT_TIMEOUT_MS = 10_000;

/** Where the shadow repos live: `MARCSH_SNAPSHOTS_DIR`, else `~/.marcsh/snapshots`. */
export const snapshotRoot = (): string => process.env.MARCSH_SNAPSHOTS_DIR?.trim() || defaultSnapshotRoot();

/** The environment variables that move one of marcsh's own files or folders away from `~/.marcsh`. */
const DATA_ENV = ["MARCSH_DB_PATH", "MARCSH_PREFERENCES_PATH", "MARCSH_KEYBINDS_PATH", "MARCSH_HISTORY_PATH", "MARCSH_AGENT_DIR", "MARCSH_AGENTS_DIR", "MARCSH_PACKS_DIR"];

/**
 * marcsh's own data: `~/.marcsh`, and each file or folder that an environment variable moved elsewhere (with the database's `-wal`,
 * `-shm` and `-journal` files). A project folder that contains any of it must not snapshot or restore it.
 */
export function marcshDataPaths(): string[] {
  const moved = DATA_ENV.flatMap((name) => process.env[name]?.trim() || []);
  const database = process.env.MARCSH_DB_PATH?.trim();
  return [join(homedir(), ".marcsh"), ...moved, ...(database ? ["-wal", "-shm", "-journal"].map((suffix) => database + suffix) : [])];
}

/**
 * The snapshot store of the project at `cwd`, or why there is none (no git, a folder that cannot be read, the home folder or `/`, `MARCSH_SNAPSHOTS=off`).
 * Tests run with `MARCSH_SNAPSHOTS=off` and a temp `MARCSH_SNAPSHOTS_DIR` (test-preload.ts).
 */
export function openSnapshots(cwd: string): SnapshotStoreResult {
  if (process.env.MARCSH_SNAPSHOTS?.trim().toLowerCase() === "off") return { available: false, reason: "turned off by MARCSH_SNAPSHOTS=off" };
  return createSnapshotStore({ cwd, root: snapshotRoot(), exclude: marcshDataPaths() });
}

/**
 * A snapshot of the project now: its tree, or the reason there is none (`timedOut` when it was given up on: the git process is killed,
 * so it stops copying files, and the next snapshot would be as slow). Never throws, and never waits longer than `timeoutMs`.
 */
export async function trackWithin(store: SnapshotStore, timeoutMs = SNAPSHOT_TIMEOUT_MS): Promise<{ tree: string } | { reason: string; timedOut?: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = new AbortController();
  const timeout = new Promise<{ reason: string; timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      cancel.abort();
      resolve({ reason: `the snapshot took longer than ${Math.round(timeoutMs / 1000)} s`, timedOut: true });
    }, timeoutMs);
  });
  try {
    const tracked = store.track(cancel.signal).then((tree) => ({ tree }), (error: unknown) => ({ reason: error instanceof Error ? error.message : String(error) }));
    return await Promise.race([tracked, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const snapshotOf = (message: ChatMessage): TurnSnapshot | undefined => (message.role === "assistant" ? message.metadata?.snapshot : undefined);

const replaceSnapshot = (messages: ChatMessage[], id: string, change: (snapshot: TurnSnapshot) => TurnSnapshot): ChatMessage[] =>
  messages.map((message) => {
    const snapshot = message.id === id ? snapshotOf(message) : undefined;
    return snapshot ? { ...message, metadata: { ...message.metadata, snapshot: change(snapshot) } } : message;
  });

/** The messages with `snapshot` set on the reply `replyId`. */
export const withSnapshot = (messages: ChatMessage[], replyId: string, snapshot: TurnSnapshot): ChatMessage[] =>
  messages.map((message) => (message.id === replyId ? { ...message, metadata: { ...message.metadata, snapshot } } : message));

/** A new turn ends every redo: the replies still undone stay undone for good. The same array when there is nothing to drop. */
export function dropRedo(messages: ChatMessage[]): ChatMessage[] {
  const pending = (message: ChatMessage) => snapshotOf(message)?.undone === true && snapshotOf(message)?.abandoned !== true;
  if (!messages.some(pending)) return messages;
  return messages.map((message) => (pending(message) ? { ...message, metadata: { ...message.metadata, snapshot: { ...snapshotOf(message)!, abandoned: true } } } : message));
}

/** The project as it was before the session's first snapshotted turn, whatever happened to that turn since. */
export const baselineTree = (messages: ChatMessage[]): string | undefined => messages.map(snapshotOf).find((s) => s !== undefined)?.before;

export type Direction = "undo" | "redo";

/** The turn a step would act on: `files` are what that turn changed, `modified` the ones that changed again since, which the step would overwrite. */
export type StepPlan = {
  kind: "ready";
  direction: Direction;
  messageId: string;
  files: string[];
  modified: string[];
  /** The tree the files are written from: the turn's `before` for an undo, its `after` for a redo. */
  target: string;
  /** Newer turns passed over because they changed no files. */
  skipped: number;
};

export type NoStep = { kind: "none"; skipped: number };

/**
 * The turn `/undo` (the newest reply with a snapshot that is not undone) or `/redo` (the oldest reply that is undone and not abandoned:
 * undo works backwards, so that is the one undone last) would act on. A turn that changed no files is passed over for the next one.
 * Writes nothing.
 */
export async function planStep(store: SnapshotStore, messages: ChatMessage[], direction: Direction): Promise<StepPlan | NoStep> {
  const turns = messages.flatMap((message) => {
    const snapshot = snapshotOf(message);
    return snapshot ? [{ id: message.id, snapshot }] : [];
  });
  const candidates =
    direction === "undo"
      ? turns.filter((turn) => !turn.snapshot.undone).reverse()
      : turns.filter((turn) => turn.snapshot.undone && !turn.snapshot.abandoned);

  let skipped = 0;
  for (const { id, snapshot } of candidates) {
    const files = await store.changedFiles(snapshot.before, snapshot.after);
    if (files.length === 0) {
      skipped += 1;
      continue;
    }
    // What the files should look like now, were nobody to have touched them since.
    const expected = direction === "undo" ? snapshot.after : snapshot.before;
    return {
      kind: "ready",
      direction,
      messageId: id,
      files,
      modified: await store.modifiedSince(expected, files),
      target: direction === "undo" ? snapshot.before : snapshot.after,
      skipped,
    };
  }
  return { kind: "none", skipped };
}

/** The messages with the plan's reply marked undone (an undo) or not (a redo). */
export const markStep = (messages: ChatMessage[], plan: Pick<StepPlan, "direction" | "messageId">): ChatMessage[] =>
  replaceSnapshot(messages, plan.messageId, ({ undone: _, ...rest }) => (plan.direction === "undo" ? { ...rest, undone: true } : rest));

/**
 * Writes the plan's files and marks the reply. Throws when the store refuses or fails, and then the reply is not marked,
 * so the caller never reports a half-done step as done.
 */
export async function applyStep(
  store: SnapshotStore,
  messages: ChatMessage[],
  plan: StepPlan,
): Promise<{ messages: ChatMessage[]; written: string[]; deleted: string[] }> {
  const { written, deleted } = await store.restore(plan.target, plan.files);
  return { messages: markStep(messages, plan), written, deleted };
}

const SHOWN_FILES = 8;
const listFiles = (files: string[]) => (files.length <= SHOWN_FILES ? files.join(", ") : `${files.slice(0, SHOWN_FILES).join(", ")} and ${files.length - SHOWN_FILES} more`);

/** The notice line that names what a step wrote and deleted. */
export function describeStep(direction: Direction, result: { written: string[]; deleted: string[] }, plan: Pick<StepPlan, "skipped">): string {
  const parts = [result.written.length > 0 ? `restored ${listFiles(result.written)}` : "", result.deleted.length > 0 ? `deleted ${listFiles(result.deleted)}` : ""].filter(Boolean);
  const passed = plan.skipped > 0 ? ` (${plan.skipped} later turn${plan.skipped === 1 ? "" : "s"} changed no files)` : "";
  const what = direction === "undo" ? "Undid the last turn's file changes" : "Redid the file changes";
  return `${what}: ${parts.join("; ") || "no files needed writing"}${passed}. The conversation is unchanged.`;
}

/** Why a step has nothing to act on, for the toast. */
export function noStepReason(
  direction: Direction,
  none: NoStep,
  availability: { available: true } | { available: false; reason: string },
  messages: ChatMessage[],
  lastIssue: string | undefined,
): string {
  if (direction === "redo") return "Nothing to redo.";
  if (!availability.available) return `File undo is unavailable: ${availability.reason}.`;
  const turns = messages.map(snapshotOf).filter((snapshot) => snapshot !== undefined);
  if (turns.length === 0) {
    return lastIssue ? `File undo is unavailable: ${lastIssue}.` : "No turn in this session has a file snapshot, so there is nothing to undo.";
  }
  if (none.skipped > 0) return "Nothing to undo: no turn changed any files.";
  return turns.some((snapshot) => snapshot.undone && !snapshot.abandoned) ? "Nothing left to undo. /redo puts the files back." : "Nothing to undo.";
}

export type DiffLineKind = "hunk" | "add" | "remove" | "context" | "note";
export type DiffLine = { kind: DiffLineKind; text: string };
export type DiffFile = { path: string; status: "added" | "deleted" | "modified"; additions: number; deletions: number; lines: DiffLine[] };

/** A unified diff (git's) split into files, each with its changed lines classified; the `index`, `---` and `+++` lines are dropped. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let inHunk = false;

  for (const line of text.split("\n")) {
    const header = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (header) {
      current = { path: header[1]!, status: "modified", additions: 0, deletions: 0, lines: [] };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (!current || line === "") continue;

    if (!inHunk) {
      if (line.startsWith("new file mode")) current.status = "added";
      else if (line.startsWith("deleted file mode")) current.status = "deleted";
      else if (line.startsWith("@@")) {
        inHunk = true;
        current.lines.push({ kind: "hunk", text: line });
      } else if (line.startsWith("Binary files")) current.lines.push({ kind: "note", text: line });
      continue;
    }

    if (line.startsWith("@@")) current.lines.push({ kind: "hunk", text: line });
    else if (line.startsWith("+")) {
      current.additions += 1;
      current.lines.push({ kind: "add", text: line });
    } else if (line.startsWith("-")) {
      current.deletions += 1;
      current.lines.push({ kind: "remove", text: line });
    } else if (line.startsWith("\\")) current.lines.push({ kind: "note", text: line });
    else current.lines.push({ kind: "context", text: line });
  }
  return files;
}
