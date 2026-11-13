import { useCallback, useEffect, useRef, useState } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { useTheme } from "../../providers/theme";
import { wrapByWidth } from "../../lib/display-text";
import { engineLine, hookEvents, HOOKS_DIR, type HooksConfig } from "../../lib/pack-hooks";
import type { PackHooksInfo } from "../../lib/packs";

// The review of a pack's hooks, the scrolling dialog of `/agents hooks`, and the pieces it shares with the other pack dialogs
// (see pack-dialogs): the choice rows and the "closed without an answer is a no" rule.

const HOOKS_WARNING = "These commands run on your machine with your permissions while one of this pack's agents is selected.";
const HOOKS_PACK_NOTE = "Hooks may run any file of this pack; the whole pack is pinned to this commit.";

export const shortSha = (commit: string) => commit.slice(0, 7);

// The first row is the safe one and is selected when the dialog opens, like the trust dialog's.
export function Choice({ options, onChoose }: { options: string[]; onChoose: (index: number) => void }) {
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
export type Shown = { gone: boolean };

/** The question a dialog closed without an answer leaves behind is a no. */
export function useDeclineOnClose(shown: Shown, onAnswer: (yes: boolean) => void) {
  useEffect(
    () => () => {
      shown.gone = true;
      onAnswer(false);
    },
    [shown, onAnswer],
  );
}

const matcherText = (matcher: string | undefined) => (matcher === undefined || matcher === "" || matcher === "*" ? "all tools" : `matcher: ${matcher}`);

const sizeText = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

type ReviewInfo = Extract<PackHooksInfo, { state: "off" | "on" }>;

/**
 * Everything the user decides on when enabling a pack's hooks, in two parts: the header (the commit and what the hooks are) and the body
 * (each event with its matcher and the exact commands, the files, the engines, the warning). `commands` is how many commands the body lists.
 */
export function hooksReview(id: string, info: ReviewInfo): { header: string[]; body: string[]; commands: number } {
  const events = (config: HooksConfig) =>
    hookEvents(config).flatMap((event) =>
      config[event]!.flatMap((group) => [
        `${event} (${matcherText(group.matcher)})`,
        ...group.hooks.map((hook) => `   $ ${hook.command}${hook.timeout === undefined ? "" : ` (timeout ${hook.timeout} s)`}`),
      ]),
    );
  const changed = info.state === "off" && info.changed;
  const state = info.state === "on" ? "Hooks are on. They run these commands:" : changed ? "Hooks changed — off. Enabling runs these commands:" : "Hooks are off. Enabling runs these commands:";
  return {
    header: [`${id} @ ${shortSha(info.commit)}`, state],
    body: [
      ...(changed ? ["They changed since you last enabled them, so they were turned off."] : []),
      ...events(info.config),
      `Files in ${HOOKS_DIR}/:`,
      ...info.files.map((file) => `   ${file.path} (${sizeText(file.size)})`),
      engineLine(hookEvents(info.config)),
      HOOKS_PACK_NOTE,
      HOOKS_WARNING,
    ],
    commands: Object.values(info.config).reduce((total, groups) => total + groups.reduce((sum, group) => sum + group.hooks.length, 0), 0),
  };
}

/** The review as plain lines. */
export function hooksReviewLines(id: string, info: ReviewInfo): string[] {
  const { header, body } = hooksReview(id, info);
  return [...header, ...body];
}

// Rows of the dialog around its content: its padding, the title and the gaps (see providers/dialog), and the width its text gets.
const DIALOG_CHROME_ROWS = 5;
const DIALOG_TEXT_INSET = 8;
const DIALOG_MAX_WIDTH = 60;
const DIALOG_SCREEN_MARGIN = 4;
// Below the list: the hint (1), the two choices (2) and the gaps between the four sections of the review (3).
const REVIEW_FOOTER_ROWS = 1 + 2 + 3;
const REVIEW_MIN_ROWS = 3;
const REACHED_POLL_MS = 50;

// Mirrors the width the dialog provider gives its box (providers/dialog): keep the two in step.
const dialogWidth = (terminalWidth: number) => Math.min(DIALOG_MAX_WIDTH, terminalWidth - DIALOG_SCREEN_MARGIN);

export type ReviewProps = {
  /** Always on screen above the list: the commit and what the hooks are. */
  header: string[];
  /** The scrollable list: commands, files, notes. */
  body: string[];
  commands: number;
  /** Whether the yes choice waits until the whole list has been scrolled through. */
  gated: boolean;
  yes: string;
  shown: Shown;
  onAnswer: (yes: boolean) => void;
};

/**
 * The review of a pack's hooks. The header and the choices never scroll away; the commands, files and notes scroll between them
 * (Up/Down/PageUp/PageDown/Home/End, or the wheel). A dialog taller than the terminal would clip the commit line and the choices, and a
 * list the user could not read must not be one they can enable: `gated` keeps the yes choice dead until the end has been on screen.
 */
export function HooksReview({ header, body, commands, gated, yes, shown, onAnswer }: ReviewProps) {
  useDeclineOnClose(shown, onAnswer);
  const scroll = useRef<ScrollBoxRenderable>(null);
  const { isTopLayer } = useKeyboardLayer();
  const { width, height } = useTerminalDimensions();
  const [reached, setReached] = useState(!gated);

  const atEnd = useCallback(() => {
    const box = scroll.current;
    // Before the first layout both sizes are 0: that is not "everything fits".
    return !!box && box.viewport.height > 0 && box.scrollHeight > 0 && box.scrollTop + box.viewport.height >= box.scrollHeight;
  }, []);
  const measure = useCallback(() => {
    if (atEnd()) setReached(true);
  }, [atEnd]);
  useEffect(() => {
    if (reached) return;
    const timer = setInterval(measure, REACHED_POLL_MS);
    return () => clearInterval(timer);
  }, [reached, measure]);

  useKeyboard((key) => {
    if (!isTopLayer("dialog")) return;
    const box = scroll.current;
    if (!box) return;
    // Up and Down also move the choice (see Choice): the list and the choice row both follow the arrows.
    if (key.name === "up") box.scrollBy(-1);
    else if (key.name === "down") box.scrollBy(1);
    else if (key.name === "pageup") box.scrollBy(-Math.max(1, box.viewport.height - 1));
    else if (key.name === "pagedown") box.scrollBy(Math.max(1, box.viewport.height - 1));
    else if (key.name === "home") box.scrollTo(0);
    else if (key.name === "end") box.scrollTo(box.scrollHeight);
    else return;
    measure();
  });

  const textWidth = dialogWidth(width) - DIALOG_TEXT_INSET;
  const headerRows = header.reduce((rows, line) => rows + wrapByWidth(line, textWidth).length, 0);
  const room = Math.max(REVIEW_MIN_ROWS, height - DIALOG_CHROME_ROWS - headerRows - REVIEW_FOOTER_ROWS);
  const choose = (index: number) => {
    if (index === 1 && !reached && !atEnd()) return;
    onAnswer(index === 1);
  };

  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="column">
        {header.map((line, index) => (
          <text key={index} wrapMode="word" width="100%">
            {line}
          </text>
        ))}
      </box>
      <scrollbox ref={scroll} maxHeight={room}>
        {body.map((line, index) => (
          <text key={index} wrapMode="word" width="100%">
            {line}
          </text>
        ))}
      </scrollbox>
      {!reached && (
        <text attributes={TextAttributes.DIM} wrapMode="word" width="100%">
          {`Scroll to the end to review all ${commands} command${commands === 1 ? "" : "s"}`}
        </text>
      )}
      <Choice options={["Cancel", yes]} onChoose={choose} />
    </box>
  );
}
