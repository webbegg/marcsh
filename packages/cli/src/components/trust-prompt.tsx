import { useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { EmptyBorder } from "./border";
import { stripControlChars } from "./ui-prompts";
import { useQuietWindow } from "../hooks/use-quiet-window";
import { useKeyboardLayer } from "../providers/keyboard-layer";
import { useTheme } from "../providers/theme";
import type { TrustRequest } from "../hooks/use-chat";

const MAX_LISTED = 12;

type Props = {
  request: TrustRequest;
};

/**
 * marcsh's own question before pi loads a project's pi files (extensions, MCP servers, settings...): what the folder
 * holds, then `t` to trust (arms Enter), `d` not to, Esc to leave this one turn untrusted without remembering.
 * Like an approval it ignores keys until the keyboard has been quiet, so typing ahead cannot answer it, and
 * `t` alone trusts nothing: trusting lets the project's code run. Everything shown comes from the project, so
 * terminal controls are stripped.
 */
export function TrustPrompt({ request }: Props) {
  const { colors } = useTheme();
  const { isTopLayer } = useKeyboardLayer();
  const { quiet, isQuiet, restart: restartQuiet } = useQuietWindow(request);
  const [armedRequest, setArmedRequest] = useState<TrustRequest | null>(null);
  const armed = armedRequest === request;

  useKeyboard((key) => {
    const modified = key.ctrl || key.meta || key.option || key.super || key.hyper;

    // Not now: harmless, so it works at once. The turn goes on with the project's files unloaded.
    if (isTopLayer("base") && !modified && key.name === "escape") {
      key.preventDefault();
      request.respond("skip");
      return;
    }

    // Any key before the keyboard is quiet (answer keys included) is ignored and restarts the wait.
    if (!isQuiet() || !isTopLayer("base") || modified) {
      setArmedRequest(null);
      restartQuiet();
      return;
    }

    if (key.name === "d") {
      key.preventDefault();
      request.respond("distrust");
    } else if (key.name === "t") {
      key.preventDefault();
      setArmedRequest(request);
    } else if ((key.name === "return" || key.name === "enter") && armed) {
      key.preventDefault();
      request.respond("trust");
    } else {
      setArmedRequest(null);
      restartQuiet();
    }
  });

  const listed = request.resources.slice(0, MAX_LISTED);
  const omitted = request.resources.length - listed.length;

  return (
    <box
      border={["left"]}
      borderColor={colors.info}
      customBorderChars={{
        ...EmptyBorder,
        vertical: "│",
      }}
      width="100%"
      paddingX={2}
    >
      <text>
        <em fg={colors.info}>Trust this project&apos;s pi files?</em>
      </text>
      <text attributes={TextAttributes.DIM} wrapMode="char">
        {stripControlChars(request.cwd)}
      </text>
      {listed.map((resource, i) => (
        <text key={i} wrapMode="char">
          {stripControlChars(resource.detail ? `${resource.path} — ${resource.detail}` : resource.path)}
        </text>
      ))}
      {omitted > 0 ? <text attributes={TextAttributes.DIM}>… and {omitted} more</text> : null}
      <text attributes={TextAttributes.DIM}>Trusting lets pi load these files and run their code with your permissions.</text>
      <box flexDirection="row" gap={2}>
        {!quiet ? (
          <text attributes={TextAttributes.DIM}>waiting for typing to stop…</text>
        ) : (
          <>
            <text>t</text>
            <text attributes={TextAttributes.DIM}>{armed ? "press Enter to trust" : "trust (then Enter)"}</text>
            <text>d</text>
            <text attributes={TextAttributes.DIM}>don&apos;t trust</text>
            <text>Esc</text>
            <text attributes={TextAttributes.DIM}>not now (this turn only)</text>
          </>
        )}
      </box>
    </box>
  );
}
