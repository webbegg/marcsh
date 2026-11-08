import { useEffect, useRef, useState } from "react";
import { decodePasteBytes, stripAnsiSequences, TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { useKeyboardLayer } from "../providers/keyboard-layer";

const MAX_DOTS = 40;
// Control characters, including the newline that ends a pasted line.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const PRINTABLE = /^[^\u0000-\u001f\u007f]+$/;

type Props = {
  onSubmit: (value: string) => void;
  placeholder?: string;
};

/**
 * A one-line field that shows a dot for every character instead of the characters, for API keys and
 * pasted authorization codes. OpenTUI's `<input>` has no mask, so keys and pastes are collected here and
 * the value only ever leaves through `onSubmit`.
 */
export function MaskedInput({ onSubmit, placeholder = "" }: Props) {
  const [length, setLength] = useState(0);
  const valueRef = useRef("");
  const { isTopLayer } = useKeyboardLayer();
  const renderer = useRenderer();
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  const change = (next: string) => {
    valueRef.current = next;
    setLength(next.length);
  };

  useKeyboard((key) => {
    if (!isTopLayer("dialog")) return;

    if (key.ctrl || key.meta || key.option || key.super) {
      if (key.ctrl && key.name === "u") change("");
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      const value = valueRef.current.trim();
      if (value) onSubmitRef.current(value);
    } else if (key.name === "backspace" || key.name === "delete") {
      change(valueRef.current.slice(0, -1));
    } else if (key.sequence && PRINTABLE.test(key.sequence)) {
      change(valueRef.current + key.sequence);
    }
  });

  // A paste arrives as one event, not as keys.
  useEffect(() => {
    const onPaste = (event: { bytes: Uint8Array; preventDefault(): void }) => {
      event.preventDefault();
      change(valueRef.current + stripAnsiSequences(decodePasteBytes(event.bytes)).replace(CONTROL_CHARACTERS, ""));
    };
    renderer.keyInput.on("paste", onPaste);
    return () => {
      renderer.keyInput.off("paste", onPaste);
    };
  }, [renderer]);

  return (
    <box flexDirection="row" gap={1} height={1}>
      {length === 0 ? (
        <text attributes={TextAttributes.DIM}>{placeholder}</text>
      ) : (
        <>
          <text>{"•".repeat(Math.min(length, MAX_DOTS))}</text>
          <text attributes={TextAttributes.DIM}>({length} characters)</text>
        </>
      )}
    </box>
  );
}
