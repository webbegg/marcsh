import { useCallback, useEffect, useMemo } from "react";
import { TextAttributes } from "@opentui/core";
import { format } from "date-fns";
import { useNavigate } from "react-router";
import { useDialog } from "../../providers/dialog";
import { useToast } from "../../providers/toast";
import { getStorage, type SessionSummary } from "../../lib/storage";
import { DialogSearchList } from "../dialog-search-list";

export const SessionsDialogContent = () => {
  const { sessions, loadError } = useMemo(() => {
    try {
      return { sessions: getStorage().listSessions(), loadError: null };
    } catch (err) {
      return { sessions: [], loadError: err instanceof Error ? err.message : String(err) };
    }
  }, []);
  const { close } = useDialog();
  const navigate = useNavigate();
  const toast = useToast();

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

  if (loadError) return null;

  return (
    <DialogSearchList
      items={sessions}
      onSelect={handleSelect}
      filterFn={(s, query) => s.title.toLowerCase().includes(query.toLowerCase())}
      renderItem={(session, isSelected) => (
        <>
          <text selectable={false} fg={isSelected ? "black" : "white"}>
            {session.title}
          </text>
          <box flexGrow={1} />
          <text
            selectable={false}
            fg={isSelected ? "black" : undefined}
            attributes={TextAttributes.DIM}
          >
            {format(session.updatedAt, "hh:mm a")}
          </text>
        </>
      )}
      getKey={(s) => s.id}
      placeholder="Search sessions"
      emptyText="No matching sessions"
    />
  );
};
