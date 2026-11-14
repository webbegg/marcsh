import { TextAttributes } from "@opentui/core";
import { Mode, type ModeType } from "../../lib/modes";
import { EmptyBorder } from "../border";
import { useTheme } from "../../providers/theme";
import { escapeTranscriptText } from "../../lib/display-text";
import { attachmentLabel } from "../../lib/attachments";
import type { MessageAttachment } from "../../lib/chat-types";

type Props = {
  message: string;
  mode: ModeType;
  /** A small note under the text (for a message typed during a turn). */
  marker?: string;
  /** Not sent yet: shown dim. */
  pending?: boolean;
  /** The files attached to the message, listed under its text. */
  attachments?: MessageAttachment[];
};

export function UserMessage({ message, mode, marker, pending = false, attachments }: Props) {
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
          {message ? <text attributes={pending ? TextAttributes.DIM : undefined}>{escapeTranscriptText(message)}</text> : null}
          {attachments?.map((attachment, index) => (
            <text key={`${index}-${attachment.path}`} attributes={TextAttributes.DIM}>{escapeTranscriptText(attachmentLabel(attachment))}</text>
          ))}
          {marker ? <text attributes={TextAttributes.DIM}>{marker}</text> : null}
        </box>
      </box>
    </box>
  );
};
