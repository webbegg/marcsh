import { useCallback } from "react";
import { useNavigate } from "react-router";
import { Header } from "../components/header";
import { InputBar } from "../components/input-bar";
import { COMMAND_NAMES } from "../components/command-menu/commands";
import { usePromptConfig } from "../providers/prompt-config";
import { useToast } from "../providers/toast";
import { userCommandTurn } from "../lib/user-commands";
import { TextAttributes } from "@opentui/core";

export function Home() {
  const navigate = useNavigate();
  const toast = useToast();
  const { agent, agents, model, defaultEngine } = usePromptConfig();

  const handleSubmit = useCallback(
    (text: string) => {
      // One of the user's commands runs as its expanded prompt, as the agent and model it names.
      const turn = userCommandTurn(text, { cwd: process.cwd(), engine: defaultEngine, agents, builtinNames: COMMAND_NAMES });
      if (turn?.warning) toast.show({ variant: "info", message: turn.warning });
      const turnAgent = turn?.agent ?? agent;
      navigate("/sessions/new", {
        state: { message: turn?.text ?? text, mode: turnAgent.mode, model, agentId: turnAgent.id, ...(turn?.model ? { agentModel: turn.model } : {}) },
      });
    },
    [navigate, toast, agent, agents, model, defaultEngine],
  );

  return (
    <box
      alignItems="center"
      justifyContent="center"
      flexGrow={1}
      gap={2}
      position="relative"
      width="100%"
      height="100%"
    >
      <Header />
      <box width="100%" maxWidth={78} paddingX={2} flexDirection="column" gap={1}>
        <InputBar onSubmit={handleSubmit} />
        <box flexDirection="row" gap={1} flexShrink={0} marginLeft="auto">
          <text>tab</text>
          <text attributes={TextAttributes.DIM}>agents</text>
        </box>
      </box>
    </box>
  );
};
