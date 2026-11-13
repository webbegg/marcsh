import { Fragment, useEffect, useState, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import { useDialog, type DialogContextValue } from "../../providers/dialog";
import { useToast, type ToastContextValue } from "../../providers/toast";
import { DialogSearchList } from "../dialog-search-list";
import { TextField } from "./text-field";
import { Choice, HooksReview, hooksReview, shortSha, useDeclineOnClose, type ReviewProps, type Shown } from "./hooks-review";
import { parsePackCommand } from "../../lib/pack-command";
import {
  disablePackHooks,
  enablePackHooks,
  hasLeftover,
  inspectPackHooks,
  installPack,
  listPacks,
  removePack,
  updatePack,
  type PackEntry,
  type PackHooksInfo,
  type PackPreview,
} from "../../lib/packs";

// The `/agents` flows for packs (GitHub repos with agents, skills and commands): install, update, remove, and the review of a pack's
// hooks (the one thing of a pack that runs commands, so it is off until the user has read them and enables it). Each step is a dialog
// that replaces the one before it. Nothing is installed or swapped before the preview is accepted, and a dialog that is closed
// (Esc) without an answer declines. Esc on the dialog shown while git runs stops git. A flow closes only a dialog it opened and
// that is still showing: the dialog provider has one slot and closes whatever is in it, so the flow tracks its own.

const ERROR_TOAST_MS = 8000;
// Two short lines: a long one wraps in the dialog.
const HOOKS_NOTES = ["Pack hooks stay off until you enable them.", "MCP servers are not run."];

export { hooksReview, hooksReviewLines } from "./hooks-review";

type Flow = {
  dialog: DialogContextValue;
  toast: ToastContextValue;
  /** Called after the installed packs changed, so the agent list is read again. */
  onChanged: () => void;
};

function useFlow(onChanged: () => void): Flow {
  const dialog = useDialog();
  const toast = useToast();
  return { dialog, toast, onChanged };
}

const failure = (flow: Flow, error: unknown) =>
  flow.toast.show({ variant: "error", message: error instanceof Error ? error.message : String(error), duration: ERROR_TOAST_MS });

/** What a pack holds, one line each, then the line that says what is not run. */
export function previewLines(preview: PackPreview): string[] {
  const list = (label: string, items: string[]) => (items.length > 0 ? [`${label}: ${items.join(", ")}`] : []);
  const header = preview.previousCommit
    ? `${preview.id}: ${shortSha(preview.previousCommit)} → ${shortSha(preview.commit)}`
    : `${preview.id} @ ${shortSha(preview.commit)}`;
  return [
    header,
    "Agents:",
    ...preview.agents.map((agent) => ` • ${agent.name} (${[agent.permission, agent.model, agent.tools].filter(Boolean).join(", ")})`),
    ...list("Skills", preview.skills),
    ...list("Commands", preview.commands),
    ...(preview.hooks
      ? [
          preview.hooks.usable
            ? `hooks: present, off \u2014 enable with /agents hooks ${preview.id}`
            : `hooks: present but unusable (${preview.hooks.reason}); they can never be enabled`,
        ]
      : []),
    ...(preview.hooksTurnedOff ? [`Hooks turned off; review them again with /agents hooks ${preview.id}`] : []),
    ...list("Not used", preview.ignored),
    ...preview.warnings.map((warning) => `Check: ${warning}`),
    ...HOOKS_NOTES,
  ];
}

/** One run of a flow (install, update or remove): the dialogs it opened and the signal that stops its git. */
type Run = {
  signal: AbortSignal;
  /** Stops git (Esc on the working dialog). Does nothing once the fetch is done: the preview replacing that dialog is not a cancel. */
  abort: () => void;
  /** The fetch is done and the preview is next. */
  fetched: () => void;
  /** Replaces whatever dialog is open with a new one of this run. */
  open: (title: string, render: (shown: Shown) => ReactNode) => void;
  /** Closes the run's last dialog, unless it is already gone: then another dialog (or none) is showing and it is not ours to close. */
  close: () => void;
};

let dialogKey = 0;

function startRun(flow: Flow): Run {
  const controller = new AbortController();
  let last: Shown = { gone: true };
  let done = false;
  return {
    signal: controller.signal,
    abort: () => {
      if (!done) controller.abort();
    },
    fetched: () => {
      done = true;
    },
    open(title, render) {
      last = { gone: false };
      // A key of its own: a dialog of the same kind opened by another flow is a new one, not an update of this.
      flow.dialog.open({ title, children: <Fragment key={++dialogKey}>{render(last)}</Fragment> });
    },
    close() {
      if (!last.gone) flow.dialog.close();
    },
  };
}

function Question({ lines, options, shown, onAnswer }: { lines: string[]; options: string[]; shown: Shown; onAnswer: (yes: boolean) => void }) {
  useDeclineOnClose(shown, onAnswer);
  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="column">
        {lines.map((line, index) => (
          <text key={index} wrapMode="word" width="100%" attributes={HOOKS_NOTES.includes(line) ? TextAttributes.DIM : undefined}>
            {line}
          </text>
        ))}
      </box>
      <Choice options={options} onChoose={(index) => onAnswer(index === 1)} />
    </box>
  );
}

/** Shown while git runs. Leaving the screen (Esc) aborts the run, which stops git. */
function Working({ message, shown, abort }: { message: string; shown: Shown; abort: () => void }) {
  useEffect(
    () => () => {
      shown.gone = true;
      abort();
    },
    [shown, abort],
  );
  return <text attributes={TextAttributes.DIM}>{message}</text>;
}

function ask(run: Run, title: string, lines: string[], yes: string): Promise<boolean> {
  return new Promise((resolve) => {
    run.open(title, (shown) => <Question lines={lines} options={["Cancel", yes]} shown={shown} onAnswer={resolve} />);
  });
}

/** Opens the preview as the answer to `installPack`/`updatePack`'s `confirm`, unless the run was already cancelled. */
function confirmWith(run: Run, title: string, yes: string) {
  return async (preview: PackPreview) => {
    if (run.signal.aborted) return false;
    run.fetched();
    return ask(run, title, previewLines(preview), yes);
  };
}

async function runInstall(flow: Flow, text: string) {
  const run = startRun(flow);
  run.open("Install pack", (shown) => <Working message={`Fetching ${text}…`} shown={shown} abort={run.abort} />);
  try {
    const result = await installPack(text, { confirm: confirmWith(run, "Install pack", "Install"), signal: run.signal });
    run.close();
    if (result.status === "cancelled") return flow.toast.show({ variant: "info", message: "Install cancelled" });
    flow.onChanged();
    const count = result.preview.agents.length;
    flow.toast.show({ variant: "success", message: `Installed ${result.pack.id} (${count} agent${count === 1 ? "" : "s"})` });
  } catch (error) {
    run.close();
    if (run.signal.aborted) return flow.toast.show({ variant: "info", message: "Install cancelled" });
    failure(flow, error);
  }
}

async function runUpdate(flow: Flow, pack: PackEntry) {
  const run = startRun(flow);
  run.open("Update pack", (shown) => <Working message={`Checking ${pack.id} for updates…`} shown={shown} abort={run.abort} />);
  try {
    const result = await updatePack(pack.id, { confirm: confirmWith(run, "Update pack", "Update"), signal: run.signal });
    run.close();
    if (result.status === "cancelled") return flow.toast.show({ variant: "info", message: "Update cancelled" });
    if (result.status === "up-to-date") return flow.toast.show({ variant: "info", message: `${pack.id} is up to date` });
    flow.onChanged();
    const off = result.preview.hooksTurnedOff ? `. Hooks turned off; review them again with /agents hooks ${pack.id}` : "";
    flow.toast.show({ variant: "success", message: `Updated ${pack.id} to ${shortSha(result.pack.commit)}${off}`, ...(off ? { duration: ERROR_TOAST_MS } : {}) });
  } catch (error) {
    run.close();
    if (run.signal.aborted) return flow.toast.show({ variant: "info", message: "Update cancelled" });
    failure(flow, error);
  }
}

/** `commit` is the installed pack's; without it the folder is a leftover that has no lock entry. */
async function runRemove(flow: Flow, id: string, commit?: string) {
  const run = startRun(flow);
  const lines = commit
    ? [`Remove ${id} (${shortSha(commit)})?`, "Its agents, skills and commands are deleted from ~/.marcsh/packs."]
    : [`Remove the leftover folder of ${id}?`, "packs.json has no entry for it, so none of its agents are loaded. The folder is deleted from ~/.marcsh/packs."];
  const yes = await ask(run, "Remove pack", lines, "Remove");
  run.close();
  if (!yes) return;
  try {
    const result = await removePack(id);
    flow.onChanged();
    flow.toast.show({ variant: "success", message: result.status === "removed-leftover" ? `Removed the leftover folder of ${id}` : `Removed ${id}` });
  } catch (error) {
    failure(flow, error);
  }
}

function askReview(run: Run, title: string, review: Omit<ReviewProps, "shown" | "onAnswer" | "yes" | "gated">, yes: string, gated: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    run.open(title, (shown) => <HooksReview {...review} yes={yes} gated={gated} shown={shown} onAnswer={resolve} />);
  });
}

/** `/agents hooks <owner/repo>`: shows the hooks and enables them on consent (or turns them off, when they are on). */
async function runHooks(flow: Flow, id: string) {
  if (!listPacks().some((pack) => pack.id === id)) return failure(flow, `${id} is not installed`);
  const info = await inspectPackHooks(id);
  if (info.state === "none") return failure(flow, `${id} has no hooks`);
  if (info.state === "unusable") return failure(flow, `The hooks of ${id} cannot be enabled: ${info.reason}`);

  const run = startRun(flow);
  // Turning hooks off is always safe; enabling waits until the whole list has been on screen.
  const yes = await askReview(run, "Pack hooks", hooksReview(id, info), info.state === "on" ? "Turn off" : "Enable", info.state !== "on");
  run.close();
  if (!yes) return;
  try {
    if (info.state === "on") {
      await disablePackHooks(id);
      flow.onChanged();
      return flow.toast.show({ variant: "success", message: `Turned off hooks of ${id}` });
    }
    // The files the user read are the ones that are enabled: the digest of what was shown must still be what is on disk.
    await enablePackHooks(id, { reviewed: { commit: info.commit, digest: info.digest } });
    flow.onChanged();
    flow.toast.show({ variant: "success", message: `Enabled hooks of ${id}: they run while one of its agents is selected`, duration: ERROR_TOAST_MS });
  } catch (error) {
    failure(flow, error);
  }
}

/** `/agents hooks <owner/repo> off`: no question, nothing runs. */
async function runHooksOff(flow: Flow, id: string) {
  try {
    const result = await disablePackHooks(id);
    flow.onChanged();
    flow.toast.show({ variant: "info", message: result.status === "disabled" ? `Turned off hooks of ${id}` : `Hooks of ${id} were already off` });
  } catch (error) {
    failure(flow, error);
  }
}

/**
 * `/agents install <owner/repo[@ref]>`, `/agents update [<owner/repo>]`, `/agents remove <owner/repo>` and `/agents hooks [<owner/repo> [off]]`, typed instead of picked:
 * the same flows the dialog's rows open (preview and consent included). Anything else is an error toast with the usage line.
 */
export function runPackCommand(args: string, flow: Flow): Promise<void> | void {
  const command = parsePackCommand(args);
  switch (command.kind) {
    case "usage":
      return failure(flow, command.message);
    case "install":
      return runInstall(flow, command.spec);
    case "picker":
      flow.dialog.open({
        title: command.action === "hooks" ? "Pack hooks" : "Update a pack",
        children: <PackPickerDialogContent action={command.action} onChanged={flow.onChanged} />,
      });
      return;
    case "hooks":
      return runHooks(flow, command.id);
    case "hooks-off":
      return runHooksOff(flow, command.id);
    case "update":
    case "remove": {
      const { id } = command;
      const pack = listPacks().find((item) => item.id === id);
      if (!pack) {
        // A folder under the root with no lock entry cannot be installed over or updated, but it can be removed.
        if (command.kind === "remove" && hasLeftover(id)) return runRemove(flow, id);
        return failure(flow, `${id} is not installed`);
      }
      return command.kind === "update" ? runUpdate(flow, pack) : runRemove(flow, pack.id, pack.commit);
    }
  }
}

/** "Install from GitHub…": asks for `owner/repo[@ref]`, shows what the pack holds, installs it on consent. */
export const PackInstallDialogContent = ({ onChanged }: { onChanged: () => void }) => {
  const flow = useFlow(onChanged);
  return (
    <box flexDirection="column" gap={1}>
      <text attributes={TextAttributes.DIM} wrapMode="word" width="100%">
        A GitHub repository with agents/*.md (and optionally skills/ and commands/). You see its contents before anything is installed.
      </text>
      <TextField placeholder="owner/repo or owner/repo@ref" onSubmit={(text) => void runInstall(flow, text)} />
    </box>
  );
};

type PickerProps = { onChanged: () => void; action: "update" | "remove" | "hooks" };

const hooksStateText = (info: PackHooksInfo) => {
  switch (info.state) {
    case "none":
      return "";
    case "unusable":
      return "hooks unusable";
    case "on":
      return "hooks on";
    case "off":
      return info.changed ? "hooks changed \u2014 off" : "hooks off";
  }
};

/** "Update packs…", "Remove a pack…" and "Pack hooks…": the installed packs (for hooks, those that have a hooks folder), one is picked. */
export const PackPickerDialogContent = ({ onChanged, action }: PickerProps) => {
  const flow = useFlow(onChanged);
  const [packs, setPacks] = useState<PackEntry[]>(() => (action === "hooks" ? [] : listPacks()));
  // Which packs have hooks, and in what state, is read from their files in the background; the list is empty until then.
  const [hooksText, setHooksText] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [loading, setLoading] = useState(action === "hooks");
  useEffect(() => {
    if (action !== "hooks") return;
    let alive = true;
    void (async () => {
      const found: PackEntry[] = [];
      const text = new Map<string, string>();
      for (const pack of listPacks()) {
        const info = await inspectPackHooks(pack.id);
        if (info.state === "none") continue;
        found.push(pack);
        text.set(pack.id, hooksStateText(info));
      }
      if (!alive) return;
      setPacks(found);
      setHooksText(text);
      setLoading(false);
    })().catch(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [action]);
  const select = (pack: PackEntry) => {
    if (action === "update") return runUpdate(flow, pack);
    if (action === "hooks") return runHooks(flow, pack.id);
    return runRemove(flow, pack.id, pack.commit);
  };
  return (
    <DialogSearchList
      items={packs}
      onSelect={(pack) => void select(pack)}
      filterFn={(pack, query) => pack.id.includes(query.toLowerCase())}
      renderItem={(pack, isSelected) => (
        <box flexDirection="row" gap={1} overflow="hidden">
          <text selectable={false} fg={isSelected ? "black" : "white"}>{`   ${pack.id}`}</text>
          <text selectable={false} fg={isSelected ? "black" : "gray"} attributes={TextAttributes.DIM}>
            {action === "hooks" ? (hooksText.get(pack.id) ?? "") : `${shortSha(pack.commit)}${pack.ref ? ` @${pack.ref}` : ""}`}
          </text>
        </box>
      )}
      getKey={(pack) => pack.id}
      placeholder="Search packs"
      emptyText={loading ? "Reading packs…" : action === "hooks" ? "No installed pack has hooks" : "No packs installed"}
    />
  );
};
