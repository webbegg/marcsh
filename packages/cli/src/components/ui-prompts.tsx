import { useEffect, useRef, useState, type ReactNode } from "react";
import { TextAttributes, type InputRenderable, type KeyBinding, type TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { EmptyBorder } from "./border";
import { useQuietWindow } from "../hooks/use-quiet-window";
import { useKeyboardLayer } from "../providers/keyboard-layer";
import { useTheme } from "../providers/theme";
import type { ConfirmRequest, EditorRequest, InputRequest, SelectRequest } from "../hooks/use-chat";

// Compact prompts for the dialogs an engine's extensions open (pi: select, confirm, input, editor). Like the
// approval and question prompts they sit in the conversation and ignore keys until the keyboard has been quiet.

const MAX_VISIBLE_OPTIONS = 8;
const MAX_QUICK_PICK = 9;

type PromptProps<R> = {
  request: R;
  /** Tells the session an Esc belongs to the prompt (it cancels the ask), not to the turn's interrupt. */
  onTextEntryChange?: (active: boolean) => void;
};

function Frame({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
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
      {children}
    </box>
  );
}

// While a prompt is open, Esc cancels it; the session must not also read that Esc as "interrupt the turn".
function useOwnEscape(onTextEntryChange?: (active: boolean) => void) {
  useEffect(() => {
    onTextEntryChange?.(true);
    return () => onTextEntryChange?.(false);
  }, [onTextEntryChange]);
}

const hasModifier = (key: { ctrl: boolean; meta: boolean; option: boolean; super?: boolean; hyper?: boolean }) =>
  key.ctrl || key.meta || key.option || key.super || key.hyper;

export function SelectPrompt({ request, onTextEntryChange }: PromptProps<SelectRequest>) {
  const { colors } = useTheme();
  const { isTopLayer } = useKeyboardLayer();
  const { quiet, isQuiet, restart: restartQuiet } = useQuietWindow(request);
  const [index, setIndex] = useState(0);
  const { options } = request;
  useOwnEscape(onTextEntryChange);

  useKeyboard((key) => {
    if (!isTopLayer("base") || hasModifier(key)) {
      restartQuiet();
      return;
    }

    // Moving the highlight and cancelling are harmless, so they work at once.
    if (key.name === "escape") {
      key.preventDefault();
      request.respond(undefined);
    } else if (key.name === "up") {
      key.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (key.name === "down") {
      key.preventDefault();
      setIndex((i) => Math.min(options.length - 1, i + 1));
    } else if (!isQuiet()) {
      // Any other key before the keyboard is quiet (answer keys included) is ignored and restarts the wait.
      restartQuiet();
    } else if (key.name === "return" || key.name === "enter") {
      key.preventDefault();
      const choice = options[index];
      if (choice !== undefined) request.respond(choice);
    } else if (/^[1-9]$/.test(key.name) && Number(key.name) <= Math.min(options.length, MAX_QUICK_PICK)) {
      key.preventDefault();
      request.respond(options[Number(key.name) - 1]);
    } else {
      restartQuiet();
    }
  });

  const start = Math.max(0, Math.min(index - MAX_VISIBLE_OPTIONS + 1, options.length - MAX_VISIBLE_OPTIONS));
  const visible = options.slice(start, start + MAX_VISIBLE_OPTIONS);
  const below = options.length - start - visible.length;

  return (
    <Frame>
      <text>
        <em fg={colors.info}>{request.title}</em>
      </text>
      {start > 0 ? <text attributes={TextAttributes.DIM}>↑ {start} more</text> : null}
      {visible.map((option, offset) => {
        const i = start + offset;
        return (
          <text key={i} attributes={i === index ? TextAttributes.BOLD : undefined}>
            {i === index ? "› " : "  "}
            {i < MAX_QUICK_PICK ? `${i + 1} ` : ""}
            {option}
          </text>
        );
      })}
      {below > 0 ? <text attributes={TextAttributes.DIM}>↓ {below} more</text> : null}
      <text attributes={TextAttributes.DIM}>
        {quiet ? "↑/↓ move · Enter selects · 1-9 pick · Esc cancels" : "waiting for typing to stop…"}
      </text>
    </Frame>
  );
}

/**
 * Extensions use `confirm` to gate things that can hurt, so it follows the approval prompt's rules for a
 * default-no ask: keys count only after the quiet window, `y` alone confirms nothing (it arms Enter), and
 * any other key disarms it.
 */
export function ConfirmPrompt({ request, onTextEntryChange }: PromptProps<ConfirmRequest>) {
  const { colors } = useTheme();
  const { isTopLayer } = useKeyboardLayer();
  const { quiet, isQuiet, restart: restartQuiet } = useQuietWindow(request);
  const [armedRequest, setArmedRequest] = useState<ConfirmRequest | null>(null);
  const armed = armedRequest === request;
  useOwnEscape(onTextEntryChange);

  useKeyboard((key) => {
    if (isTopLayer("base") && !hasModifier(key) && key.name === "escape") {
      key.preventDefault();
      request.respond(false);
      return;
    }

    // Any key before the keyboard is quiet (answer keys included) is ignored and restarts the wait.
    if (!isQuiet() || !isTopLayer("base") || hasModifier(key)) {
      setArmedRequest(null);
      restartQuiet();
      return;
    }

    if (key.name === "n") {
      key.preventDefault();
      request.respond(false);
    } else if (key.name === "y") {
      key.preventDefault();
      setArmedRequest(request);
    } else if ((key.name === "return" || key.name === "enter") && armed) {
      key.preventDefault();
      request.respond(true);
    } else {
      setArmedRequest(null);
      restartQuiet();
    }
  });

  return (
    <Frame>
      <text>
        <em fg={colors.info}>{request.title}</em>
      </text>
      {request.message ? <text attributes={TextAttributes.DIM} wrapMode="char">{request.message}</text> : null}
      <box flexDirection="row" gap={2}>
        {!quiet ? (
          <text attributes={TextAttributes.DIM}>waiting for typing to stop…</text>
        ) : (
          <>
            <text>y</text>
            <text attributes={TextAttributes.DIM}>{armed ? "press Enter to confirm" : "confirm (then Enter)"}</text>
            <text>n</text>
            <text attributes={TextAttributes.DIM}>cancel</text>
          </>
        )}
      </box>
    </Frame>
  );
}

export function InputPrompt({ request, onTextEntryChange }: PromptProps<InputRequest>) {
  const { colors } = useTheme();
  const { isTopLayer } = useKeyboardLayer();
  const { quiet, isQuiet, restart: restartQuiet } = useQuietWindow(request);
  const inputRef = useRef<InputRenderable>(null);
  useOwnEscape(onTextEntryChange);

  useKeyboard((key) => {
    if (!isTopLayer("base") || hasModifier(key)) return;

    if (key.name === "escape") {
      key.preventDefault();
      request.respond(undefined);
    } else if (key.name === "return" || key.name === "enter") {
      key.preventDefault();
      // An Enter that was typed ahead of the prompt must not submit it.
      if (isQuiet()) request.respond(inputRef.current?.value ?? "");
      else restartQuiet();
    }
  });

  return (
    <Frame>
      <text>
        <em fg={colors.info}>{request.title}</em>
      </text>
      <input ref={inputRef} placeholder={request.placeholder ?? ""} focused />
      <text attributes={TextAttributes.DIM}>
        {quiet ? "Enter submits · Esc cancels" : "waiting for typing to stop…"}
      </text>
    </Frame>
  );
}

// Enter submits and Shift+Enter adds a line, as in the main input; the submit itself is handled by the prompt.
const EDITOR_KEY_BINDINGS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "enter", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "enter", shift: true, action: "newline" },
];

export function EditorPrompt({ request, onTextEntryChange }: PromptProps<EditorRequest>) {
  const { colors } = useTheme();
  const { isTopLayer } = useKeyboardLayer();
  const { quiet, isQuiet, restart: restartQuiet } = useQuietWindow(request);
  const editorRef = useRef<TextareaRenderable>(null);
  const prefill = request.prefill ?? "";
  useOwnEscape(onTextEntryChange);

  // Typing continues after the prefill.
  useEffect(() => {
    if (editorRef.current) editorRef.current.cursorOffset = prefill.length;
  }, [prefill]);

  useKeyboard((key) => {
    if (!isTopLayer("base") || hasModifier(key)) return;

    if (key.name === "escape") {
      key.preventDefault();
      request.respond(undefined);
    } else if ((key.name === "return" || key.name === "enter") && !key.shift) {
      key.preventDefault();
      // An Enter that was typed ahead of the prompt must not submit it.
      if (isQuiet()) request.respond(editorRef.current?.plainText ?? prefill);
      else restartQuiet();
    }
  });

  return (
    <Frame>
      <text>
        <em fg={colors.info}>{request.title}</em>
      </text>
      <textarea ref={editorRef} initialValue={prefill} keyBindings={EDITOR_KEY_BINDINGS} focused />
      <text attributes={TextAttributes.DIM}>
        {quiet ? "Enter submits · Shift+Enter adds a line · Esc cancels" : "waiting for typing to stop…"}
      </text>
    </Frame>
  );
}
