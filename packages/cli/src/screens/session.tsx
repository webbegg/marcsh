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
import type { ChatMessage as ChatMessageData, MessageAttachment } from "../lib/chat-types";
import { getStorage, type StoredSession } from "../lib/storage";
import { getEngine, getPiRuntime, unknownEngine, warmUpEngineCommands } from "../lib/engine";
import { listAvailablePiModels } from "../lib/engine/pi-models";
import type { NoticeLevel } from "../lib/engine/types";
import { modelForEngine, SUPPORTED_CHAT_MODELS } from "../lib/models";
import { nextRecent } from "../lib/model-picks";
import { notifyTurnDone } from "../lib/notify";
import { getRecentModels, recordRecentModel } from "../lib/preferences";
import { useKeyboardLayer } from "../providers/keyboard-layer";
import { giveBackText } from "../lib/prompt-lock";
import { COMMAND_NAMES } from "../components/command-menu/commands";
import { SessionCommandsContext } from "../components/command-menu/session-commands";
import { escapeTranscriptText } from "../lib/display-text";
import { openSnapshots } from "../lib/session-snapshots";
import { userCommandTurn } from "../lib/user-commands";
import { backgroundMessageText, createBackgroundHub, noticeOf, type BackgroundBatch } from "../lib/background/hub";
import { BackgroundContext } from "../lib/background/context";

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

const isChatModel = (value: string): value is (typeof SUPPORTED_CHAT_MODELS)[number]["id"] =>
  SUPPORTED_CHAT_MODELS.some((candidate) => candidate.id === value);

/** A pi model ref ("provider/id"), the only form the saved pi models take. */
const isPiRef = (value: string) => /^[^/\s]+\/\S+$/.test(value);

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

    // Background results: the notice is shown, the result itself was for the model.
    if (msg.metadata?.background) return <UserMessage message={noticeOf(text)} mode={msg.metadata.mode ?? "BUILD"} marker="background" />;
    return <UserMessage message={text} mode={msg.metadata?.mode ?? "BUILD"} marker={msg.metadata?.steered ? "↳ steer" : undefined} attachments={msg.metadata?.attachments} />;
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
  const { agents, agent, model, setModel, piModel, setPiModel, refreshPiModel } = usePromptConfig();
  // The agent selected now, for what runs later than a render: background results' turns and background subagents' plan mode.
  const agentRef = useRef(agent);
  agentRef.current = agent;
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
  // Where this session's background work delivers its results (pi only); disposed, with everything it runs, when the session is left.
  const hub = useMemo(() => (session.engine === "pi" ? createBackgroundHub() : undefined), [session.engine]);
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
      background: hub,
      // The agent selected now, not the one a turn started with: a background subagent stops writing once the session is in plan.
      currentMode: () => agentRef.current.mode,
    }),
    [toast, renderer, snapshots, hub],
  );
  const { messages, status, submit, abort, interrupt, steer, followUp, queued, canSteer, inputClosed, error, pendingRequest, compacting, editMessages, getMessages, hasConversation, snapshotIssue, isIdle, compact } = useChat(session, engine, chatOptions);
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
  // Read by the background idle path, which runs outside a render.
  const choosingModelRef = useRef(false);
  const setChoosing = useCallback((choosing: boolean) => {
    choosingModelRef.current = choosing;
    setChoosingModel(choosing);
  }, []);

  // Tells the user when a turn ends: not when the session opens, not when they interrupted it, not when they left. It is `submit` settling
  // that says so (a turn that fails at once never shows as busy on screen), and the effect reads whether the turn failed once that has rendered.
  const turnInterruptedRef = useRef(false);
  const errorRef = useRef(error);
  errorRef.current = error;
  const [turnsEnded, setTurnsEnded] = useState(0);
  // Returns whether a turn started.
  const startTurn = useCallback(
    (request: Parameters<typeof submit>[0]) => {
      const before = getMessages();
      const done = submit(request);
      // A turn that is still running keeps the request out: nothing was started, so nothing will end.
      if (getMessages() === before) return false;
      turnInterruptedRef.current = false;
      void done.finally(() => {
        if (mountedRef.current && !turnInterruptedRef.current) setTurnsEnded((count) => count + 1);
      });
      return true;
    },
    [submit, getMessages],
  );
  useEffect(() => {
    if (turnsEnded === 0) return;
    let title = session.title;
    try {
      // `/rename` may have changed it since this session opened.
      title = getStorage().getSession(session.id)?.title ?? title;
    } catch {}
    notifyTurnDone(`${stripControlChars(title)}: ${errorRef.current ? "failed" : "done"}`);
    // Only a turn ending is news: a rename or an error showing up later is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnsEnded]);

  // Stop the pending reply when the user leaves this session.
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      abort();
      void hub?.dispose();
    };
  }, [abort, hub]);

  // Starts a turn for `turnAgent` on the model this session's engine uses: `modelOverride` (a custom command's, already checked against
  // the engine), else the agent's own when this engine can use it, else the session's (a pi session sends the pi model that has credentials now).
  // `background`: the turn delivers this batch of background results. Resolves with whether a turn started.
  const send = useCallback(
    (userText: string, turnAgent: Agent, claudeModel: string, modelOverride?: string, attachments?: MessageAttachment[], background?: BackgroundBatch): Promise<boolean> => {
      const turn = {
        userText,
        mode: turnAgent.mode,
        turnAgent: { name: turnAgent.name, prompt: turnAgent.prompt, pluginDir: turnAgent.pluginDir, tools: turnAgent.tools },
        ...(attachments?.length ? { attachments } : {}),
        ...(background ? { background } : {}),
      };
      const agentModel = modelOverride ?? (turnAgent.model && agentModelFits(turnAgent.model, session.engine) ? turnAgent.model : undefined);
      if (session.engine !== "pi") {
        const used = agentModel ?? modelForEngine(session.engine, claudeModel);
        if (session.engine === "claude" && isChatModel(used)) recordRecentModel("claude", used);
        return Promise.resolve(startTurn({ ...turn, model: used }));
      }
      setChoosing(true);
      const started = refreshPiModel(agentModel).then((used) => {
        if (!mountedRef.current) return false;
        if (isPiRef(used)) recordRecentModel("pi", used);
        return startTurn({ ...turn, model: used });
      });
      void started.finally(() => {
        if (mountedRef.current) setChoosing(false);
      });
      return started;
    },
    [session.engine, startTurn, refreshPiModel, setChoosing],
  );

  // A background result that finishes while the session is idle starts a turn of its own, as the agent and model selected at that
  // moment; its tool calls ask like any other's. While anything else holds the session (a turn, the model check, a request waiting for
  // the user, a compaction) the hub keeps the result and retries once the chat is idle again.
  const modelRef = useRef(model);
  modelRef.current = model;
  useEffect(() => {
    if (!hub) return;
    hub.setIdleSink((batch) => {
      if (!mountedRef.current || choosingModelRef.current || !isIdle()) return false;
      const requeue = () => hub.requeue(batch.ids);
      // A turn that started has the results as its prompt: the hub forgets them. One that did not gives them back, retried later.
      send(backgroundMessageText(batch), agentRef.current, modelRef.current, undefined, undefined, batch).then((started) => {
        if (started) hub.confirm(batch.ids);
        else requeue();
      }, requeue);
      return true;
    });
    return () => hub.setIdleSink(undefined);
  }, [hub, isIdle, send]);

  const sessionCommands = useSessionCommands({
    session,
    chat: { getMessages, editMessages, snapshotIssue, hasConversation, compact, busy },
    snapshots,
    compactModel: () => (session.engine === "pi" ? refreshPiModel() : Promise.resolve(model)),
    compactWithTurn: () => void send("/compact", agent, model),
    addNotice,
    background: hub,
  });

  // What the user typed: one of their custom commands runs as its expanded prompt, as the agent and model it names for this turn only.
  const sendTyped = useCallback(
    (text: string, attachments?: MessageAttachment[]) => {
      const turn = userCommandTurn(text, { cwd: session.cwd, engine: session.engine, agents, builtinNames: COMMAND_NAMES });
      if (!turn) return send(text, agent, model, undefined, attachments);
      if (turn.warning) toast.show({ variant: "info", message: turn.warning });
      send(turn.text, turn.agent ?? agent, model, turn.model, attachments);
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

  // F2 switches to the next recent model of this session's engine, by the same path the model dialog uses; a claude model alias or a
  // pi model that still has credentials. A pi switch waits for the credential check, so a second F2 meanwhile is ignored.
  const cyclingRef = useRef(false);
  const cycleModel = useCallback(async () => {
    if (cyclingRef.current) return;
    cyclingRef.current = true;
    try {
      if (session.engine === "pi") {
        let available: string[];
        try {
          available = (await listAvailablePiModels(await getPiRuntime())).map((candidate) => candidate.ref);
        } catch {
          toast.show({ variant: "error", message: "Could not check which pi models are available" });
          return;
        }
        const next = nextRecent(getRecentModels("pi").filter((ref) => available.includes(ref)), piModel);
        if (!next) return void toast.show({ variant: "info", message: "No other recent model" });
        setPiModel(next);
        toast.show({ variant: "success", message: `Model: ${next}` });
      } else {
        const next = SUPPORTED_CHAT_MODELS.find((candidate) => candidate.id === nextRecent(getRecentModels("claude"), model));
        if (!next) return void toast.show({ variant: "info", message: "No other recent model" });
        setModel(next.id);
        toast.show({ variant: "success", message: `Model: ${next.id}` });
      }
    } finally {
      cyclingRef.current = false;
    }
  }, [session.engine, model, piModel, setModel, setPiModel, toast]);

  // Let the user cancel a reply even before the first message arrives.
  useKeyboard((key) => {
    // A dialog or a prompt (approval, question, trust) owns the keys while it is open.
    if (key.name === "f2" && isTopLayer("base") && !pendingRequest && !compacting) {
      key.preventDefault();
      void cycleModel();
      return;
    }
    // Esc inside a question's free-text field only closes the field; on the project trust question it only means "not now", and the turn goes on untrusted.
    if (key.name === "escape" && isTopLayer("base") && busy && !textEntryRef.current && pendingRequest?.kind !== "trust") {
      key.preventDefault();
      turnInterruptedRef.current = true;
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
    <BackgroundContext.Provider value={hub}>
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
    </BackgroundContext.Provider>
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
