import { TextAttributes } from "@opentui/core";
import { Mode, type ModeType } from "../../lib/modes";
import { EmptyBorder } from "../border";
import { useTheme } from "../../providers/theme";
import { escapeTranscriptText } from "../../lib/display-text";

type Props = {
  message: string;
  mode: ModeType;
  /** A small note under the text (for a message typed during a turn). */
  marker?: string;
  /** Not sent yet: shown dim. */
  pending?: boolean;
};

export function UserMessage({ message, mode, marker, pending = false }: Props) {
  const { colors } = useTheme();

  return (
    <box width="100%" alignItems="center">
      <box
        border={["left"]}
        borderColor={mode === Mode.PLAN ? colors.planMode : colors.primary}        width="100%"
        customBorderChars={{
          ...EmptyBorder,
          vertical: "┃",
          bottomLeft: "╹",
        }}
      >
        <box
          justifyContent="center"
          paddingX={2}
          paddingY={1}
          backgroundColor={colors.surface}
          width="100%"
        >
          <text attributes={pending ? TextAttributes.DIM : undefined}>{escapeTranscriptText(message)}</text>
          {marker ? <text attributes={TextAttributes.DIM}>{marker}</text> : null}
        </box>
      </box>
    </box>
  );
};
