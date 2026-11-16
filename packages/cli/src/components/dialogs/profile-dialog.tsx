import { TextAttributes } from "@opentui/core";
import { escapeTranscriptText } from "../../lib/display-text";

/** The most lines shown: the routing of a long list of subagents is cut, with a count of the rest. */
const MAX_LINES = 24;

type Props = {
  /** The routing as `/profile` reports it, one line per entry (long ones wrap). Esc closes the dialog. */
  lines: string[];
};

/**
 * `/profile`: which model each part of the session uses and where that comes from. A file's names can hold anything, so the text is
 * escaped before it is drawn.
 */
export const ProfileDialogContent = ({ lines }: Props) => {
  const shown = lines.slice(0, MAX_LINES);
  const rest = lines.length - shown.length;
  return (
    <box flexDirection="column" gap={0}>
      {shown.map((line, index) => (
        <text key={index} wrapMode="word" width="100%">
          {escapeTranscriptText(line)}
        </text>
      ))}
      {rest > 0 && <text attributes={TextAttributes.DIM}>{`…and ${rest} more`}</text>}
      <text attributes={TextAttributes.DIM}>/profile use &lt;name&gt; · default &lt;name&gt; · clear · esc closes</text>
    </box>
  );
};
