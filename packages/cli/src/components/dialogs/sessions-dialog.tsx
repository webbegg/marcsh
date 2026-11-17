import { useCallback, useEffect, useMemo, useRef } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useMatch, useNavigate } from "react-router";
import { useDialog } from "../../providers/dialog";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { useToast } from "../../providers/toast";
import { escapeTranscriptText } from "../../lib/display-text";
import { fitText } from "../../lib/fit-text";
import { formatRelativeTime } from "../../lib/relative-time";
import { printable } from "../../lib/safe-text";
import { getStorage, type SessionListEntry } from "../../lib/storage";
import { DialogSearchList } from "../dialog-search-list";
import { ConfirmDialogContent } from "./confirm-dialog";

type SessionSummary = SessionListEntry;

/** A row's details (S18): `claude · sonnet · 4 messages · 3h ago`, with the time said as `marcsh session list` says it. */
export function sessionMeta(session: SessionListEntry, now: Date): string {
  const model = session.model === null ? "—" : printable(session.model);
  const messages = `${session.messageCount} ${session.messageCount === 1 ? "message" : "messages"}`;
  return [printable(session.engine), model, messages, formatRelativeTime(session.updatedAt, now)].join(" · ");
}

type RowProps = {
  session: SessionSummary;
  isSelected: boolean;
  /** The highlighted row, or none once it is gone (the filter matches nothing): delete acts on this and nothing else. */
  highlighted: { current: SessionSummary | null };
  /** The row's width in cells: the title is cut to leave the details whole. */
  width: number;
  now: Date;
};

export function SessionRow({ session, isSelected, highlighted, width, now }: RowProps) {
  // The list does not say which row is highlighted; the row itself does, and clears it when it unmounts or loses the highlight.
  useEffect(() => {
    if (!isSelected) return;
    highlighted.current = session;
    return () => {
      if (highlighted.current === session) highlighted.current = null;
    };
  }, [isSelected, session, highlighted]);

  const meta = sessionMeta(session, now);
  // Two cells keep the title off the details.
  const title = fitText(printable(session.title), Math.max(1, width - Bun.stringWidth(meta) - 2));
  return (
    <>
      <text selectable={false} wrapMode="none" fg={isSelected ? "black" : "white"}>
        {title}
      </text>
      <box flexGrow={1} />
      <text selectable={false} wrapMode="none" flexShrink={0} fg={isSelected ? "black" : undefined} attributes={TextAttributes.DIM}>
        {meta}
      </text>
    </>
  );
}

/** Enter opens a session; Ctrl+D deletes the highlighted one after a confirmation (and goes home when it is the open one). */
export const SessionsDialogContent = () => {
  const { sessions, loadError } = useMemo(() => {
    try {
      return { sessions: getStorage().listSessions(), loadError: null };
    } catch (err) {
      return { sessions: [], loadError: err instanceof Error ? err.message : String(err) };
    }
  }, []);
  const dialog = useDialog();
  const { close } = dialog;
  const navigate = useNavigate();
  const toast = useToast();
  const { isTopLayer } = useKeyboardLayer();
  const openId = useMatch("/sessions/:id")?.params.id;
  const highlighted = useRef<SessionSummary | null>(null);
  // One "now" for the whole list, so every row's time is said against the same moment.
  const now = useMemo(() => new Date(), []);

  useEffect(() => {
    if (!loadError) return;

    toast.show({ variant: "error", message: `Could not load sessions: ${loadError}` });
    close();
  }, [loadError, toast, close]);

  const handleSelect = useCallback(
    (session: SessionSummary) => {
      close();
      navigate(`/sessions/${session.id}`);
    },
    [close, navigate],
  );

  const askDelete = useCallback(
    (session: SessionSummary) => {
      const backToList = () => dialog.open({ title: "Sessions", children: <SessionsDialogContent /> });
      const remove = () => {
        try {
          if (!getStorage().deleteSession(session.id)) {
            toast.show({ variant: "error", message: "That session no longer exists" });
            return backToList();
          }
        } catch (err) {
          toast.show({ variant: "error", message: `Could not delete the session: ${err instanceof Error ? err.message : String(err)}` });
          return backToList();
        }
        toast.show({ variant: "success", message: `Deleted "${escapeTranscriptText(session.title)}"` });
        if (session.id === openId) navigate("/");
        else backToList();
      };
      dialog.open({
        title: "Delete session",
        children: (
          <ConfirmDialogContent
            lines={[`"${escapeTranscriptText(session.title)}" and its messages will be deleted for good.`]}
            confirmLabel="Delete"
            cancelLabel="Keep it"
            onConfirm={remove}
            onCancel={backToList}
          />
        ),
      });
    },
    [dialog, toast, navigate, openId],
  );

  useKeyboard((key) => {
    if (!isTopLayer("dialog") || !key.ctrl || key.name !== "d") return;
    key.preventDefault();
    if (highlighted.current) askDelete(highlighted.current);
  });

  if (loadError) return null;

  return (
    <DialogSearchList
      items={sessions}
      onSelect={handleSelect}
      filterFn={(s, query) => s.title.toLowerCase().includes(query.toLowerCase())}
      renderItem={(session, isSelected, width) => (
        <SessionRow session={session} isSelected={isSelected} highlighted={highlighted} width={width} now={now} />
      )}
      getKey={(s) => s.id}
      placeholder="Search sessions · ctrl+d deletes"
      emptyText="No matching sessions"
    />
  );
};
