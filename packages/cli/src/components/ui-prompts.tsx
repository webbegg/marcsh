import { useEffect, useRef, useState, type ReactNode } from "react";
import { TextAttributes, type InputRenderable, type KeyBinding, type TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { EmptyBorder } from "./border";
import { useQuietWindow } from "../hooks/use-quiet-window";
import { useKeyboardLayer } from "../providers/keyboard-layer";
import { LOCKED_LINE, usePromptLock } from "../lib/prompt-lock";
import { useTheme } from "../providers/theme";
import type { ConfirmRequest, EditorRequest, InputRequest, SelectRequest } from "../hooks/use-chat";

// Compact prompts for the dialogs an engine's extensions open (pi: select, confirm, input, editor). Like the
// approval and question prompts they sit in the conversation and ignore keys until the keyboard has been quiet.

const MAX_VISIBLE_OPTIONS = 8;
const MAX_QUICK_PICK = 9;

// Every dialog starts with this line, so an extension's "Allow bash?" cannot pass as marcsh's own approval prompt.
// pi gives its UI context no extension name, so the line cannot say which extension asks.
export const EXTENSION_LABEL = "pi extension asks";

// Strings that end at BEL or ST (OSC, DCS, SOS, PM, APC), then CSI, then other ESC sequences, then any control left.
const CONTROL_SEQUENCES: RegExp[] = [
  /(?:\u001b[\]PX^_]|[\u0090\u0098\u009d\u009e\u009f])[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g,
  /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g,
  /\u001b[ -/]*[0-~]/g,
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
];

/**
 * Text from an extension as it may reach the terminal: C0 controls (except newline and tab), ESC sequences
 * (colors, cursor moves, window titles, links) and C1 controls are removed, the text between them stays.
 */
export function stripControlChars(text: string): string {
  return CONTROL_SEQUENCES.reduce((clean, pattern) => clean.replace(pattern, ""), text);
}

type PromptProps<R> = {
  request: R;
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
      <text attributes={TextAttributes.BOLD | TextAttributes.DIM}>{EXTENSION_LABEL}</text>
      {children}
    </box>
  );
}

// Esc on any of these prompts cancels the ask, and the session's own Esc handler also interrupts the turn, as it does
// on an approval or a question: an extension that asks again cannot trap the session.
// A prompt that opens while the user is composing is locked (see `usePromptLock`): only Esc and ↓ do anything, and ↓
// unlocks it with a fresh quiet window; text fields stay unfocused so typing ahead goes nowhere.
const unlocksPrompt = (key: { name: string }, isTopLayer: boolean) => key.name === "down" && isTopLayer;
const hasModifier = (key: { ctrl: boolean; meta: boolean; option: boolean; super?: boolean; hyper?: boolean }) =>
  key.ctrl || key.meta || key.option || key.super || key.hyper;

export function SelectPrompt({ request }: PromptProps<SelectRequest>) {
  const { colors } = useTheme();
  const { isTopLayer } = useKeyboardLayer();
  const { quiet, isQuiet, restart: restartQuiet } = useQuietWindow(request);
  const lock = usePromptLock(request);
  const [index, setIndex] = useState(0);
  const { options } = request;

  useKeyboard((key) => {
    if (!isTopLayer("base") || hasModifier(key)) {
      restartQuiet();
      return;
    }

    // Moving the highlight and cancelling are harmless, so they work at once; while locked, ↓ unlocks instead of moving.
    if (key.name === "escape") {
      key.preventDefault();
      request.respond(undefined);
    } else if (key.name === "up") {
      key.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (key.name === "down") {
      key.preventDefault();
      if (lock.isLocked()) {
        lock.unlock();
        restartQuiet();
      } else setIndex((i) => Math.min(options.length - 1, i + 1));
    } else if (lock.isLocked()) {
      // Nothing else answers it until ↓.
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
        <em fg={colors.info}>{stripControlChars(request.title)}</em>
      </text>
      {start > 0 ? <text attributes={TextAttributes.DIM}>↑ {start} more</text> : null}
      {visible.map((option, offset) => {
        const i = start + offset;
        return (
          <text key={i} attributes={i === index ? TextAttributes.BOLD : undefined}>
            {i === index ? "› " : "  "}
            {i < MAX_QUICK_PICK ? `${i + 1} ` : ""}
            {stripControlChars(option)}
          </text>
        );
      })}
      {below > 0 ? <text attributes={TextAttributes.DIM}>↓ {below} more</text> : null}
      <text attributes={TextAttributes.DIM}>
        {lock.locked
          ? `${LOCKED_LINE} · Esc cancels and stops the turn`
          : quiet
            ? "↑/↓ move · Enter selects · 1-9 pick · Esc cancels and stops the turn"
            : "waiting for typing to stop…"}
      </text>
    </Frame>
  );
}

/**
 * Extensions use `confirm` to gate things that can hurt, so it follows the approval prompt's rules for a
 * default-no ask: keys count only after the quiet window, `y` alone confirms nothing (it arms Enter), and
 * any other key disarms it.
 */
export function ConfirmPrompt({ request }: PromptProps<ConfirmRequest>) {
  const { colors } = useTheme();
  const { isTopLayer } = useKeyboardLayer();
  const { quiet, isQuiet, restart: restartQuiet } = useQuietWindow(request);
  const lock = usePromptLock(request);
  const [armedRequest, setArmedRequest] = useState<ConfirmRequest | null>(null);
  const armed = armedRequest === request;

  useKeyboard((key) => {
    if (isTopLayer("base") && !hasModifier(key) && key.name === "escape") {
      key.preventDefault();
      request.respond(false);
      return;
    }

    if (lock.isLocked()) {
      if (!hasModifier(key) && unlocksPrompt(key, isTopLayer("base"))) {
        key.preventDefault();
        lock.unlock();
        restartQuiet();
      }
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
        <em fg={colors.info}>{stripControlChars(request.title)}</em>
      </text>
      {request.message ? <text attributes={TextAttributes.DIM} wrapMode="char">{stripControlChars(request.message)}</text> : null}
      <box flexDirection="row" gap={2}>
        {lock.locked ? (
          <>
            <text attributes={TextAttributes.DIM}>y confirm (then Enter)</text>
            <text attributes={TextAttributes.DIM}>n cancel</text>
            <text attributes={TextAttributes.DIM}>Esc cancel and stop the turn</text>
            <text>{LOCKED_LINE}</text>
          </>
        ) : !quiet ? (
          <text attributes={TextAttributes.DIM}>waiting for typing to stop…</text>
        ) : (
          <>
            <text>y</text>
            <text attributes={TextAttributes.DIM}>{armed ? "press Enter to confirm" : "confirm (then Enter)"}</text>
            <text>n</text>
            <text attributes={TextAttributes.DIM}>cancel</text>
            <text>Esc</text>
            <text attributes={TextAttributes.DIM}>cancel and stop the turn</text>
          </>
        )}
      </box>
    </Frame>
  );
}

export function InputPrompt({ request }: PromptProps<InputRequest>) {
  const { colors } = useTheme();
  const { isTopLayer } = useKeyboardLayer();
  const { quiet, isQuiet, restart: restartQuiet } = useQuietWindow(request);
  const lock = usePromptLock(request);
  const inputRef = useRef<InputRenderable>(null);

  useKeyboard((key) => {
    if (!isTopLayer("base") || hasModifier(key)) return;

    if (key.name === "escape") {
      key.preventDefault();
      request.respond(undefined);
    } else if (lock.isLocked()) {
      if (unlocksPrompt(key, true)) {
        key.preventDefault();
        lock.unlock();
        restartQuiet();
      }
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
        <em fg={colors.info}>{stripControlChars(request.title)}</em>
      </text>
      <input ref={inputRef} placeholder={stripControlChars(request.placeholder ?? "")} focused={!lock.locked} />
      <text attributes={TextAttributes.DIM}>
        {lock.locked
          ? `${LOCKED_LINE} · Esc cancels and stops the turn`
          : quiet
            ? "Enter submits · Esc cancels and stops the turn"
            : "waiting for typing to stop…"}
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

export function EditorPrompt({ request }: PromptProps<EditorRequest>) {
  const { colors } = useTheme();
  const { isTopLayer } = useKeyboardLayer();
  const { quiet, isQuiet, restart: restartQuiet } = useQuietWindow(request);
  const lock = usePromptLock(request);
  const editorRef = useRef<TextareaRenderable>(null);
  const prefill = stripControlChars(request.prefill ?? "");

  // Typing continues after the prefill.
  useEffect(() => {
    if (editorRef.current) editorRef.current.cursorOffset = prefill.length;
  }, [prefill]);

  useKeyboard((key) => {
    if (!isTopLayer("base") || hasModifier(key)) return;

    if (key.name === "escape") {
      key.preventDefault();
      request.respond(undefined);
    } else if (lock.isLocked()) {
      if (unlocksPrompt(key, true)) {
        key.preventDefault();
        lock.unlock();
        restartQuiet();
      }
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
        <em fg={colors.info}>{stripControlChars(request.title)}</em>
      </text>
      <textarea ref={editorRef} initialValue={prefill} keyBindings={EDITOR_KEY_BINDINGS} focused={!lock.locked} />
      <text attributes={TextAttributes.DIM}>
        {lock.locked
          ? `${LOCKED_LINE} · Esc cancels and stops the turn`
          : quiet
            ? "Enter submits · Shift+Enter adds a line · Esc cancels and stops the turn"
            : "waiting for typing to stop…"}
      </text>
    </Frame>
  );
}
