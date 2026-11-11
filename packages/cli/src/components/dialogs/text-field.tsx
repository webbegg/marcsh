import { useRef } from "react";
import type { InputRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useKeyboardLayer } from "../../providers/keyboard-layer";

/** A one-line input for a dialog: Enter submits the trimmed text, unless it is empty. */
export function TextField({ placeholder, onSubmit }: { placeholder: string; onSubmit: (value: string) => void }) {
  const inputRef = useRef<InputRenderable>(null);
  const { isTopLayer } = useKeyboardLayer();

  useKeyboard((key) => {
    if (!isTopLayer("dialog") || (key.name !== "return" && key.name !== "enter")) return;
    const value = inputRef.current?.value.trim();
    if (value) onSubmit(value);
  });

  return <input ref={inputRef} focused placeholder={placeholder} />;
}
