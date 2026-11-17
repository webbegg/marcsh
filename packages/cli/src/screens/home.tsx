import { useCallback, useEffect, useRef, useState } from "react";
import { useRenderer } from "@opentui/react";
import { useNavigate } from "react-router";
import { Header } from "../components/header";
import { InputBar } from "../components/input-bar";
import { COMMAND_NAMES } from "../components/command-menu/commands";
import { engineCommandNames } from "../components/command-menu/use-command-menu";
import { openCommandQuestions } from "../components/dialogs/command-questions";
import { PaletteHint } from "../components/palette-hint";
import { usePromptConfig } from "../providers/prompt-config";
import { useDialog } from "../providers/dialog";
import { useToast } from "../providers/toast";
import { userCommandTurn } from "../lib/user-commands";
import { TextAttributes } from "@opentui/core";
import { FirstRunCard, NO_MODEL_MESSAGE } from "../components/first-run-card";
import { giveBackText } from "../lib/prompt-lock";

export function Home() {
  const navigate = useNavigate();
  const toast = useToast();
  const dialog = useDialog();
  const renderer = useRenderer();
  const { agent, agents, model, defaultEngine, piModelStatus } = usePromptConfig();
  // Only a settled "none" counts: while the check is still running (`pending`) or has failed (`unavailable`) nothing says there is no
  // model, so Enter keeps working as before and the turn reports what is missing.
  const noModel = defaultEngine === "pi" && piModelStatus === "none";
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    if (!noModel) setBlocked(false);
  }, [noModel]);
  // The message is about the text that was just refused: it goes once the user changes the input. Putting that text back is not a change.
  const blockedRef = useRef(false);
  const puttingBack = useRef(false);
  const handleTextChange = useCallback(() => {
    if (puttingBack.current || !blockedRef.current) return;
    blockedRef.current = false;
    setBlocked(false);
  }, []);

  const handleSubmit = useCallback(
    (text: string) => {
      // No model: no session is opened and nothing is sent. The input bar has already emptied the input, so the text goes back into it.
      // (marcsh's own commands, like /login and /engine, never get here: the bar runs them itself.)
      if (noModel) {
        puttingBack.current = true;
        giveBackText(renderer, text);
        setTimeout(() => (puttingBack.current = false), 0);
        blockedRef.current = true;
        setBlocked(true);
        return;
      }
      blockedRef.current = false;
      setBlocked(false);
      // One of the user's commands runs as its expanded prompt, as the agent and model it names (a pack's agent stays read-only from Plan:
      // its mode is plan, which the session keeps).
      const turn = userCommandTurn(text, {
        cwd: process.cwd(),
        engine: defaultEngine,
        agents,
        selected: agent,
        builtinNames: COMMAND_NAMES,
        engineNames: engineCommandNames(defaultEngine),
      });
      // A command whose questions are invalid sends nothing, and no session is opened for it.
      if (turn?.error !== undefined) return void toast.show({ variant: "error", message: turn.error });
      const said = [turn?.warning, turn?.notice].filter(Boolean).join(" ");
      if (said) toast.show({ variant: "info", message: said });
      const turnAgent = turn?.agent ?? agent;
      const start = (message: string) =>
        navigate("/sessions/new", {
          state: { message, mode: turnAgent.mode, model, agentId: turnAgent.id, ...(turn?.model ? { agentModel: turn.model } : {}), ...(turnAgent.tools?.deny?.length ? { agentDeny: [...turnAgent.tools.deny] } : {}) },
        });
      // A command with questions asks them here, before any session exists: Esc or Cancel leaves the home screen as it was, and the session's
      // first message is the composed request, never the raw template.
      if (turn?.form) return void openCommandQuestions(dialog, { form: turn.form, cwd: process.cwd(), onStart: start });
      start(turn?.text ?? text);
    },
    [navigate, toast, dialog, agent, agents, model, defaultEngine, noModel, renderer],
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
        {noModel ? <FirstRunCard /> : null}
        <InputBar onSubmit={handleSubmit} onTextChange={handleTextChange} />
        {noModel && blocked ? <text>{NO_MODEL_MESSAGE}</text> : null}
        <box flexDirection="row" gap={2} flexShrink={0} marginLeft="auto">
          <PaletteHint />
          <box flexDirection="row" gap={1} flexShrink={0}>
            <text>tab</text>
            <text attributes={TextAttributes.DIM}>agents</text>
          </box>
        </box>
      </box>
    </box>
  );
};
