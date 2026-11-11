import { TextAttributes } from "@opentui/core";
import { useTheme } from "../providers/theme";
import { usePromptConfig } from "../providers/prompt-config";
import { Mode } from "../lib/modes";
import { modelForEngine } from "../lib/models";
import { PI_VERSION } from "../lib/engine/pi-version";

/** The engine as the status line names it, with its version when marcsh knows one (Claude has none of its own). */
const engineLabel = (engineId: string) => (engineId === "pi" ? `pi v${PI_VERSION}` : engineId);

type Props = {
  /** The engine the prompt runs on; defaults to the one new sessions start on. */
  engine?: string;
  /** What the keys do right now, when that is not the usual (typing during a turn). */
  hint?: string;
};

export function StatusBar({ engine, hint }: Props) {
  const { mode, model, piModel, piModelStatus, defaultEngine } = usePromptConfig();
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
      {engineId === "pi" && piModelStatus === "none" ? (
        <text fg={colors.info}>no model · run /login</text>
      ) : engineId === "pi" && piModelStatus === "unavailable" ? (
        <text fg={colors.info}>pi unavailable</text>
      ) : engineId === "pi" && piModelStatus === "pending" ? null : (
        <text>{modelForEngine(engineId, model, piModel)}</text>
      )}
      {/* "pi unavailable" already names the engine. */}
      {engineId === "pi" && piModelStatus === "unavailable" ? null : (
        <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
          · {engineLabel(engineId)}
        </text>
      )}
      {hint ? (
        <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
          · {hint}
        </text>
      ) : null}
    </box>
  );
};
