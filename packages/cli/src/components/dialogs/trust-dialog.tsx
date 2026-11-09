import { useCallback, useMemo, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useDialog } from "../../providers/dialog";
import { useToast } from "../../providers/toast";
import { DialogSearchList } from "../dialog-search-list";
import { TrustPrompt } from "../trust-prompt";
import { stripControlChars } from "../ui-prompts";
import { canonical, findProjectResources, unreadableResources, type TrustAnswer } from "../../lib/engine/pi-trust";
import { getStorage, type ProjectTrust, type Storage } from "../../lib/storage";
import type { TrustRequest } from "../../hooks/use-chat";

type Choice = { id: ProjectTrust | "forget"; label: string; hint: string };

// Trust is not the first row: the row that is selected when the dialog opens must never be the one that lets code run.
const CHOICES: Choice[] = [
  { id: "untrusted", label: "Don't trust", hint: "pi ignores this project's files" },
  { id: "trusted", label: "Trust", hint: "pi loads this project's files" },
  { id: "forget", label: "Forget", hint: "ask again at the next pi turn" },
];

const DECISION_TEXT = { trusted: "trusted", untrusted: "not trusted" } as const;

type Props = {
  /** The project folder. */
  cwd: string;
  /** Where decisions are kept; default: marcsh's SQLite. */
  store?: Pick<Storage, "getProjectTrust" | "setProjectTrust">;
};

/**
 * `/trust`: shows this project's decision about its own pi files and changes or forgets it. It takes effect from the next turn.
 * Don't trust and Forget are one step. Trust is not: it opens the same full-screen listing as the turn's trust prompt
 * (everything pi would load, read to the end, then `t` and Enter) and stores nothing until that prompt says trust.
 * While marcsh cannot read an entry of the project, Trust is not offered at all (it could not show what trusting runs),
 * and a stored "trusted" is shown as not in effect.
 */
export const TrustDialogContent = ({ cwd, store }: Props) => {
  const dialog = useDialog();
  const toast = useToast();
  const records = store ?? getStorage();
  const [review, setReview] = useState<TrustRequest | null>(null);

  const current = useMemo(() => {
    try {
      return records.getProjectTrust(cwd);
    } catch {
      return null;
    }
  }, [records, cwd]);
  const listed = useMemo(() => findProjectResources(cwd), [cwd]);
  const found = listed.length;
  const unreadable = useMemo(() => unreadableResources(listed), [listed]);
  // With no pi files there is nothing to trust, and with an unreadable one there is nothing marcsh can show to trust.
  const choices = useMemo(() => (found > 0 && unreadable.length === 0 ? CHOICES : CHOICES.filter((choice) => choice.id !== "trusted")), [found, unreadable]);
  // A stored "trusted" does not hold while an entry cannot be read (the file may have grown since).
  const effective = current === "trusted" && unreadable.length > 0 ? null : current;

  const save = useCallback(
    (decision: ProjectTrust | null) => {
      try {
        records.setProjectTrust(cwd, decision);
      } catch (error) {
        toast.show({ variant: "error", message: `Could not save the decision: ${error instanceof Error ? error.message : String(error)}` });
        dialog.close();
        return;
      }
      const message = decision
        ? `This project is now ${DECISION_TEXT[decision]} for pi from the next turn`
        : "Forgot the decision; pi will ask again at the next turn that needs it";
      toast.show({ variant: "success", message });
      dialog.close();
    },
    [records, cwd, dialog, toast],
  );

  const handleSelect = useCallback(
    (choice: Choice) => {
      if (choice.id === "forget") return save(null);
      if (choice.id === "untrusted") return save("untrusted");

      // Listed afresh: the folder may have changed since the dialog opened.
      const resources = findProjectResources(cwd);
      if (resources.length === 0) {
        toast.show({ variant: "info", message: "This project has no pi files: nothing to trust" });
        dialog.close();
        return;
      }
      if (unreadableResources(resources).length > 0) {
        toast.show({ variant: "error", message: "marcsh could not read some of this project's pi files, so it cannot show what trusting would run" });
        dialog.close();
        return;
      }
      const respond = (answer: TrustAnswer) => {
        if (answer === "trust") save("trusted");
        else if (answer === "distrust") save("untrusted");
        else dialog.close();
      };
      setReview({ kind: "trust", id: crypto.randomUUID(), cwd: canonical(cwd), resources, respond });
    },
    [cwd, save, dialog, toast],
  );

  if (review) return <TrustPrompt request={review} layer="dialog" />;

  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="column">
        <text wrapMode="char">{stripControlChars(cwd)}</text>
        <text attributes={TextAttributes.DIM}>
          {effective ? `Now: ${DECISION_TEXT[effective]}` : current ? "Now: not trusted (the stored decision no longer applies)" : "Now: not decided yet"}
          {found > 0 ? ` · ${found} pi file${found === 1 ? "" : "s"} found` : " · no pi files found, nothing to trust"}
        </text>
        {unreadable.length > 0 ? (
          <>
            <text attributes={TextAttributes.DIM}>Trust is not offered: marcsh cannot show what trusting would run, because it could not read:</text>
            {unreadable.map((resource, i) => (
              <text key={i} attributes={TextAttributes.DIM} wrapMode="char">
                {`  ${resource.path} — ${resource.detail}`}
              </text>
            ))}
          </>
        ) : null}
      </box>
      <DialogSearchList
        items={choices}
        onSelect={handleSelect}
        filterFn={(choice, query) => `${choice.label} ${choice.hint}`.toLowerCase().includes(query.toLowerCase())}
        renderItem={(choice, isSelected) => (
          <box flexDirection="row" gap={1} overflow="hidden">
            <text selectable={false} fg={isSelected ? "black" : "white"}>
              {choice.id === effective || (choice.id === "forget" && current === null) ? " • " : "   "}
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
