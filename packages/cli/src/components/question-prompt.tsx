import { useEffect, useRef, useState } from "react";
import { TextAttributes, type BoxRenderable, type InputRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { EmptyBorder } from "./border";
import { useQuietWindow } from "../hooks/use-quiet-window";
import { useKeyboardLayer } from "../providers/keyboard-layer";
import { useTheme } from "../providers/theme";
import type { QuestionRequest } from "../hooks/use-chat";
import { buildAnswer } from "../lib/ask-user-question";
import { escapeProjectText } from "../lib/engine/pi-trust";
import { wrapByWidth, wrappedRows } from "../lib/display-text";
import { LOCKED_LINE, usePromptLock } from "../lib/prompt-lock";

const MIN_TEXT_WIDTH = 10;
const UNMEASURED_MARGIN = 8;
// Starts every row of text the model supplied (as in the approval prompt), which the prompt's own rows never have, so no row of it can pass for one.
const GUTTER = "┊ ";
// The columns the prompt uses beside its text: the left border, the padding on both sides and the gutter.
const SIDE_COLUMNS = 1 + 4 + GUTTER.length;

type RowsProps = {
  rows: string[];
  dim?: boolean;
  /** The first row starts with text the prompt wrote itself (a label), so it needs no gutter. */
  labelled?: boolean;
  fg?: string;
  em?: boolean;
};

/** Text the model supplied, drawn as the rows it was already cut into: each row behind the gutter, in a column of its own. */
function Rows({ rows, dim = false, labelled = false, fg, em = false }: RowsProps) {
  return (
    <>
      {rows.map((row, index) => {
        const text = em ? <em fg={fg}>{row}</em> : row;
        const attributes = dim ? TextAttributes.DIM : undefined;
        return labelled && index === 0 ? (
          <text key={index} attributes={attributes} wrapMode="char">{text}</text>
        ) : (
          <box key={index} flexDirection="row">
            <text attributes={TextAttributes.DIM} flexShrink={0}>{GUTTER}</text>
            <text attributes={attributes} flexGrow={1} flexShrink={1} wrapMode="char">{text}</text>
          </box>
        );
      })}
    </>
  );
}

type Props = {
  request: QuestionRequest;
  /** Tells the session when the free-text field is open, so its Esc leaves the field instead of interrupting. */
  onTextEntryChange?: (active: boolean) => void;
};

export function QuestionPrompt({ request, onTextEntryChange }: Props) {
  const { colors } = useTheme();
  const renderer = useRenderer();
  const { width: terminalWidth } = useTerminalDimensions();
  const boxRef = useRef<BoxRenderable>(null);
  // The prompt's own width once laid out (the screen around it takes columns); until then the terminal's less a margin, so a first row is never too wide.
  const [boxWidth, setBoxWidth] = useState(terminalWidth - UNMEASURED_MARGIN);
  const textWidth = Math.max(MIN_TEXT_WIDTH, Math.min(boxWidth, terminalWidth) - SIDE_COLUMNS);

  useEffect(() => {
    const measure = () => {
      const width = boxRef.current?.width;
      if (width) setBoxWidth((prev) => (prev === width ? prev : width));
    };
    measure();
    renderer.root.on("layout-changed", measure);
    return () => {
      renderer.root.off("layout-changed", measure);
    };
  }, [renderer]);
  const { isTopLayer } = useKeyboardLayer();
  const { quiet, isQuiet, restart: restartQuiet } = useQuietWindow(request);
  const lock = usePromptLock(request);
  const inputRef = useRef<InputRenderable>(null);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<number[]>([]);
  const [typing, setTyping] = useState(false);

  const question = request.questions[index]!;
  const isLast = index === request.questions.length - 1;

  useEffect(() => {
    onTextEntryChange?.(typing);
    return () => onTextEntryChange?.(false);
  }, [typing, onTextEntryChange]);

  /** Records the answer to the current question and moves on, or answers the SDK after the last one. */
  const answer = (value: string) => {
    const next = { ...answers, [question.question]: value };
    if (isLast) {
      request.respond(next);
      return;
    }
    setAnswers(next);
    setIndex(index + 1);
    setPicked([]);
    setTyping(false);
    // The next question must not be answered by a key pressed for this one.
    restartQuiet();
  };

  useKeyboard((key) => {
    const chord = key.ctrl || key.meta || key.option || key.super || key.hyper;

    // Opened while the user was composing: nothing answers it until ↓, then the rules below apply from a fresh quiet window.
    if (lock.isLocked()) {
      if (key.name === "down" && isTopLayer("base") && !chord) {
        key.preventDefault();
        lock.unlock();
        restartQuiet();
      }
      return;
    }

    if (typing) {
      if (!isTopLayer("base") || chord) return;

      if (key.name === "escape") {
        key.preventDefault();
        key.stopPropagation();
        setTyping(false);
        restartQuiet();
      } else if (key.name === "return" || key.name === "enter") {
        key.preventDefault();
        const text = inputRef.current?.value.trim() ?? "";
        if (text) answer(buildAnswer(question, { picked, other: text }));
      }
      return;
    }

    // Any key before the keyboard is quiet (answer keys included) is ignored and restarts the wait.
    if (!isQuiet() || !isTopLayer("base") || chord) {
      restartQuiet();
      return;
    }

    const choice = /^[1-9]$/.test(key.name) ? Number(key.name) - 1 : -1;

    if (choice >= 0 && choice < question.options.length) {
      key.preventDefault();
      if (!question.multiSelect) {
        answer(buildAnswer(question, { picked: [choice] }));
      } else {
        setPicked((current) => (current.includes(choice) ? current.filter((i) => i !== choice) : [...current, choice]));
      }
    } else if (key.name === "o") {
      key.preventDefault();
      setTyping(true);
    } else if ((key.name === "return" || key.name === "enter") && question.multiSelect && picked.length > 0) {
      key.preventDefault();
      answer(buildAnswer(question, { picked }));
    } else {
      restartQuiet();
    }
  });

  return (
    <box
      ref={boxRef}
      border={["left"]}
      borderColor={colors.info}
      customBorderChars={{
        ...EmptyBorder,
        vertical: "│",
      }}
      width="100%"
      paddingX={2}
    >
      <text attributes={TextAttributes.DIM}>
        Question {index + 1}/{request.questions.length}
      </text>
      <Rows rows={wrapByWidth(escapeProjectText(question.header), textWidth)} em fg={colors.info} />
      <Rows rows={wrappedRows(question.question, textWidth)} />
      {typing ? (
        <box>
          <input ref={inputRef} placeholder="Type an answer" focused />
          <text attributes={TextAttributes.DIM}>Enter submits · Esc goes back to the options</text>
        </box>
      ) : (
        <box>
          {question.options.map((option, i) => (
            <box key={i}>
              <Rows rows={wrapByWidth(`${question.multiSelect ? (picked.includes(i) ? "[x] " : "[ ] ") : ""}${i + 1} ${escapeProjectText(option.label)}`, textWidth)} labelled />
              <box paddingLeft={question.multiSelect ? 6 : 2}>
                <Rows rows={wrappedRows(option.description, textWidth - (question.multiSelect ? 6 : 2))} dim />
              </box>
            </box>
          ))}
          <text>o Other (type an answer)</text>
          <text attributes={TextAttributes.DIM}>
            {lock.locked
              ? `${LOCKED_LINE} · Esc declines`
              : !quiet
              ? "waiting for typing to stop…"
              : question.multiSelect
                ? "numbers toggle · Enter confirms · Esc declines"
                : "press a number to answer · Esc declines"}
          </text>
        </box>
      )}
    </box>
  );
}
