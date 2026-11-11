import { TextAttributes } from "@opentui/core";
import { useTheme } from "../providers/theme";
import { usePromptConfig } from "../providers/prompt-config";
import { Mode } from "../lib/modes";
import { modelForEngine } from "../lib/models";
import { agentLabel } from "../lib/agents";

type Props = {
  /** The engine the prompt runs on; defaults to the one new sessions start on. */
  engine?: string;
};

export function StatusBar({ engine }: Props) {
  const { agent, agents, mode, model, piModel, piModelStatus, defaultEngine } = usePromptConfig();
  const engineId = engine ?? defaultEngine;
  const { colors } = useTheme();

  return (
    <box flexDirection="row" gap={1}>
      
      <text fg={mode === Mode.PLAN ? colors.planMode : colors.primary}>
        {agentLabel(agent, agents)}
      </text>

      <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
        ›
      </text>
      {engineId === "pi" && piModelStatus === "none" ? (
        <text fg={colors.info}>no model · run /login</text>
      ) : engineId === "pi" && piModelStatus === "unavailable" ? (
        <text fg={colors.info}>pi unavailable</text>
      ) : engineId === "pi" && piModelStatus === "pending" ? null : (
        <text>{modelForEngine(engineId, model, piModel)}</text>
      )}
      {/* Claude sessions look as they always did; only another engine is named. */}
      {engineId === "claude" || (engineId === "pi" && piModelStatus === "unavailable") ? null : (
        <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
          · {engineId}
        </text>
      )}
    </box>
  );
};
