import { useCallback } from "react";
import { TextAttributes } from "@opentui/core";
import { useDialog } from "../../providers/dialog";
import { useToast } from "../../providers/toast";
import { DialogSearchList } from "../dialog-search-list";
import { removeLogin, type AuthRuntime, type StoredLogin } from "../../lib/engine/pi-auth";

type Props = {
  runtime: AuthRuntime;
  logins: StoredLogin[];
  /** Called after a login was removed, so the caller can check which pi model to use now. */
  onLoggedOut?: () => void;
};

export const LogoutDialogContent = ({ runtime, logins, onLoggedOut }: Props) => {
  const dialog = useDialog();
  const toast = useToast();

  const handleSelect = useCallback(
    (login: StoredLogin) => {
      dialog.close();
      void removeLogin(runtime, login).then((outcome) => {
        toast.show({ variant: outcome.status === "success" ? "success" : "error", message: outcome.message });
        if (outcome.status === "success") onLoggedOut?.();
      });
    },
    [dialog, toast, runtime, onLoggedOut],
  );

  return (
    <DialogSearchList
      items={logins}
      onSelect={handleSelect}
      filterFn={(login, query) => `${login.name} ${login.id}`.toLowerCase().includes(query.toLowerCase())}
      renderItem={(login, isSelected) => (
        <box flexDirection="row" gap={1} overflow="hidden">
          <text selectable={false} fg={isSelected ? "black" : "white"}>
            {"   "}
            {login.name}
          </text>
          <text selectable={false} fg={isSelected ? "black" : "gray"} attributes={TextAttributes.DIM}>
            {login.authType === "oauth" ? "subscription" : "API key"}
          </text>
        </box>
      )}
      getKey={(login) => login.id}
      placeholder="Search logins"
      emptyText="No matching logins"
    />
  );
};
