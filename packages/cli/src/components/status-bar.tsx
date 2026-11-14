import { useMemo, useRef, useState } from "react";
import { TextAttributes } from "@opentui/core";
import type { BoxRenderable } from "@opentui/core";
import { useTheme } from "../providers/theme";
import { usePromptConfig } from "../providers/prompt-config";
import { Mode } from "../lib/modes";
import { modelForEngine } from "../lib/models";
import { agentLabel } from "../lib/agents";
import { PI_VERSION } from "../lib/engine/pi-version";
import type { ChatMessage } from "../lib/chat-types";
import { formatUsage, sessionUsage } from "../lib/usage";
import { formatGit } from "../lib/git-status";
import { escapeTranscriptText } from "../lib/display-text";
import { useGitStatus, type GitReader } from "../hooks/use-git-status";

/** The engine as the status line names it, with its version when marcsh knows one (Claude has none of its own). */
const engineLabel = (engineId: string) => (engineId === "pi" ? `pi v${PI_VERSION}` : engineId);

type Props = {
  /** The engine the prompt runs on; defaults to the one new sessions start on. */
  engine?: string;
  /** The session's messages, for the tokens in context, context % of the window and cost the engines reported; none shown when they reported nothing. */
  messages?: readonly ChatMessage[];
  /** What the keys do right now, when that is not the usual (typing during a turn). Several wordings, longest first: the first that fits the line is shown, none if even the last does not. */
  hint?: string | readonly string[];
  /** The project folder, for its git branch and (once the project is trusted) changed files; no git segment without one. */
  cwd?: string;
  /** Reads the git state of a folder; injectable so screen tests do not spawn git. */
  readGit?: GitReader;
  /** What runs in the background (`2 background terminals running · /ps`); none when empty. The first segment dropped when narrow. */
  background?: string;
};

/** Changes after each tool call ends and each new message, so the git segment is read again then. */
const finishedToolCalls = (messages: readonly ChatMessage[] | undefined) =>
  (messages ?? []).reduce(
    (count, message) => count + 1 + message.parts.filter((part) => part.type === "tool" && part.state !== "running").length,
    0,
  );

export function StatusBar({ engine, messages, hint, cwd, readGit, background }: Props) {
  const { agent, agents, mode, model, piModel, piModelStatus, defaultEngine, approvalMode } = usePromptConfig();
  const engineId = engine ?? defaultEngine;
  const { colors } = useTheme();
  const rowRef = useRef<BoxRenderable>(null);
  const [width, setWidth] = useState<number | null>(null);

  const modeText = agentLabel(agent, agents);
  const modelText =
    engineId === "pi" && piModelStatus === "none"
      ? "no model · run /login"
      : engineId === "pi" && piModelStatus === "unavailable"
        ? "pi unavailable"
        : engineId === "pi" && piModelStatus === "pending"
          ? null
          : modelForEngine(engineId, model, piModel);
  // "pi unavailable" already names the engine.
  const engineText = engineId === "pi" && piModelStatus === "unavailable" ? null : `· ${engineLabel(engineId)}`;

  // Normal mode, the usual one, is not shown.
  const approvalText = approvalMode === "normal" ? null : `· ${approvalMode}`;

  // The row lays out its items side by side with one space between; a hint that does not fit would wrap the whole line, so it is
  // dropped (the engine label never is). Until the row is measured the widest wording is shown.
  // The approval mode is a safety signal, so it is never dropped; the usage is.
  const items = [modeText, "›", modelText, engineText, approvalText].filter((item): item is string => item !== null);
  const baseUsed = items.reduce((sum, item) => sum + item.length, 0) + items.length - 1;
  // The usage and then git go before the hint. When the line is too narrow the usage is dropped first, then git, so it never wraps.
  const usageText = useMemo(() => (messages ? formatUsage(sessionUsage(messages)) : ""), [messages]);
  const toolCalls = useMemo(() => finishedToolCalls(messages), [messages]);
  const git = useGitStatus(cwd, { read: readGit, trigger: toolCalls });
  // The branch name comes from the folder, which may be untrusted: what could act on the terminal shows as an escape.
  const gitText = git ? formatGit({ ...git, branch: escapeTranscriptText(git.branch) }) : "";
  const gitShown = gitText !== "" && (width === null || baseUsed + 1 + 2 + gitText.length <= width);
  const withGit = baseUsed + (gitShown ? 1 + 2 + gitText.length : 0);
  const usageShown = usageText !== "" && (width === null || withGit + 1 + 2 + usageText.length <= width);
  const withUsage = withGit + (usageShown ? 1 + 2 + usageText.length : 0);
  // The background segment goes before usage and git when the line is too narrow.
  const backgroundShown = !!background && (width === null || withUsage + 1 + 2 + background.length <= width);
  const used = withUsage + (backgroundShown ? 1 + 2 + background.length : 0);
  const wordings = hint === undefined ? [] : typeof hint === "string" ? [hint] : hint;
  const shown = wordings.find((wording) => wording.length > 0 && (width === null || used + 1 + 2 + wording.length <= width));

  return (
    <box ref={rowRef} flexDirection="row" gap={1} onSizeChange={() => setWidth(rowRef.current?.width ?? null)}>
      
      <text fg={mode === Mode.PLAN ? colors.planMode : colors.primary}>
        {modeText}
      </text>

      <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
        ›
      </text>
      {modelText === null ? null : engineId === "pi" && (piModelStatus === "none" || piModelStatus === "unavailable") ? (
        <text fg={colors.info}>{modelText}</text>
      ) : (
        <text>{modelText}</text>
      )}
      {engineText === null ? null : (
        <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
          {engineText}
        </text>
      )}
      {approvalText === null ? null : (
        // The theme has no warning colour: auto is noted (info), yolo is flagged (error).
        <text fg={approvalMode === "yolo" ? colors.error : colors.info}>{approvalText}</text>
      )}
      {usageShown ? (
        <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
          · {usageText}
        </text>
      ) : null}
      {gitShown ? (
        <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
          · {gitText}
        </text>
      ) : null}
      {backgroundShown ? (
        <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
          · {background}
        </text>
      ) : null}
      {shown ? (
        <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
          · {shown}
        </text>
      ) : null}
    </box>
  );
};
