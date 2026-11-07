import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { EmptyBorder } from "./border";
import { summarizeToolInput } from "./messages/bot-message";
import { useKeyboardLayer } from "../providers/keyboard-layer";
import { useTheme } from "../providers/theme";
import type { PermissionRequest } from "../hooks/use-chat";

type Props = {
  request: PermissionRequest;
};

export function PermissionPrompt({ request }: Props) {
  const { colors } = useTheme();
  const { isTopLayer } = useKeyboardLayer();

  useKeyboard((key) => {
    if (!isTopLayer("base")) return;

    if (key.name === "y") {
      key.preventDefault();
      request.respond("allow");
    } else if (key.name === "a") {
      key.preventDefault();
      request.respond("always");
    } else if (key.name === "n") {
      key.preventDefault();
      request.respond("deny");
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
      <text attributes={TextAttributes.DIM}>
        <em fg={colors.info}>Allow {request.toolName}?</em> {summarizeToolInput(request.input)}
      </text>
      <box flexDirection="row" gap={2}>
        <text>y</text>
        <text attributes={TextAttributes.DIM}>allow once</text>
        <text>a</text>
        <text attributes={TextAttributes.DIM}>always allow</text>
        <text>n</text>
        <text attributes={TextAttributes.DIM}>deny</text>
      </box>
    </box>
  );
}
