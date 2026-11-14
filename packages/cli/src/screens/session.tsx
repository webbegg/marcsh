import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useParams, useLocation, useNavigate } from "react-router";
import { z } from "zod";
import { useKeyboard, useRenderer } from "@opentui/react";
import type { ModeType } from "../lib/modes";
import { agentModelFits, builtinAgentId, findAgent, type Agent } from "../lib/agents";
import { SessionShell } from "../components/session-shell";
import { TurnInputContext } from "../components/input-bar";
import { 
  UserMessage, 
  BotMessage, 
  ErrorMessage
} from "../components/messages";
import { PermissionPrompt } from "../components/permission-prompt";
import { QuestionPrompt } from "../components/question-prompt";
import { TrustPrompt } from "../components/trust-prompt";
import { ConfirmPrompt, EditorPrompt, InputPrompt, SelectPrompt, stripControlChars } from "../components/ui-prompts";
import { useToast } from "../providers/toast";
import { useChat } from "../hooks/use-chat";
import { useSessionCommands } from "../hooks/use-session-commands";
import { usePromptConfig } from "../providers/prompt-config";
import type { ChatMessage as ChatMessageData } from "../lib/chat-types";
import { getStorage, type StoredSession } from "../lib/storage";
import { getEngine, unknownEngine, warmUpEngineCommands } from "../lib/engine";
import type { NoticeLevel } from "../lib/engine/types";
import { modelForEngine } from "../lib/models";
import { useKeyboardLayer } from "../providers/keyboard-layer";
import { giveBackText } from "../lib/prompt-lock";
import { COMMAND_NAMES } from "../components/command-menu/commands";
import { SessionCommandsContext } from "../components/command-menu/session-commands";
import { escapeTranscriptText } from "../lib/display-text";
import { openSnapshots } from "../lib/session-snapshots";
import { userCommandTurn } from "../lib/user-commands";

const sessionLocationSchema = z.object({
  initialPrompt: z
    .object({
      message: z.string(),
      mode: z.custom<ModeType>(),
      model: z.string(),
      agentId: z.string().optional(),
      /** The model a custom command asked for, for this first turn. */
      agentModel: z.string().optional(),
    })
    .optional(),
});

function ChatMessage(
  { msg }: {
    msg: ChatMessageData
  }
) {
  if (msg.role === "user") {
    const text = msg.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");

    return <UserMessage message={text} mode={msg.metadata?.mode ?? "BUILD"} marker={msg.metadata?.steered ? "↳ steer" : undefined} />;
  }

  return (
    <BotMessage
      parts={msg.parts}
      model={msg.metadata?.model ?? "unknown"}
      mode={msg.metadata?.mode ?? "BUILD"}
      agentName={msg.metadata?.agent}
      durationMs={msg.metadata?.durationMs}
      streaming={false}
    />
  );
};

/** A line the session says about itself (an undo's files), between the messages it came after and before. */
function NoticeLine({ text }: { text: string }) {
  return (
    <box paddingX={2}>
      <text attributes={TextAttributes.DIM} wrapMode="word" width="100%">
        {`· ${escapeTranscriptText(text)}`}
      </text>
    </box>
  );
}

type Notice = { id: number; /** How many messages there were when it was said. */ at: number; text: string };

function SessionChat({ 
  session,
  initialPrompt,
}: { 
  session: StoredSession,
  initialPrompt?: { message: string; mode: ModeType; model: string; agentId?: string; agentModel?: string };
}) {
  const { agents, agent, model, refreshPiModel } = usePromptConfig();
  const { isTopLayer } = useKeyboardLayer();
  const renderer = useRenderer();
  const mountedRef = useRef(true);
  // A session keeps the engine it was created with; one this build does not know only reports that.
  const engine = useMemo(
    () => getEngine(session.engine) ?? unknownEngine(session.engine),
    [session.engine],
  );
  const toast = useToast();
  // Where this project's files are snapshotted around each turn; none (and a reason) without git.
  const snapshots = useMemo(() => openSnapshots(session.cwd), [session.cwd]);
  // An engine's notices are toasts (an extension's text is stripped of terminal controls); a warning has no color of its own, so it says so.
  const chatOptions = useMemo(
    () => ({
      notify: (message: string, level: NoticeLevel) => {
        const text = stripControlChars(message);
        toast.show({ variant: level === "error" ? "error" : "info", message: level === "warning" ? `Warning: ${text}` : text });
      },
      // Text the engine did not take goes back to the input on screen; once this session is left there is no input of its own to return it to.
      restore: (text: string) => mountedRef.current && giveBackText(renderer, text),
      snapshots,
    }),
    [toast, renderer, snapshots],
  );
  const { messages, status, submit, abort, interrupt, steer, followUp, queued, canSteer, inputClosed, error, pendingRequest, compacting, editMessages, getMessages, hasConversation, snapshotIssue, compact } = useChat(session, engine, chatOptions);
  const [notices, setNotices] = useState<Notice[]>([]);
  const addNotice = useCallback((text: string) => setNotices((prev) => [...prev, { id: prev.length, at: getMessages().length, text }]), [getMessages]);
  const hasSubmittedInitialPromptRef = useRef(false);
  const textEntryRef = useRef(false);
  const setTextEntry = useCallback((active: boolean) => {
    textEntryRef.current = active;
  }, []);
  const busy = status === "submitted" || status === "streaming";
  // A pi turn waits for the model check (a login or logout can change which models exist) before it starts.
  const [choosingModel, setChoosingModel] = useState(false);

  // Stop the pending reply when the user leaves this session.
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      abort();
    };
  }, [abort]);

  // Starts a turn for `turnAgent` on the model this session's engine uses: `modelOverride` (a custom command's, already checked against
  // the engine), else the agent's own when this engine can use it, else the session's (a pi session sends the pi model that has credentials now).
  const send = useCallback(
    (userText: string, turnAgent: Agent, claudeModel: string, modelOverride?: string) => {
      const turn = { userText, mode: turnAgent.mode, turnAgent: { name: turnAgent.name, prompt: turnAgent.prompt, pluginDir: turnAgent.pluginDir, tools: turnAgent.tools } };
      const agentModel = modelOverride ?? (turnAgent.model && agentModelFits(turnAgent.model, session.engine) ? turnAgent.model : undefined);
      if (session.engine !== "pi") {
        void submit({ ...turn, model: agentModel ?? modelForEngine(session.engine, claudeModel) });
        return;
      }
      setChoosingModel(true);
      void refreshPiModel(agentModel)
        .then((piModel) => {
          if (mountedRef.current) void submit({ ...turn, model: piModel });
        })
        .finally(() => {
          if (mountedRef.current) setChoosingModel(false);
        });
    },
    [session.engine, submit, refreshPiModel],
  );

  const sessionCommands = useSessionCommands({
    session,
    chat: { getMessages, editMessages, snapshotIssue, hasConversation, compact, busy },
    snapshots,
    compactModel: () => (session.engine === "pi" ? refreshPiModel() : Promise.resolve(model)),
    compactWithTurn: () => send("/compact", agent, model),
    addNotice,
  });

  // What the user typed: one of their custom commands runs as its expanded prompt, as the agent and model it names for this turn only.
  const sendTyped = useCallback(
    (text: string) => {
      const turn = userCommandTurn(text, { cwd: session.cwd, engine: session.engine, agents, builtinNames: COMMAND_NAMES });
      if (!turn) return send(text, agent, model);
      if (turn.warning) toast.show({ variant: "info", message: turn.warning });
      send(turn.text, turn.agent ?? agent, model, turn.model);
    },
    [session.cwd, session.engine, agents, agent, model, send, toast],
  );

  // A pi session's input takes keys whenever no prompt is open: while it starts (the model check, before the turn can take steers), while the
  // turn runs, and while it closes. An approval, question or dialog still takes every key, so the input is off while one is open.
  // Only sending waits: before the turn can take steers (`starting`) and once the engine has settled it (`inputClosed`) Enter keeps the text,
  // which is sent as the next prompt when the turn ends.
  const piSession = session.engine === "pi";
  const typingDuringTurn = busy && (canSteer || inputClosed);
  const starting = piSession && (choosingModel || (busy && !canSteer && !inputClosed));
  const turnInput = useMemo(
    () => ({ active: typingDuringTurn && !pendingRequest, closed: busy && inputClosed, starting, steer, queue: followUp }),
    [typingDuringTurn, pendingRequest, busy, inputClosed, starting, steer, followUp],
  );

  // Show the pi model in use (the saved one may need a fallback) before the first prompt.
  useEffect(() => {
    if (session.engine === "pi") void refreshPiModel();
  }, [session.engine, refreshPiModel]);

  // The `/` menu of a pi session lists pi's commands from the first keystroke, not only after its first turn.
  useEffect(() => {
    if (session.engine === "pi") void warmUpEngineCommands("pi", { cwd: session.cwd });
  }, [session.engine, session.cwd]);

  // Let the user cancel a reply even before the first message arrives.
  useKeyboard((key) => {
    // Esc inside a question's free-text field only closes the field; on the project trust question it only means "not now", and the turn goes on untrusted.
    if (key.name === "escape" && isTopLayer("base") && busy && !textEntryRef.current && pendingRequest?.kind !== "trust") {
      key.preventDefault();
      interrupt();
    }
  });

  useEffect(() => {
    if (!initialPrompt || hasSubmittedInitialPromptRef.current) return;
    hasSubmittedInitialPromptRef.current = true;
    // A prompt that names no agent (older navigation state) runs as the selected agent, or as the built-in one when the mode it carries differs.
    const fallback = agent.mode === initialPrompt.mode ? agent.id : builtinAgentId(initialPrompt.mode);
    const first = findAgent(agents, initialPrompt.agentId ?? fallback);
    send(initialPrompt.message, first, initialPrompt.model, initialPrompt.agentModel);
  }, [initialPrompt, agents, agent, send]);

  const noticesAt = (from: number, to: number) => notices.filter((notice) => notice.at >= from && notice.at < to).map((notice) => <NoticeLine key={`notice-${notice.id}`} text={notice.text} />);

  return (
    <SessionCommandsContext.Provider value={sessionCommands}>
    <TurnInputContext.Provider value={turnInput}>
      <SessionShell
        cwd={session.cwd}
        engine={session.engine}
        draftKey={session.id}
        messages={messages}
        onSubmit={sendTyped}
        inputDisabled={(busy && !typingDuringTurn && !piSession) || pendingRequest !== null || compacting}
        loading={busy}
        interruptible={busy}
      >
        {messages.map((msg, index) => (
          <Fragment key={msg.id}>
            {noticesAt(index, index + 1)}
            <ChatMessage msg={msg} />
          </Fragment>
        ))}
        {noticesAt(messages.length, Infinity)}
        {queued.steering.map((text, index) => (
          <UserMessage key={`steer-${index}`} message={text} mode={agent.mode} marker="↳ steer · pending" pending />
        ))}
        {queued.followUp.map((text, index) => (
          <UserMessage key={`queued-${index}`} message={text} mode={agent.mode} marker="queued" pending />
        ))}
        {pendingRequest?.kind === "permission" && <PermissionPrompt request={pendingRequest} />}
        {pendingRequest?.kind === "question" && (
          <QuestionPrompt key={pendingRequest.id} request={pendingRequest} onTextEntryChange={setTextEntry} />
        )}
        {pendingRequest?.kind === "select" && <SelectPrompt key={pendingRequest.id} request={pendingRequest} />}
        {pendingRequest?.kind === "confirm" && <ConfirmPrompt key={pendingRequest.id} request={pendingRequest} />}
        {pendingRequest?.kind === "input" && <InputPrompt key={pendingRequest.id} request={pendingRequest} />}
        {pendingRequest?.kind === "editor" && <EditorPrompt key={pendingRequest.id} request={pendingRequest} />}
        {error && <ErrorMessage message={error} />}
      </SessionShell>
      {/* The trust question owns the whole screen while pending, so its title and key hints never scroll away. */}
      {pendingRequest?.kind === "trust" && <TrustPrompt key={pendingRequest.id} request={pendingRequest} />}
    </TurnInputContext.Provider>
    </SessionCommandsContext.Provider>
  );
}

export function Session() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();

  const { initialPrompt } = useMemo(() => {
    const parsed = sessionLocationSchema.safeParse(location.state);
    return parsed.success ? parsed.data : { initialPrompt: undefined };
  }, [location.state]);

  const { session, loadError } = useMemo(() => {
    try {
      return { session: id ? getStorage().getSession(id) : null, loadError: null };
    } catch (err) {
      return { session: null, loadError: err instanceof Error ? err.message : String(err) };
    }
  }, [id]);

  useEffect(() => {
    if (session) return;

    toast.show({
      variant: "error",
      message: loadError ? `Could not load session: ${loadError}` : "Failed to load session",
    });
    navigate("/", { replace: true });
  }, [session, loadError, toast, navigate]);

  if (!session) {
    return <SessionShell onSubmit={() => {}} inputDisabled loading />;
  }

  return (
    <SessionChat 
      key={session.id} 
      session={session} 
      initialPrompt={initialPrompt}
    />
  );
};
