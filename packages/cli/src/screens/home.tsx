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
import { userCommandTurn, type CommandTurn } from "../lib/user-commands";
import { TextAttributes } from "@opentui/core";
import { FirstRunCard, NO_MODEL_MESSAGE } from "../components/first-run-card";
import { giveBackText, handOffDraft } from "../lib/prompt-lock";
import { HomeDashboard, type DashboardOption } from "../components/home-dashboard";

type Props = {
  /** Opens on the menu of daily options instead of the input; Esc closes it. The app's route turns it on. */
  dashboard?: boolean;
};

export function Home({ dashboard = false }: Props) {
  const navigate = useNavigate();
  const toast = useToast();
  const dialog = useDialog();
  const renderer = useRenderer();
  const { agent, agents, model, defaultEngine, piModelStatus } = usePromptConfig();
  // Only a settled "none" counts: while the check is still running (`pending`) or has failed (`unavailable`) nothing says there is no
  // model, so Enter keeps working as before and the turn reports what is missing.
  const noModel = defaultEngine === "pi" && piModelStatus === "none";
  const [showDashboard, setShowDashboard] = useState(dashboard);
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

  const commandTurn = useCallback(
    (text: string) =>
      userCommandTurn(text, {
        cwd: process.cwd(),
        engine: defaultEngine,
        agents,
        selected: agent,
        builtinNames: COMMAND_NAMES,
        engineNames: engineCommandNames(defaultEngine),
      }),
    [defaultEngine, agents, agent],
  );

  // Runs `text` as typed, or as the command `turn` is for.
  const startTurn = useCallback(
    (text: string, turn: CommandTurn | null) => {
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
    [navigate, toast, dialog, agent, model],
  );

  // An option runs its command when one by that name is loaded; otherwise the input opens holding the option's starter text. With no
  // model nothing runs: the input opens holding what would have run, where the first-run card and Enter's message say what to do.
  const chooseOption = useCallback(
    (option: DashboardOption) => {
      const invocation = `/${option.command}`;
      const turn = commandTurn(invocation);
      if (turn && !noModel) return startTurn(invocation, turn);
      handOffDraft(renderer, turn ? invocation : option.starter);
      setShowDashboard(false);
    },
    [commandTurn, startTurn, noModel, renderer],
  );

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
      startTurn(text, commandTurn(text));
    },
    [commandTurn, startTurn, noModel, renderer],
  );

  if (showDashboard) {
    return (
      <box alignItems="center" justifyContent="center" flexGrow={1} gap={2} position="relative" width="100%" height="100%">
        <Header />
        <box width="100%" maxWidth={78} paddingX={2} flexDirection="column" gap={1}>
          {noModel ? <FirstRunCard /> : null}
          <HomeDashboard onChoose={chooseOption} onClose={() => setShowDashboard(false)} />
        </box>
      </box>
    );
  }

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
