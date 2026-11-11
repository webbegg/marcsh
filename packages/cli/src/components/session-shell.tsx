import { TextAttributes } from "@opentui/core";
import type { ReactNode } from "react";
import { InputBar } from "./input-bar";
import { Spinner } from "./spinner";
import { usePromptConfig } from "../providers/prompt-config";

type Props = {
  children?: ReactNode;
  onSubmit: (text: string) => void;
  inputDisabled?: boolean;
  loading?: boolean;
  interruptible?: boolean;
  /** Directory that `@` mentions resolve against; defaults to the process's. */
  cwd?: string;
  /** The engine the session runs on, shown next to the model; defaults to the one new sessions start on. */
  engine?: string;
  /** Text the input mounts with (see InputBar). */
  initialDraft?: string;
  readDraftRef?: { current: (() => string) | null };
  /** The input takes keys but never sends (see InputBar). */
  inputTypeOnly?: boolean;
};

export function SessionShell({
  children,
  onSubmit,
  inputDisabled = false,
  loading = false,
  interruptible = false,
  cwd,
  engine,
  initialDraft,
  readDraftRef,
  inputTypeOnly = false,
}: Props) {
  const { mode } = usePromptConfig();

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      width="100%"
      height="100%"
      paddingY={1}
      paddingX={2}
      gap={1}
    >
      <scrollbox flexGrow={1} width="100%" stickyScroll stickyStart="bottom">
        <box>{children}</box>
      </scrollbox>
      <box flexShrink={0}>
        <InputBar
          onSubmit={onSubmit}
          disabled={inputDisabled}
          cwd={cwd}
          engine={engine}
          initialDraft={initialDraft}
          readDraftRef={readDraftRef}
          typeOnly={inputTypeOnly}
        />
      </box>
      <box
        flexShrink={0}
        flexDirection="row"
        justifyContent="space-between"
        width="100%"
        height={1}
        gap={2}
        paddingLeft={1}
      >
        <box flexDirection="row" alignItems="center" gap={2}>
          {loading ? (
            <>
              <Spinner mode={mode} />
              {interruptible ? <text>esc to interrupt</text> : null}
            </>
          ) : null}
        </box>

        <box flexDirection="row" gap={1} flexShrink={0} marginLeft="auto">
          <text>tab</text>
          <text attributes={TextAttributes.DIM}>agents</text>
        </box>
      </box>
    </box>
  );
};
