import { useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { EmptyBorder } from "./border";
import { useQuietWindow } from "../hooks/use-quiet-window";
import { useKeyboardLayer } from "../providers/keyboard-layer";
import { useTheme } from "../providers/theme";
import type { PermissionRequest } from "../hooks/use-chat";
import { escapeProjectText } from "../lib/engine/pi-trust";

const PRIMARY_INPUT_KEYS = ["command", "file_path", "path", "url", "pattern"];
const MAX_DETAIL_LINES = 12;
const DETAIL_LINE_WIDTH = 100;
// Starts every line of a multi-line command after the first, so no line of it can pass for a row of the prompt itself.
const CONTINUATION_GUTTER = "┊ ";

type Props = {
  request: PermissionRequest;
};

/**
 * The lines of text a tool or engine supplied, each escaped (see `escapeProjectText`) so it carries no terminal escape sequence.
 * The real newlines are kept: the lines are split before escaping, one rendered line per real line.
 */
const escapedLines = (text: string) => text.split("\n").map(escapeProjectText);

/** Splits the input into its main field (shown whole, escaped, one entry per real line) and the rest (pretty JSON, capped). */
function describeInput(input: Record<string, unknown>) {
  const primaryKey = PRIMARY_INPUT_KEYS.find((key) => typeof input[key] === "string");
  const primary = primaryKey ? escapedLines(input[primaryKey] as string) : null;
  const rest = Object.fromEntries(Object.entries(input).filter(([key]) => key !== primaryKey));

  if (Object.keys(rest).length === 0) return { primary, detail: [], omitted: 0 };

  // Hard-wrap long lines so the cap counts what is actually drawn and nothing is hidden within a line.
  // The lines are escaped first, so the cap counts what is drawn, and cut by code point, so no character is split.
  const lines = escapedLines(JSON.stringify(rest, null, 2)).flatMap((line) => {
    const chars = Array.from(line);
    const chunks: string[] = [];
    for (let i = 0; i < chars.length; i += DETAIL_LINE_WIDTH) chunks.push(chars.slice(i, i + DETAIL_LINE_WIDTH).join(""));
    return chunks.length > 0 ? chunks : [""];
  });

  return {
    primary,
    detail: lines.slice(0, MAX_DETAIL_LINES),
    omitted: Math.max(0, lines.length - MAX_DETAIL_LINES),
  };
}

export function PermissionPrompt({ request }: Props) {
  const { colors } = useTheme();
  const { isTopLayer } = useKeyboardLayer();
  const [armedRequest, setArmedRequest] = useState<PermissionRequest | null>(null);
  const { quiet, isQuiet, restart: restartQuiet } = useQuietWindow(request);

  const confirmFirst = request.defaultToNo === true;
  const offerAlways = !confirmFirst && !request.suppressAlwaysAllowRule;
  const armed = armedRequest === request;
  const { primary, detail, omitted } = describeInput(request.input);
  const title = escapeProjectText(request.title ?? `Allow ${request.toolName}?`);

  useKeyboard((key) => {
    // Any key before the keyboard is quiet (approval keys included) is ignored and restarts the wait.
    if (!isQuiet() || !isTopLayer("base") || key.ctrl || key.meta || key.option || key.super || key.hyper) {
      setArmedRequest(null);
      restartQuiet();
      return;
    }

    if (key.name === "n") {
      key.preventDefault();
      request.respond("deny");
    } else if (key.name === "y") {
      key.preventDefault();
      if (confirmFirst) setArmedRequest(request);
      else request.respond("allow");
    } else if (key.name === "a" && offerAlways) {
      key.preventDefault();
      request.respond("always");
    } else if ((key.name === "return" || key.name === "enter") && armed) {
      key.preventDefault();
      request.respond("allow");
    } else {
      setArmedRequest(null);
      restartQuiet();
    }
  });

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
        <em fg={colors.info}>{title}</em>
      </text>
      {request.description ? <text attributes={TextAttributes.DIM}>{escapeProjectText(request.description)}</text> : null}
      {request.decisionReason ? <text attributes={TextAttributes.DIM}>Reason: {escapeProjectText(request.decisionReason)}</text> : null}
      {request.blockedPath ? <text attributes={TextAttributes.DIM}>Path: {escapeProjectText(request.blockedPath)}</text> : null}
      {primary?.map((line, index) =>
        index === 0 ? (
          <text key={index} wrapMode="char">{line}</text>
        ) : (
          <box key={index} flexDirection="row">
            <text attributes={TextAttributes.DIM}>{CONTINUATION_GUTTER}</text>
            <text flexGrow={1} flexShrink={1} wrapMode="char">{line}</text>
          </box>
        ),
      )}
      {detail.length > 0 ? (
        <box>
          <text attributes={TextAttributes.DIM} wrapMode="char">{detail.join("\n")}</text>
          {omitted > 0 ? (
            <text attributes={TextAttributes.DIM}>… {omitted} more lines</text>
          ) : null}
        </box>
      ) : null}
      <box flexDirection="row" gap={2}>
        {!quiet ? (
          <text attributes={TextAttributes.DIM}>waiting for typing to stop…</text>
        ) : confirmFirst ? (
          <>
            <text>y</text>
            <text attributes={TextAttributes.DIM}>{armed ? "press Enter to confirm" : "allow once (then Enter)"}</text>
          </>
        ) : (
          <>
            <text>y</text>
            <text attributes={TextAttributes.DIM}>allow once</text>
          </>
        )}
        {quiet && offerAlways ? (
          <>
            <text>a</text>
            <text attributes={TextAttributes.DIM}>always allow</text>
          </>
        ) : null}
        {quiet ? (
          <>
            <text>n</text>
            <text attributes={TextAttributes.DIM}>deny</text>
          </>
        ) : null}
      </box>
    </box>
  );
}
