import { useCallback, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { escapeTranscriptText } from "../../lib/display-text";
import type { ProfileOutcome } from "../../lib/profiles-command";
import { useDialog } from "../../providers/dialog";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { useTheme } from "../../providers/theme";
import { useToast } from "../../providers/toast";

/** The most lines shown: the routing of a long list of subagents is cut, with a count of the rest. */
const MAX_LINES = 24;

type Props = {
  /** The routing as `/profile` reports it, one line per entry (long ones wrap). Esc closes the dialog. */
  lines: string[];
  /**
   * Given when there is no profiles file: the dialog then offers a confirm row that runs this (it creates a starter file and
   * returns what to show, or why it could not). It is called once; a file that appeared since the offer is never overwritten.
   */
  onCreate?: () => ProfileOutcome;
};

/**
 * `/profile`: which model each part of the session uses and where that comes from. A file's names can hold anything, so the text is
 * escaped before it is drawn. With no profiles file it also offers to create a starter one (Enter, or a click on the row).
 */
export const ProfileDialogContent = ({ lines: initial, onCreate }: Props) => {
  const dialog = useDialog();
  const toast = useToast();
  const { isTopLayer } = useKeyboardLayer();
  const { colors } = useTheme();
  const [lines, setLines] = useState(initial);
  const [offered, setOffered] = useState(onCreate !== undefined);

  const create = useCallback(() => {
    if (!onCreate || !offered) return;
    // One try: the row goes away at once, so a second Enter cannot run it again.
    setOffered(false);
    const outcome = onCreate();
    if ("show" in outcome) {
      setLines(outcome.show);
      return;
    }
    toast.show(outcome.toast);
    dialog.close();
  }, [onCreate, offered, toast, dialog]);

  useKeyboard((key) => {
    if (!isTopLayer("dialog")) return;
    if (key.name === "return" || key.name === "enter") create();
  });

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
      {offered ? (
        <box flexDirection="column" marginTop={1} backgroundColor={colors.selection} onMouseDown={create}>
          <text selectable={false} fg="black">
            {"  Create a starter profiles file"}
          </text>
          <text selectable={false} fg="black" wrapMode="word" width="100%">
            {"  Enter writes it at the path above, with one profile named default. An existing file is never overwritten."}
          </text>
        </box>
      ) : null}
      <text attributes={TextAttributes.DIM}>/profile use &lt;name&gt; · default &lt;name&gt; · clear · esc closes</text>
    </box>
  );
};
