import { useCallback, useEffect, useMemo, useRef } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { format } from "date-fns";
import { useMatch, useNavigate } from "react-router";
import { useDialog } from "../../providers/dialog";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { useToast } from "../../providers/toast";
import { escapeTranscriptText } from "../../lib/display-text";
import { getStorage, type SessionSummary } from "../../lib/storage";
import { DialogSearchList } from "../dialog-search-list";
import { ConfirmDialogContent } from "./confirm-dialog";

type RowProps = {
  session: SessionSummary;
  isSelected: boolean;
  /** The highlighted row, or none once it is gone (the filter matches nothing): delete acts on this and nothing else. */
  highlighted: { current: SessionSummary | null };
};

function SessionRow({ session, isSelected, highlighted }: RowProps) {
  // The list does not say which row is highlighted; the row itself does, and clears it when it unmounts or loses the highlight.
  useEffect(() => {
    if (!isSelected) return;
    highlighted.current = session;
    return () => {
      if (highlighted.current === session) highlighted.current = null;
    };
  }, [isSelected, session, highlighted]);

  return (
    <>
      <text selectable={false} fg={isSelected ? "black" : "white"}>
        {session.title}
      </text>
      <box flexGrow={1} />
      <text selectable={false} fg={isSelected ? "black" : undefined} attributes={TextAttributes.DIM}>
        {format(session.updatedAt, "hh:mm a")}
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
      renderItem={(session, isSelected) => <SessionRow session={session} isSelected={isSelected} highlighted={highlighted} />}
      getKey={(s) => s.id}
      placeholder="Search sessions · ctrl+d deletes"
      emptyText="No matching sessions"
    />
  );
};
