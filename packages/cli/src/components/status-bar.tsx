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

/** The engine as the status line names it, with its version when marcsh knows one (Claude has none of its own). */
const engineLabel = (engineId: string) => (engineId === "pi" ? `pi v${PI_VERSION}` : engineId);

type Props = {
  /** The engine the prompt runs on; defaults to the one new sessions start on. */
  engine?: string;
  /** The session's messages, for the tokens in context, context % of the window and cost the engines reported; none shown when they reported nothing. */
  messages?: readonly ChatMessage[];
  /** What the keys do right now, when that is not the usual (typing during a turn). Several wordings, longest first: the first that fits the line is shown, none if even the last does not. */
  hint?: string | readonly string[];
};

export function StatusBar({ engine, messages, hint }: Props) {
  const { agent, agents, mode, model, piModel, piModelStatus, defaultEngine } = usePromptConfig();
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

  // The row lays out its items side by side with one space between; a hint that does not fit would wrap the whole line, so it is
  // dropped (the engine label never is). Until the row is measured the widest wording is shown.
  const items = [modeText, "›", modelText, engineText].filter((item): item is string => item !== null);
  const baseUsed = items.reduce((sum, item) => sum + item.length, 0) + items.length - 1;
  // The usage goes before the hint and is dropped first when it does not fit, so the line never wraps.
  const usageText = useMemo(() => (messages ? formatUsage(sessionUsage(messages)) : ""), [messages]);
  const usageShown = usageText !== "" && (width === null || baseUsed + 1 + 2 + usageText.length <= width);
  const used = baseUsed + (usageShown ? 1 + 2 + usageText.length : 0);
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
      {usageShown ? (
        <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
          · {usageText}
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
