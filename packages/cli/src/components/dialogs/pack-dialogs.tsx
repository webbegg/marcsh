import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { TextAttributes, type InputRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useDialog, type DialogContextValue } from "../../providers/dialog";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { useTheme } from "../../providers/theme";
import { useToast, type ToastContextValue } from "../../providers/toast";
import { DialogSearchList } from "../dialog-search-list";
import { hasLeftover, installPack, listPacks, parsePackSpec, removePack, updatePack, type PackEntry, type PackPreview } from "../../lib/packs";

// The `/agents` flows for packs (GitHub repos with agents, skills and commands): install, update, remove. Each step is a dialog
// that replaces the one before it. Nothing is installed or swapped before the preview is accepted, and a dialog that is closed
// (Esc) without an answer declines. Esc on the dialog shown while git runs stops git. A flow closes only a dialog it opened and
// that is still showing: the dialog provider has one slot and closes whatever is in it, so the flow tracks its own.

const ERROR_TOAST_MS = 8000;
const HOOKS_NOTE = "Pack hooks and MCP servers are not run.";

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

const shortSha = (commit: string) => commit.slice(0, 7);

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
    ...preview.agents.map((agent) => ` • ${agent.name} (${[agent.permission, agent.model].filter(Boolean).join(", ")})`),
    ...list("Skills", preview.skills),
    ...list("Commands", preview.commands),
    ...list("Not used", preview.ignored),
    ...preview.warnings.map((warning) => `Check: ${warning}`),
    HOOKS_NOTE,
  ];
}

// The first row is the safe one and is selected when the dialog opens, like the trust dialog's.
function Choice({ options, onChoose }: { options: string[]; onChoose: (index: number) => void }) {
  const [selected, setSelected] = useState(0);
  const { isTopLayer } = useKeyboardLayer();
  const { colors } = useTheme();

  useKeyboard((key) => {
    if (!isTopLayer("dialog")) return;
    if (key.name === "up") setSelected((index) => Math.max(0, index - 1));
    else if (key.name === "down") setSelected((index) => Math.min(options.length - 1, index + 1));
    else if (key.name === "return" || key.name === "enter") onChoose(selected);
  });

  return (
    <box flexDirection="column">
      {options.map((option, index) => (
        <box
          key={option}
          height={1}
          backgroundColor={index === selected ? colors.selection : undefined}
          onMouseMove={() => setSelected(index)}
          onMouseDown={() => onChoose(index)}
        >
          <text selectable={false} fg={index === selected ? "black" : "white"}>{`   ${option}`}</text>
        </box>
      ))}
    </box>
  );
}

/** A dialog a flow opened. `gone` is set when it leaves the screen, closed by the user or replaced by another dialog. */
type Shown = { gone: boolean };

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

/** The question a dialog closed without an answer leaves behind is a no. */
function Question({ lines, options, shown, onAnswer }: { lines: string[]; options: string[]; shown: Shown; onAnswer: (yes: boolean) => void }) {
  useEffect(
    () => () => {
      shown.gone = true;
      onAnswer(false);
    },
    [shown, onAnswer],
  );
  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="column">
        {lines.map((line, index) => (
          <text key={index} wrapMode="word" width="100%" attributes={line === HOOKS_NOTE ? TextAttributes.DIM : undefined}>
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
    flow.toast.show({ variant: "success", message: `Updated ${pack.id} to ${shortSha(result.pack.commit)}` });
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

const USAGE = "Usage: /agents install <owner/repo[@ref]> | update [<owner/repo>] | remove <owner/repo>";

/**
 * `/agents install <owner/repo[@ref]>`, `/agents update [<owner/repo>]` and `/agents remove <owner/repo>`, typed instead of picked:
 * the same flows the dialog's rows open (preview and consent included). Anything else is an error toast with the usage line.
 */
export function runPackCommand(args: string, flow: Flow): Promise<void> | void {
  const [verb, operand, ...extra] = args.trim().split(/\s+/);
  const usage = (why?: string) => failure(flow, why ? `${why} ${USAGE}` : USAGE);
  if (extra.length > 0 || (verb !== "install" && verb !== "update" && verb !== "remove")) return usage();
  if (verb === "install") {
    if (!operand) return usage();
    try {
      parsePackSpec(operand);
    } catch (error) {
      return usage(error instanceof Error ? error.message : String(error));
    }
    return runInstall(flow, operand);
  }
  if (!operand) {
    if (verb === "remove") return usage();
    flow.dialog.open({ title: "Update a pack", children: <PackPickerDialogContent action="update" onChanged={flow.onChanged} /> });
    return;
  }
  let id: string;
  try {
    const spec = parsePackSpec(operand);
    if (spec.ref !== undefined) return usage(`${operand} names a ref; ${verb} takes owner/repo.`);
    id = spec.id;
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }
  const pack = listPacks().find((item) => item.id === id);
  if (!pack) {
    // A folder under the root with no lock entry cannot be installed over or updated, but it can be removed.
    if (verb === "remove" && hasLeftover(id)) return runRemove(flow, id);
    return failure(flow, `${id} is not installed`);
  }
  return verb === "update" ? runUpdate(flow, pack) : runRemove(flow, pack.id, pack.commit);
}

function TextField({ placeholder, onSubmit }: { placeholder: string; onSubmit: (value: string) => void }) {
  const inputRef = useRef<InputRenderable>(null);
  const { isTopLayer } = useKeyboardLayer();

  useKeyboard((key) => {
    if (!isTopLayer("dialog") || (key.name !== "return" && key.name !== "enter")) return;
    const value = inputRef.current?.value.trim();
    if (value) onSubmit(value);
  });

  return <input ref={inputRef} focused placeholder={placeholder} />;
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

type PickerProps = { onChanged: () => void; action: "update" | "remove" };

/** "Update packs…" and "Remove a pack…": the installed packs, one is picked. */
export const PackPickerDialogContent = ({ onChanged, action }: PickerProps) => {
  const flow = useFlow(onChanged);
  const packs = listPacks();
  return (
    <DialogSearchList
      items={packs}
      onSelect={(pack) => void (action === "update" ? runUpdate(flow, pack) : runRemove(flow, pack.id, pack.commit))}
      filterFn={(pack, query) => pack.id.includes(query.toLowerCase())}
      renderItem={(pack, isSelected) => (
        <box flexDirection="row" gap={1} overflow="hidden">
          <text selectable={false} fg={isSelected ? "black" : "white"}>{`   ${pack.id}`}</text>
          <text selectable={false} fg={isSelected ? "black" : "gray"} attributes={TextAttributes.DIM}>
            {`${shortSha(pack.commit)}${pack.ref ? ` @${pack.ref}` : ""}`}
          </text>
        </box>
      )}
      getKey={(pack) => pack.id}
      placeholder="Search packs"
      emptyText="No packs installed"
    />
  );
};
