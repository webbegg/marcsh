import { useCallback, useMemo } from "react";
import { TextAttributes } from "@opentui/core";
import { useDialog } from "../../providers/dialog";
import { useToast } from "../../providers/toast";
import { DialogSearchList } from "../dialog-search-list";
import { stripControlChars } from "../ui-prompts";
import { findProjectResources } from "../../lib/engine/pi-trust";
import { getStorage, type ProjectTrust, type Storage } from "../../lib/storage";

type Choice = { id: ProjectTrust | "forget"; label: string; hint: string };

const CHOICES: Choice[] = [
  { id: "trusted", label: "Trust", hint: "pi loads this project's files" },
  { id: "untrusted", label: "Don't trust", hint: "pi ignores this project's files" },
  { id: "forget", label: "Forget", hint: "ask again at the next pi turn" },
];

const DECISION_TEXT = { trusted: "trusted", untrusted: "not trusted" } as const;

type Props = {
  /** The project folder. */
  cwd: string;
  /** Where decisions are kept; default: marcsh's SQLite. */
  store?: Pick<Storage, "getProjectTrust" | "setProjectTrust">;
};

/** `/trust`: shows this project's decision about its own pi files and changes or forgets it. It takes effect from the next turn. */
export const TrustDialogContent = ({ cwd, store }: Props) => {
  const dialog = useDialog();
  const toast = useToast();
  const records = store ?? getStorage();

  const current = useMemo(() => {
    try {
      return records.getProjectTrust(cwd);
    } catch {
      return null;
    }
  }, [records, cwd]);
  const found = useMemo(() => findProjectResources(cwd).length, [cwd]);

  const handleSelect = useCallback(
    (choice: Choice) => {
      try {
        records.setProjectTrust(cwd, choice.id === "forget" ? null : choice.id);
      } catch (error) {
        toast.show({ variant: "error", message: `Could not save the decision: ${error instanceof Error ? error.message : String(error)}` });
        dialog.close();
        return;
      }
      const message =
        choice.id === "forget"
          ? "Forgot the decision; pi will ask again at the next turn that needs it"
          : `This project is now ${DECISION_TEXT[choice.id]} for pi from the next turn`;
      toast.show({ variant: "success", message });
      dialog.close();
    },
    [records, cwd, dialog, toast],
  );

  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="column">
        <text wrapMode="char">{stripControlChars(cwd)}</text>
        <text attributes={TextAttributes.DIM}>
          {current ? `Now: ${DECISION_TEXT[current]}` : "Now: not decided yet"}
          {found > 0 ? ` · ${found} pi file${found === 1 ? "" : "s"} found` : " · no pi files found"}
        </text>
      </box>
      <DialogSearchList
        items={CHOICES}
        onSelect={handleSelect}
        filterFn={(choice, query) => `${choice.label} ${choice.hint}`.toLowerCase().includes(query.toLowerCase())}
        renderItem={(choice, isSelected) => (
          <box flexDirection="row" gap={1} overflow="hidden">
            <text selectable={false} fg={isSelected ? "black" : "white"}>
              {choice.id === current || (choice.id === "forget" && current === null) ? " • " : "   "}
              {choice.label}
            </text>
            <text selectable={false} fg={isSelected ? "black" : "gray"} attributes={TextAttributes.DIM}>
              {choice.hint}
            </text>
          </box>
        )}
        getKey={(choice) => choice.id}
        placeholder="Search"
        emptyText="No matching choices"
      />
    </box>
  );
};
