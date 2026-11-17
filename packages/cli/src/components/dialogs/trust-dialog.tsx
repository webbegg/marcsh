import { useCallback, useMemo, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useDialog } from "../../providers/dialog";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { useToast } from "../../providers/toast";
import { DialogSearchList } from "../dialog-search-list";
import { TrustPrompt } from "../trust-prompt";
import type { TrustRequest } from "../../hooks/use-chat";
import { stripControlChars } from "../ui-prompts";
import {
  canonical,
  diffReview,
  kindOf,
  partOf,
  partState,
  reviewProject,
  sameReview,
  unreadablePiFiles,
  unreadableResources,
  type ProjectResource,
  type ProjectReview,
  type ProjectTrustRecords,
  type TrustAnswer,
  type TrustPart,
} from "../../lib/engine/pi-trust";
import { getStorage, type ProjectTrust, type StoredReview } from "../../lib/storage";

type Choice = { id: ProjectTrust | "forget"; label: string; hint: string };

// Trust is not the first row: the row that is selected when the dialog opens must never be the one that lets code run.
const CHOICES: Choice[] = [
  { id: "untrusted", label: "Don't trust", hint: "don't use its pi files, commands or git status" },
  { id: "trusted", label: "Trust", hint: "use its pi files, commands and git status" },
  { id: "forget", label: "Forget", hint: "back to undecided" },
];

const DECISION_TEXT = { trusted: "trusted", untrusted: "not trusted" } as const;
const PARTS: readonly TrustPart[] = ["pi", "command", "git"];
const PART_NAME: Record<TrustPart, string> = { pi: "pi files", command: "project commands", git: "git settings" };

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const ofKind = (resources: ProjectResource[], part: TrustPart) => resources.filter((resource) => kindOf(resource) === part);

/** What the review lists, counted by part: pi files, project commands, git settings. */
function foundText(resources: ProjectResource[]): string {
  if (resources.length === 0) return "no pi files, project commands or git settings found";
  const pi = ofKind(resources, "pi").length;
  const commands = ofKind(resources, "command").length;
  const git = ofKind(resources, "git").length;
  return [pi > 0 ? `${plural(pi, "pi file")} found` : "", commands > 0 ? `${plural(commands, "project command")} found` : "", git > 0 ? "git settings found" : ""]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The "Now:" line. A stored "trusted" is in effect per part (see `partState`): each part the project has (or had when it was
 * reviewed) that does not hold is named with why: not reviewed yet (a review from before marcsh reviewed commands and git
 * settings), could not be read, or changed since.
 */
function nowText(current: ProjectTrust | null, reviewed: StoredReview | null, project: ProjectReview): string {
  if (current === null) return "Now: not decided yet";
  if (current === "untrusted") return "Now: not trusted";
  if (unreadablePiFiles(project.resources).length > 0) return "Now: not trusted (the stored decision no longer applies)";
  if (!reviewed) return "Now: not trusted (the stored trust predates reviews: trust again to review the files)";
  const matters = PARTS.filter((part) => ofKind(project.resources, part).length > 0 || partOf(reviewed, part).length > 0);
  const reasons = new Map<string, TrustPart[]>();
  for (const part of matters) {
    const state = partState(current, reviewed, project, part);
    if (state === "holds") continue;
    const reason =
      state === "unreviewed" ? "not reviewed yet" : ofKind(project.resources, part).some((resource) => resource.unreadable) ? "could not be read" : "changed since you trusted them";
    reasons.set(reason, [...(reasons.get(reason) ?? []), part]);
  }
  const off = [...reasons.values()].flat();
  if (off.length === 0) return "Now: trusted";
  if (off.length === matters.length && reasons.size === 1 && reasons.has("changed since you trusted them")) {
    return "Now: not trusted (this project's files changed since you trusted them)";
  }
  const named = [...reasons].map(([reason, parts]) => `${parts.map((part) => PART_NAME[part]).join(" and ")} (${reason})`).join(", ");
  return off.length === matters.length ? `Now: not trusted: ${named}` : `Now: trusted, but not for ${named}`;
}

type Props = {
  /** The project folder. */
  cwd: string;
  /** Where decisions are kept; default: marcsh's SQLite. */
  store?: ProjectTrustRecords;
};

/**
 * `/trust`: shows this project's decision (about its pi files, its commands and its git settings) and changes or forgets it, for any
 * project. pi follows it from the next turn. Don't trust and Forget are one step. Trust opens the same full-screen listing as the
 * turn's trust prompt (everything trusting would load, read to the end, then `t` and Enter) and stores nothing until that prompt
 * says trust. A project with nothing to list (no pi files, project commands or git settings) shows what trusting turns on instead,
 * and stores "trusted" with the empty review only after `t` and Enter. Right before saving the project is reviewed again: if it
 * differs from what was shown (files appeared or vanished), the new listing is shown instead and nothing is saved.
 * While marcsh cannot read a pi file of the project, Trust is not offered at all (it could not show what trusting runs), and a
 * stored "trusted" is shown as not in effect. A command or git settings file it cannot read stays off whatever the decision. A stored
 * "trusted" is in effect per part: the dialog names each part that changed since it was reviewed (or was not reviewed yet), and
 * trusting from it lists what changed and stores the new review.
 */
export const TrustDialogContent = ({ cwd, store }: Props) => {
  const dialog = useDialog();
  const toast = useToast();
  const records = store ?? getStorage();
  const [review, setReview] = useState<TrustRequest | null>(null);
  // The empty project's one step: what it would store, until `t` and Enter.
  const [empty, setEmpty] = useState<StoredReview | null>(null);

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
  const piUnreadable = useMemo(() => unreadablePiFiles(project.resources).length > 0, [project]);
  // With an unreadable pi file there is nothing marcsh can show to trust.
  const choices = useMemo(() => (piUnreadable ? CHOICES.filter((choice) => choice.id !== "trusted") : CHOICES), [piUnreadable]);
  const now = nowText(current, reviewed, project);
  const effective = current === "trusted" && now !== "Now: trusted" ? null : current;

  const save = useCallback(
    (decision: ProjectTrust | null, reviewedNow?: StoredReview) => {
      try {
        records.setProjectTrust(cwd, decision, reviewedNow);
      } catch (error) {
        toast.show({ variant: "error", message: `Could not save the decision: ${error instanceof Error ? error.message : String(error)}` });
        dialog.close();
        return;
      }
      const message = decision ? `This project is now ${DECISION_TEXT[decision]} (pi: from the next turn)` : "Forgot the decision: this project is undecided again";
      toast.show({ variant: "success", message });
      dialog.close();
    },
    [records, cwd, dialog, toast],
  );

  // Trust, from what the project holds now (listed afresh: the folder may have changed since the dialog opened or the list was shown).
  const offerTrust = useCallback(() => {
    const { resources, record } = reviewProject(cwd);
    if (unreadablePiFiles(resources).length > 0) {
      toast.show({ variant: "error", message: "marcsh could not read some of this project's files, so it cannot show what trusting would run" });
      dialog.close();
      return;
    }
    // Nothing to list: say what trusting turns on, and wait for `t` and Enter (never saved on its own, also when files vanished).
    if (resources.length === 0) {
      setReview(null);
      setEmpty(record);
      return;
    }
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
    setEmpty(null);
    setReview({ kind: "trust", id: crypto.randomUUID(), cwd: canonical(cwd), resources, ...(changes ? { changes } : {}), respond });
  }, [cwd, save, dialog, toast, current, reviewed]);

  const trustEmpty = useCallback(() => {
    if (!empty) return;
    if (!sameReview(reviewProject(cwd).record, empty)) {
      toast.show({ variant: "error", message: "This project's files changed while you were reviewing them, so nothing was saved: review the new list" });
      offerTrust();
      return;
    }
    save("trusted", empty);
  }, [cwd, empty, offerTrust, save, toast]);

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
  if (empty) return <EmptyTrust cwd={cwd} onTrust={trustEmpty} />;

  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="column">
        <text wrapMode="char">{stripControlChars(cwd)}</text>
        <text attributes={TextAttributes.DIM}>{`${now} · ${foundText(project.resources)}`}</text>
        {unreadable.length > 0 ? (
          <>
            <text attributes={TextAttributes.DIM}>
              {piUnreadable
                ? "Trust is not offered: marcsh cannot show what trusting would run, because it could not read:"
                : "marcsh could not read these, so they stay off even when trusted:"}
            </text>
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

/**
 * Trusting a project with nothing to review: what it turns on, then `t` (arms) and Enter (trusts). Any other key disarms; Esc closes
 * the dialog. Selecting Trust in the list (Enter, a mouse press, a filter) only gets this far.
 */
function EmptyTrust({ cwd, onTrust }: { cwd: string; onTrust: () => void }) {
  const { isTopLayer } = useKeyboardLayer();
  const [armed, setArmed] = useState(false);

  useKeyboard((key) => {
    if (!isTopLayer("dialog") || key.name === "escape") return;
    const modified = key.ctrl || key.meta || key.option || key.super || key.hyper;
    if (!modified && key.name === "t") {
      key.preventDefault();
      setArmed(true);
    } else if (!modified && (key.name === "return" || key.name === "enter") && armed) {
      key.preventDefault();
      onTrust();
    } else setArmed(false);
  });

  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="column">
        <text wrapMode="char">{stripControlChars(cwd)}</text>
        <text>Nothing to review: this project has no pi files, project commands or git settings.</text>
        <text attributes={TextAttributes.DIM} wrapMode="word">
          Trusting turns on its pi files, project commands and the git changed-file count, none of which it has now. Any that appears later stays off until you review it with /trust.
        </text>
      </box>
      <box flexDirection="row" gap={2}>
        <text attributes={TextAttributes.DIM}>{armed ? "press Enter to trust" : "t trust (then Enter)"}</text>
        <text attributes={TextAttributes.DIM}>Esc cancel</text>
      </box>
    </box>
  );
}
