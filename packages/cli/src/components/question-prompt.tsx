import { useEffect, useRef, useState } from "react";
import { TextAttributes, type InputRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { EmptyBorder } from "./border";
import { useQuietWindow } from "../hooks/use-quiet-window";
import { useKeyboardLayer } from "../providers/keyboard-layer";
import { useTheme } from "../providers/theme";
import type { QuestionRequest } from "../hooks/use-chat";
import { buildAnswer } from "../lib/ask-user-question";

type Props = {
  request: QuestionRequest;
  /** Tells the session when the free-text field is open, so its Esc leaves the field instead of interrupting. */
  onTextEntryChange?: (active: boolean) => void;
};

export function QuestionPrompt({ request, onTextEntryChange }: Props) {
  const { colors } = useTheme();
  const { isTopLayer } = useKeyboardLayer();
  const { quiet, isQuiet, restart: restartQuiet } = useQuietWindow(request);
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
      <text>
        <em fg={colors.info}>{question.header}</em>
      </text>
      <text>{question.question}</text>
      {typing ? (
        <box>
          <input ref={inputRef} placeholder="Type an answer" focused />
          <text attributes={TextAttributes.DIM}>Enter submits · Esc goes back to the options</text>
        </box>
      ) : (
        <box>
          {question.options.map((option, i) => (
            <box key={i}>
              <text>
                {question.multiSelect ? (picked.includes(i) ? "[x] " : "[ ] ") : ""}
                {i + 1} {option.label}
              </text>
              <text attributes={TextAttributes.DIM} paddingLeft={question.multiSelect ? 6 : 2}>
                {option.description}
              </text>
            </box>
          ))}
          <text>o Other (type an answer)</text>
          <text attributes={TextAttributes.DIM}>
            {!quiet
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
