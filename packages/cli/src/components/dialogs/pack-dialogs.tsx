import { useEffect, useRef, useState } from "react";
import { TextAttributes, type InputRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useDialog, type DialogContextValue } from "../../providers/dialog";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { useTheme } from "../../providers/theme";
import { useToast, type ToastContextValue } from "../../providers/toast";
import { DialogSearchList } from "../dialog-search-list";
import { installPack, listPacks, parsePackSpec, removePack, updatePack, type PackEntry, type PackPreview } from "../../lib/packs";

// The `/agents` flows for packs (GitHub repos with agents, skills and commands): install, update, remove. Each step is a dialog
// that replaces the one before it. Nothing is installed or swapped before the preview is accepted, and a dialog that is closed
// (Esc) without an answer declines.

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

/** The question a dialog closed without an answer leaves behind is a no. */
function Question({ lines, options, onAnswer }: { lines: string[]; options: string[]; onAnswer: (yes: boolean) => void }) {
  useEffect(() => () => onAnswer(false), [onAnswer]);
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

/** Shown while git runs; closing it (Esc) stops the flow before the preview. */
function Working({ message, gone }: { message: string; gone: { value: boolean } }) {
  useEffect(
    () => () => {
      gone.value = true;
    },
    [gone],
  );
  return <text attributes={TextAttributes.DIM}>{message}</text>;
}

function ask(flow: Flow, title: string, lines: string[], yes: string): Promise<boolean> {
  return new Promise((resolve) => {
    flow.dialog.open({ title, children: <Question lines={lines} options={["Cancel", yes]} onAnswer={resolve} /> });
  });
}

/** Opens the preview as the answer to `installPack`/`updatePack`'s `confirm`, unless the working dialog was already closed. */
function confirmWith(flow: Flow, title: string, yes: string, gone: { value: boolean }) {
  return async (preview: PackPreview) => {
    if (gone.value) return false;
    return ask(flow, title, previewLines(preview), yes);
  };
}

async function runInstall(flow: Flow, text: string) {
  const gone = { value: false };
  flow.dialog.open({ title: "Install pack", children: <Working message={`Fetching ${text}…`} gone={gone} /> });
  try {
    const result = await installPack(text, { confirm: confirmWith(flow, "Install pack", "Install", gone) });
    flow.dialog.close();
    if (result.status === "cancelled") return flow.toast.show({ variant: "info", message: "Install cancelled" });
    flow.onChanged();
    const count = result.preview.agents.length;
    flow.toast.show({ variant: "success", message: `Installed ${result.pack.id} (${count} agent${count === 1 ? "" : "s"})` });
  } catch (error) {
    flow.dialog.close();
    failure(flow, error);
  }
}

async function runUpdate(flow: Flow, pack: PackEntry) {
  const gone = { value: false };
  flow.dialog.open({ title: "Update pack", children: <Working message={`Checking ${pack.id} for updates…`} gone={gone} /> });
  try {
    const result = await updatePack(pack.id, { confirm: confirmWith(flow, "Update pack", "Update", gone) });
    flow.dialog.close();
    if (result.status === "cancelled") return flow.toast.show({ variant: "info", message: "Update cancelled" });
    if (result.status === "up-to-date") return flow.toast.show({ variant: "info", message: `${pack.id} is up to date` });
    flow.onChanged();
    flow.toast.show({ variant: "success", message: `Updated ${pack.id} to ${shortSha(result.pack.commit)}` });
  } catch (error) {
    flow.dialog.close();
    failure(flow, error);
  }
}

async function runRemove(flow: Flow, pack: PackEntry) {
  const yes = await ask(flow, "Remove pack", [`Remove ${pack.id} (${shortSha(pack.commit)})?`, "Its agents, skills and commands are deleted from ~/.marcsh/packs."], "Remove");
  flow.dialog.close();
  if (!yes) return;
  try {
    await removePack(pack.id);
    flow.onChanged();
    flow.toast.show({ variant: "success", message: `Removed ${pack.id}` });
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
  if (!pack) return failure(flow, `${id} is not installed`);
  return verb === "update" ? runUpdate(flow, pack) : runRemove(flow, pack);
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
      onSelect={(pack) => void (action === "update" ? runUpdate(flow, pack) : runRemove(flow, pack))}
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
