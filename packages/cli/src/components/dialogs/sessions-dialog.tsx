import { useCallback, useMemo } from "react";
import { TextAttributes } from "@opentui/core";
import { format } from "date-fns";
import { useNavigate } from "react-router";
import { useDialog } from "../../providers/dialog";
import { getStorage, type SessionSummary } from "../../lib/storage";
import { DialogSearchList } from "../dialog-search-list";

export const SessionsDialogContent = () => {
  const sessions = useMemo(() => getStorage().listSessions(), []);
  const { close } = useDialog();
  const navigate = useNavigate();

  const handleSelect = useCallback(
    (session: SessionSummary) => {
      close();
      navigate(`/sessions/${session.id}`);
    },
    [close, navigate],
  );

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
