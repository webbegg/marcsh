import { useMemo, useRef } from "react";
import { closeSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { extname, resolve } from "node:path";
import { useNavigate } from "react-router";
import { ConfirmDialogContent } from "../components/dialogs/confirm-dialog";
import { DiffDialogContent } from "../components/dialogs/diff-dialog";
import { PsDialogContent } from "../components/dialogs/ps-dialog";
import { SubagentsDialogContent } from "../components/dialogs/subagents-dialog";
import type { BackgroundHub } from "../lib/background/hub";
import type { SessionCommands } from "../components/command-menu/session-commands";
import { stripControlChars } from "../components/ui-prompts";
import { useDialog } from "../providers/dialog";
import { useToast } from "../providers/toast";
import type { ChatMessage } from "../lib/chat-types";
import { copyToClipboard } from "../lib/clipboard";
import { escapeTranscriptText } from "../lib/display-text";
import {
  applyStep,
  baselineTree,
  describeStep,
  markStep,
  noStepReason,
  parseUnifiedDiff,
  planStep,
  type Direction,
  type StepPlan,
} from "../lib/session-snapshots";
import type { SnapshotStoreResult } from "../lib/snapshot";
import { getStorage, type StoredSession } from "../lib/storage";
import { defaultExportPath, renderTranscript, type TranscriptFormat } from "../lib/transcript";
import type { CompactOutcome } from "./use-chat";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `[md|json] [path]`: the format is optional (markdown), and what is left is the path, if any. */
export function parseExportArgs(args: string): { format: TranscriptFormat; path?: string } {
  const [first = "", ...rest] = args.trim().split(/\s+/);
  const format = first === "md" || first === "json" ? first : undefined;
  const path = (format ? rest : [first, ...rest]).join(" ").replace(/^(["'])(.*)\1$/, "$2").trim();
  return { format: format ?? "md", ...(path ? { path } : {}) };
}

const expandHome = (path: string) => (path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path);

/**
 * Writes `text` to `path`, or to `name-1.ext`, `name-2.ext`, … when the file exists: an export never overwrites. The file is created
 * exclusively, so a name taken between the check and the write is skipped too. Returns the path written.
 */
export function writeNewFile(path: string, text: string): string {
  const ext = extname(path);
  const stem = path.slice(0, path.length - ext.length);
  for (let attempt = 0; ; attempt++) {
    const target = attempt === 0 ? path : `${stem}-${attempt}${ext}`;
    let fd: number;
    try {
      fd = openSync(target, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST" && attempt < 1000) continue;
      throw error;
    }
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
    return target;
  }
}

/** The text parts of the last reply that has any, as paragraphs; undefined when no reply has said anything. */
export function lastReplyText(messages: ChatMessage[]): string | undefined {
  for (const reply of [...messages].reverse()) {
    if (reply.role !== "assistant") continue;
    const text = reply.parts.flatMap((part) => (part.type === "text" && part.text.trim() !== "" ? [part.text] : [])).join("\n\n");
    if (text) return text;
  }
  return undefined;
}

const tokens = (count: number) => (count < 1000 ? String(Math.round(count)) : `${Math.round(count / 100) / 10}k`);

type Params = {
  session: StoredSession;
  /** The chat's side of it (see `useChat`). */
  chat: {
    getMessages: () => ChatMessage[];
    editMessages: (update: (prev: ChatMessage[]) => ChatMessage[]) => string | undefined;
    snapshotIssue: () => string | undefined;
    hasConversation: () => boolean;
    compact: (model: string) => Promise<CompactOutcome>;
    /** A turn is running or starting. */
    busy: boolean;
  };
  snapshots: SnapshotStoreResult;
  /** The model a compaction by the engine uses (pi: one that has credentials now). */
  compactModel: () => Promise<string>;
  /** Claude compacts through a turn of its own: starts one whose prompt is `/compact`. */
  compactWithTurn: () => void;
  /** Adds a line to the conversation as it is shown (not saved with it). */
  addNotice: (text: string) => void;
  /** The session's background hub (pi only), for `/ps` when it is not given one. */
  background?: BackgroundHub;
  now?: () => Date;
};

/** The commands that work on the open session: what `/rename`, `/fork`, `/export`, `/undo`, `/redo`, `/diff`, `/compact`, `/copy`, `/ps` and `/subagents` run. */
export function useSessionCommands(params: Params): SessionCommands {
  const navigate = useNavigate();
  const toast = useToast();
  const dialog = useDialog();
  // The commands read the latest of everything without being rebuilt on each render.
  const latest = useRef(params);
  latest.current = params;
  const ui = useRef({ navigate, toast, dialog });
  ui.current = { navigate, toast, dialog };

  return useMemo<SessionCommands>(() => {
    const current = () => latest.current;
    const info = (text: string) => ui.current.toast.show({ variant: "info", message: text });
    const fail = (text: string) => ui.current.toast.show({ variant: "error", message: text });
    const busyNow = () => {
      if (!current().chat.busy) return false;
      info("Wait for the current turn to finish.");
      return true;
    };

    const rename = (title: string) => {
      const text = stripControlChars(title).replace(/\s+/g, " ").trim();
      if (!text) return info("Usage: /rename <title>");
      try {
        if (!getStorage().renameSession(current().session.id, text)) return fail("Could not rename the session");
      } catch (error) {
        return fail(`Could not rename the session: ${message(error)}`);
      }
      ui.current.toast.show({ variant: "success", message: `Renamed to "${text}"` });
    };

    const fork = () => {
      if (busyNow()) return;
      try {
        const copy = getStorage().forkSession(current().session.id);
        ui.current.navigate(`/sessions/${copy.id}`);
        ui.current.toast.show({ variant: "success", message: "Forked: you are in the copy now" });
      } catch (error) {
        fail(`Could not fork the session: ${message(error)}`);
      }
    };

    const exportTranscript = async (args: string) => {
      const { session, chat, now } = current();
      const { format, path } = parseExportArgs(args);
      try {
        const wanted = resolve(session.cwd, expandHome(path ?? defaultExportPath(session, format, (now ?? (() => new Date()))())));
        const written = writeNewFile(wanted, renderTranscript({ ...session, messages: chat.getMessages() }, format));
        ui.current.toast.show({ variant: "success", message: `Exported to ${written}` });
      } catch (error) {
        fail(`Could not export: ${message(error)}`);
      }
    };

    const step = async (direction: Direction) => {
      if (busyNow()) return;
      const { snapshots, chat } = current();
      const verb = direction === "undo" ? "undo" : "redo";
      const messages = chat.getMessages();
      if (!snapshots.available) return info(noStepReason(direction, { kind: "none", skipped: 0 }, snapshots, messages, undefined));

      let plan;
      try {
        plan = await planStep(snapshots.store, messages, direction);
      } catch (error) {
        return fail(`Could not ${verb}: ${message(error)}`);
      }
      if (plan.kind === "none") return info(noStepReason(direction, plan, snapshots, messages, chat.snapshotIssue()));

      const run = async (ready: StepPlan) => {
        const { chat: latestChat, addNotice } = current();
        try {
          const result = await applyStep(snapshots.store, latestChat.getMessages(), ready);
          const saveFailure = latestChat.editMessages((prev) => markStep(prev, ready));
          addNotice(describeStep(direction, result, ready));
          if (saveFailure) return fail(`The files were put back, but ${saveFailure}`);
          ui.current.toast.show({ variant: "success", message: direction === "undo" ? "Undid the last turn's file changes" : "Redid the file changes" });
        } catch (error) {
          fail(`Could not ${verb}: ${message(error)}`);
        }
      };

      if (plan.modified.length === 0) return run(plan);
      const ready = plan;
      ui.current.dialog.open({
        title: "Overwrite changed files?",
        children: (
          <ConfirmDialogContent
            lines={[
              `These files changed after the turn, and ${direction === "undo" ? "undoing it" : "redoing it"} would overwrite them:`,
              ...ready.modified.slice(0, 12).map((file) => `  ${escapeTranscriptText(file)}`),
              ...(ready.modified.length > 12 ? [`  and ${ready.modified.length - 12} more`] : []),
            ]}
            confirmLabel="Overwrite"
            cancelLabel="Keep my changes"
            onConfirm={() => void run(ready)}
          />
        ),
      });
    };

    const diff = async () => {
      const { snapshots, chat } = current();
      const messages = chat.getMessages();
      if (!snapshots.available) return info(`File diff is unavailable: ${snapshots.reason}.`);
      const first = baselineTree(messages);
      if (!first) {
        const issue = chat.snapshotIssue();
        return info(issue ? `File diff is unavailable: ${issue}.` : "No turn in this session has a file snapshot, so there is nothing to diff.");
      }
      try {
        const files = parseUnifiedDiff(await snapshots.store.diff(first));
        if (files.length === 0) return info("No file changes since this session's first turn.");
        ui.current.dialog.open({ title: `Changes since the first turn · ${files.length} file${files.length === 1 ? "" : "s"}`, children: <DiffDialogContent files={files} /> });
      } catch (error) {
        fail(`Could not read the changes: ${message(error)}`);
      }
    };

    const compact = async () => {
      if (busyNow()) return;
      const { session, chat, compactModel, compactWithTurn } = current();
      if (session.engine === "claude") {
        if (!chat.hasConversation()) return info("Nothing to compact yet: this session has no conversation.");
        return compactWithTurn();
      }
      const outcome = await chat.compact(await compactModel());
      if (!outcome.ok) return fail(`Could not compact: ${outcome.reason}`);
      const sizes = outcome.tokensBefore !== undefined ? ` (${tokens(outcome.tokensBefore)}${outcome.tokensAfter !== undefined ? ` → ${tokens(outcome.tokensAfter)}` : ""} tokens)` : "";
      ui.current.toast.show({ variant: "success", message: `Compacted the context${sizes}` });
    };

    const copy = async () => {
      const text = lastReplyText(current().chat.getMessages());
      if (!text) return info("There is no reply to copy yet.");
      try {
        const { method } = await copyToClipboard(text);
        ui.current.toast.show({
          variant: "success",
          message: method === "pbcopy" ? "Copied the last reply to the clipboard" : "Sent the last reply to your terminal's clipboard (OSC 52; the terminal must allow it)",
        });
      } catch (error) {
        fail(`Could not copy: ${message(error)}`);
      }
    };

    const ps = () => {
      const hub = current().background;
      if (!hub || hub.disposed) return info("Background terminals run in pi sessions only.");
      ui.current.dialog.open({ title: "Background terminals", children: <PsDialogContent hub={hub} /> });
    };

    const subagents = () => {
      const hub = current().background;
      if (!hub || hub.disposed) return info("Background subagents run in pi sessions only.");
      ui.current.dialog.open({ title: "Background subagents", children: <SubagentsDialogContent hub={hub} /> });
    };

    return { rename, fork, exportTranscript, undo: () => step("undo"), redo: () => step("redo"), diff, compact, copy, ps, subagents };
  }, []);
}
