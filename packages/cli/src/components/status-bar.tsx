import { TextAttributes } from "@opentui/core";
import { useTheme } from "../providers/theme";
import { usePromptConfig } from "../providers/prompt-config";
import { Mode } from "../lib/modes";
import { modelForEngine } from "../lib/models";

type Props = {
  /** The engine the prompt runs on; defaults to the one new sessions start on. */
  engine?: string;
};

export function StatusBar({ engine }: Props) {
  const { mode, model, defaultEngine } = usePromptConfig();
  const engineId = engine ?? defaultEngine;
  const { colors } = useTheme();

  return (
    <box flexDirection="row" gap={1}>
      
      <text fg={mode === Mode.PLAN ? colors.planMode : colors.primary}>
        {mode === Mode.PLAN ? "Plan" : "Build"}
      </text>

      <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
        ›
      </text>
      <text>{modelForEngine(engineId, model)}</text>
      {/* Claude sessions look as they always did; only another engine is named. */}
      {engineId === "claude" ? null : (
        <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
          · {engineId}
        </text>
      )}
    </box>
  );
};
