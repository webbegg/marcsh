import { useCallback, useMemo, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useDialog } from "../../providers/dialog";
import { useToast } from "../../providers/toast";
import { DialogSearchList } from "../dialog-search-list";
import { TrustPrompt } from "../trust-prompt";
import type { TrustRequest } from "../../hooks/use-chat";
import { stripControlChars } from "../ui-prompts";
import { canonical, diffReview, reviewProject, sameReview, unreadableResources, type ProjectResource, type ProjectTrustRecords, type TrustAnswer } from "../../lib/engine/pi-trust";
import { PROJECT_COMMANDS_DIR } from "../../lib/command-files";
import { getStorage, type ProjectTrust, type StoredReview } from "../../lib/storage";

type Choice = { id: ProjectTrust | "forget"; label: string; hint: string };

// Trust is not the first row: the row that is selected when the dialog opens must never be the one that lets code run.
const CHOICES: Choice[] = [
  { id: "untrusted", label: "Don't trust", hint: "don't use its pi files, commands or git status" },
  { id: "trusted", label: "Trust", hint: "use its pi files, commands and git status" },
  { id: "forget", label: "Forget", hint: "ask again at the next pi turn" },
];

const DECISION_TEXT = { trusted: "trusted", untrusted: "not trusted" } as const;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const isCommand = (resource: ProjectResource) => resource.path.startsWith(`${PROJECT_COMMANDS_DIR}/`);

/** What the review lists, counted: pi files and project commands. */
function foundText(resources: ProjectResource[]): string {
  const commands = resources.filter(isCommand).length;
  const piFiles = resources.length - commands;
  if (resources.length === 0) return "no pi files or project commands found";
  return [piFiles > 0 ? `${plural(piFiles, "pi file")} found` : "", commands > 0 ? `${plural(commands, "project command")} found` : ""].filter(Boolean).join(" · ");
}

type Props = {
  /** The project folder. */
  cwd: string;
  /** Where decisions are kept; default: marcsh's SQLite. */
  store?: ProjectTrustRecords;
};

/**
 * `/trust`: shows this project's decision (about its pi files, its commands and its git status) and changes or forgets it, for any
 * project. pi follows it from the next turn. Don't trust and Forget are one step. Trust is one step only when the review lists
 * nothing (no pi files, no project commands): it stores "trusted" with the empty review. Otherwise it opens the same full-screen
 * listing as the turn's trust prompt (everything trusting would load, read to the end, then `t` and Enter) and stores nothing until
 * that prompt says trust. Right before saving the project is reviewed again: if it differs from what was shown (files appeared),
 * the new listing is shown instead and nothing is saved.
 * While marcsh cannot read an entry of the project, Trust is not offered at all (it could not show what trusting runs),
 * and a stored "trusted" is shown as not in effect. So is a stored "trusted" whose files changed since it was reviewed
 * (or that has no review): the dialog says so, and trusting from it lists what changed and stores the new review.
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
  const reviewed = useMemo<StoredReview | null>(() => {
    try {
      return records.getProjectReview?.(cwd) ?? null;
    } catch {
      return null;
    }
  }, [records, cwd]);
  const project = useMemo(() => reviewProject(cwd), [cwd]);
  const unreadable = useMemo(() => unreadableResources(project.resources), [project]);
  // With an unreadable entry there is nothing marcsh can show to trust.
  const choices = useMemo(() => (unreadable.length === 0 ? CHOICES : CHOICES.filter((choice) => choice.id !== "trusted")), [unreadable]);
  // A stored "trusted" holds only as `projectTrustHolds` says: not while an entry cannot be read (the file may have grown since),
  // nor once the files differ from what was reviewed (the empty review included), nor without a review.
  const trustHolds = current === "trusted" && unreadable.length === 0 && reviewed !== null && sameReview(reviewed, project.record);
  const effective = current === "trusted" && !trustHolds ? null : current;
  const staleReason =
    unreadable.length > 0
      ? "the stored decision no longer applies"
      : reviewed
        ? "this project's files changed since you trusted them"
        : "the stored trust predates reviews: trust again to review the files";

  const save = useCallback(
    (decision: ProjectTrust | null, reviewedNow?: StoredReview) => {
      try {
        records.setProjectTrust(cwd, decision, reviewedNow);
      } catch (error) {
        toast.show({ variant: "error", message: `Could not save the decision: ${error instanceof Error ? error.message : String(error)}` });
        dialog.close();
        return;
      }
      const message = decision
        ? `This project is now ${DECISION_TEXT[decision]} (pi: from the next turn)`
        : "Forgot the decision; pi will ask again at the next turn that needs it";
      toast.show({ variant: "success", message });
      dialog.close();
    },
    [records, cwd, dialog, toast],
  );

  // Trust, from what the project holds now (listed afresh: the folder may have changed since the dialog opened or the list was shown).
  const offerTrust = useCallback(() => {
    const { resources, record } = reviewProject(cwd);
    if (unreadableResources(resources).length > 0) {
      toast.show({ variant: "error", message: "marcsh could not read some of this project's pi files, so it cannot show what trusting would run" });
      dialog.close();
      return;
    }
    // Nothing to list: trusting runs nothing now, and anything that appears later makes this trust stale.
    if (resources.length === 0) return save("trusted", record);
    const respond = (answer: TrustAnswer) => {
      if (answer === "trust") {
        // What was shown is what gets stored: if the files moved on while the list was open, nothing is saved and the new list is shown.
        if (!sameReview(reviewProject(cwd).record, record)) {
          toast.show({ variant: "error", message: "This project's files changed while you were reviewing them, so nothing was saved: review the new list" });
          offerTrust();
          return;
        }
        save("trusted", record);
      } else if (answer === "distrust") save("untrusted");
      else dialog.close();
    };
    const changes = current === "trusted" ? diffReview(reviewed, record) : undefined;
    setReview({ kind: "trust", id: crypto.randomUUID(), cwd: canonical(cwd), resources, ...(changes ? { changes } : {}), respond });
  }, [cwd, save, dialog, toast, current, reviewed]);

  const handleSelect = useCallback(
    (choice: Choice) => {
      if (choice.id === "forget") return save(null);
      if (choice.id === "untrusted") return save("untrusted");
      offerTrust();
    },
    [save, offerTrust],
  );

  // Keyed by the request: a new list is read from the top again, with a fresh quiet window and nothing armed.
  if (review) return <TrustPrompt key={review.id} request={review} layer="dialog" />;

  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="column">
        <text wrapMode="char">{stripControlChars(cwd)}</text>
        <text attributes={TextAttributes.DIM}>
          {effective ? `Now: ${DECISION_TEXT[effective]}` : current ? `Now: not trusted (${staleReason})` : "Now: not decided yet"}
          {` · ${foundText(project.resources)}`}
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
            <text selectable={false} flexShrink={0} fg={isSelected ? "black" : "white"}>
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
