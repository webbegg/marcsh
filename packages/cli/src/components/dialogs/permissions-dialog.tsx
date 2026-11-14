import { useCallback, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useDialog } from "../../providers/dialog";
import { useToast } from "../../providers/toast";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { useTheme } from "../../providers/theme";
import { APPROVAL_MODES, type ApprovalMode } from "../../lib/approval-policy";
import { branchState } from "../../lib/git-branch";
import { defaultModeMessage, sessionModeMessage } from "../command-menu/permissions-command";

export const MODE_DESCRIPTIONS: Record<ApprovalMode, string> = {
  normal: "asks before edits and commands, as before",
  auto: "on a feature branch: edits and ordinary commands run; commits and remote actions ask",
  yolo: "on a feature branch: as auto, and local commits run; remote actions and leaving the branch ask",
};

type Row = { kind: "mode"; mode: ApprovalMode } | { kind: "default"; mode: ApprovalMode };

type PermissionsDialogContentProps = {
  currentMode: ApprovalMode;
  /** The mode saved for new sessions. */
  defaultMode: ApprovalMode;
  /** The folder the session works in: auto and yolo are paused when it is not on a feature branch, and the toast says so. */
  cwd: string;
  onSelectMode: (mode: ApprovalMode) => void;
  onSelectDefault: (mode: ApprovalMode) => void;
};

export const PermissionsDialogContent = ({
  currentMode,
  defaultMode,
  cwd,
  onSelectMode,
  onSelectDefault,
}: PermissionsDialogContentProps) => {
  const dialog = useDialog();
  const toast = useToast();
  const { isTopLayer } = useKeyboardLayer();
  const { colors } = useTheme();
  const [selectedIndex, setSelectedIndex] = useState(0);

  const rows: Row[] = [
    ...APPROVAL_MODES.map((mode): Row => ({ kind: "mode", mode })),
    ...(currentMode !== defaultMode ? [{ kind: "default", mode: currentMode } satisfies Row] : []),
  ];

  const choose = useCallback(
    (row: Row) => {
      if (row.kind === "mode") {
        onSelectMode(row.mode);
        toast.show({ variant: "success", message: sessionModeMessage(row.mode, branchState(cwd)) });
      } else {
        onSelectDefault(row.mode);
        toast.show({ variant: "success", message: defaultModeMessage(row.mode) });
      }
      dialog.close();
    },
    [dialog, toast, cwd, onSelectMode, onSelectDefault],
  );

  useKeyboard((key) => {
    if (!isTopLayer("dialog")) return;
    if (key.name === "up") {
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (key.name === "down") {
      setSelectedIndex((i) => Math.min(rows.length - 1, i + 1));
    } else if (key.name === "return" || key.name === "enter") {
      const row = rows[selectedIndex];
      if (row) choose(row);
    }
  });

  return (
    <box flexDirection="column" gap={1}>
      {rows.map((row, i) => {
        const isSelected = i === selectedIndex;
        const key = `${row.kind}-${row.mode}`;
        return (
          <box
            key={key}
            flexDirection="column"
            backgroundColor={isSelected ? colors.selection : undefined}
            onMouseMove={() => setSelectedIndex(i)}
            onMouseDown={() => choose(row)}
          >
            <text selectable={false} fg={isSelected ? "black" : "white"}>
              {row.kind === "mode" ? `${row.mode === currentMode ? " • " : "   "}${row.mode}` : `   Use ${row.mode} for new sessions`}
            </text>
            {row.kind === "mode" ? (
              <text selectable={false} attributes={isSelected ? undefined : TextAttributes.DIM} fg={isSelected ? "black" : "gray"}>
                {`   ${MODE_DESCRIPTIONS[row.mode]}`}
              </text>
            ) : null}
          </box>
        );
      })}
    </box>
  );
};
