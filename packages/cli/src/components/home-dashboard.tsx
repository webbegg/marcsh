import { useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useKeyboardLayer } from "../providers/keyboard-layer";
import { useTheme } from "../providers/theme";

export type DashboardOption = {
  label: string;
  /** The command the option runs when one by this name is loaded (the brigadev pack's names). */
  command: string;
  /** What the input holds when no such command is loaded. */
  starter: string;
};

/** The daily options of the home screen's menu, in the order they are shown. */
export const DASHBOARD_OPTIONS: readonly DashboardOption[] = [
  { label: "New feature", command: "feature", starter: "New feature: " },
  { label: "Fix a bug", command: "bug-fix", starter: "Fix a bug: " },
  { label: "Work on a ticket", command: "ticket", starter: "Work on ticket: " },
  { label: "Review a PR", command: "review-branch", starter: "Review PR: " },
];

type Props = {
  onChoose: (option: DashboardOption) => void;
  /** Esc: the caller shows the home screen with the input instead. */
  onClose: () => void;
};

/**
 * The menu the home screen opens on: Up/Down move, Enter chooses, Esc closes it. It takes keys only while nothing is above the base
 * layer, so a dialog opened from it (a command's questions) keeps its own keys.
 */
export function HomeDashboard({ onChoose, onClose }: Props) {
  const [selected, setSelected] = useState(0);
  const { isTopLayer } = useKeyboardLayer();
  const { colors } = useTheme();

  useKeyboard((key) => {
    if (key.defaultPrevented || !isTopLayer("base")) return;
    if (key.name === "escape") {
      key.preventDefault();
      onClose();
    } else if (key.name === "up") {
      key.preventDefault();
      setSelected((index) => (index - 1 + DASHBOARD_OPTIONS.length) % DASHBOARD_OPTIONS.length);
    } else if (key.name === "down") {
      key.preventDefault();
      setSelected((index) => (index + 1) % DASHBOARD_OPTIONS.length);
    } else if (key.name === "return" || key.name === "enter") {
      key.preventDefault();
      onChoose(DASHBOARD_OPTIONS[selected]!);
    }
  });

  return (
    <box flexDirection="column" flexShrink={0} gap={1}>
      <box flexDirection="column">
        {DASHBOARD_OPTIONS.map((option, index) => (
          <box
            key={option.command}
            height={1}
            paddingX={1}
            backgroundColor={index === selected ? colors.selection : undefined}
            onMouseMove={() => setSelected(index)}
            onMouseDown={() => onChoose(option)}
          >
            <text>{option.label}</text>
          </box>
        ))}
      </box>
      <box flexDirection="row" gap={2} flexShrink={0} marginLeft="auto">
        <box flexDirection="row" gap={1} flexShrink={0}>
          <text>↑↓</text>
          <text attributes={TextAttributes.DIM}>choose</text>
        </box>
        <box flexDirection="row" gap={1} flexShrink={0}>
          <text>enter</text>
          <text attributes={TextAttributes.DIM}>start</text>
        </box>
        <box flexDirection="row" gap={1} flexShrink={0}>
          <text>esc</text>
          <text attributes={TextAttributes.DIM}>prompt</text>
        </box>
      </box>
    </box>
  );
}
