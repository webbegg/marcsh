import { useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useDialog } from "../../providers/dialog";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { useTheme } from "../../providers/theme";

type Props = {
  /** What is about to happen, one line per entry (long ones wrap). */
  lines: string[];
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  /** Runs after the dialog closed on Cancel and on `n`; Esc only closes the dialog. */
  onCancel?: () => void;
};

/**
 * A question with two answers. Cancel is the row selected when it opens, so a key held down from the list that opened it never
 * confirms: Down then Enter does. `n` cancels.
 */
export const ConfirmDialogContent = ({ lines, confirmLabel, cancelLabel = "Cancel", onConfirm, onCancel }: Props) => {
  const dialog = useDialog();
  const { isTopLayer } = useKeyboardLayer();
  const { colors } = useTheme();
  const [selected, setSelected] = useState(0);
  const answers = [
    { label: cancelLabel, run: () => onCancel?.() },
    { label: confirmLabel, run: onConfirm },
  ];

  const answer = (index: number) => {
    dialog.close();
    answers[index]!.run();
  };

  useKeyboard((key) => {
    if (!isTopLayer("dialog")) return;
    if (key.name === "up") setSelected(0);
    else if (key.name === "down") setSelected(1);
    else if (key.name === "return" || key.name === "enter") answer(selected);
    else if (key.name === "n" && !key.ctrl && !key.meta) answer(0);
  });

  return (
    <box flexDirection="column" gap={1}>
      {lines.map((line, index) => (
        <text key={index} wrapMode="word" width="100%">
          {line}
        </text>
      ))}
      <box flexDirection="column">
        {answers.map((entry, index) => (
          <box
            key={entry.label}
            flexDirection="row"
            height={1}
            backgroundColor={index === selected ? colors.selection : undefined}
            onMouseMove={() => setSelected(index)}
            onMouseDown={() => answer(index)}
          >
            <text selectable={false} fg={index === selected ? "black" : "white"}>
              {entry.label}
            </text>
          </box>
        ))}
      </box>
      <text attributes={TextAttributes.DIM}>↑↓ choose · enter confirm · n cancel</text>
    </box>
  );
};
