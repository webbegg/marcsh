import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useLocation, useNavigate } from "react-router";
import { z } from "zod";
import { useKeyboard } from "@opentui/react";
import { Mode, type ModeType } from "../lib/modes";
import { agentModelFits, findAgent, type Agent } from "../lib/agents";
import { SessionShell } from "../components/session-shell";
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
import { usePromptConfig } from "../providers/prompt-config";
import type { ChatMessage as ChatMessageData } from "../lib/chat-types";
import { getStorage, type StoredSession } from "../lib/storage";
import { getEngine, unknownEngine, warmUpEngineCommands } from "../lib/engine";
import type { NoticeLevel } from "../lib/engine/types";
import { modelForEngine } from "../lib/models";
import { useKeyboardLayer } from "../providers/keyboard-layer";

const sessionLocationSchema = z.object({
  initialPrompt: z
    .object({
      message: z.string(),
      mode: z.custom<ModeType>(),
      model: z.string(),
      agent: z.string().optional(),
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

    return <UserMessage message={text} mode={msg.metadata?.mode ?? "BUILD"} />;
  }

  return (
    <BotMessage
      parts={msg.parts}
      model={msg.metadata?.model ?? "unknown"}
      mode={msg.metadata?.mode ?? "BUILD"}
      agent={msg.metadata?.agent}
      durationMs={msg.metadata?.durationMs}
      streaming={false}
    />
  );
};

function SessionChat({ 
  session,
  initialPrompt,
}: { 
  session: StoredSession,
  initialPrompt?: { message: string; mode: ModeType; model: string; agent?: string };
}) {
  const { agents, agent, model, refreshPiModel } = usePromptConfig();
  const { isTopLayer } = useKeyboardLayer();
  // A session keeps the engine it was created with; one this build does not know only reports that.
  const engine = useMemo(
    () => getEngine(session.engine) ?? unknownEngine(session.engine),
    [session.engine],
  );
  const toast = useToast();
  // An engine's notices are toasts (an extension's text is stripped of terminal controls); a warning has no color of its own, so it says so.
  const chatOptions = useMemo(
    () => ({
      notify: (message: string, level: NoticeLevel) => {
        const text = stripControlChars(message);
        toast.show({ variant: level === "error" ? "error" : "info", message: level === "warning" ? `Warning: ${text}` : text });
      },
    }),
    [toast],
  );
  const { messages, status, submit, abort, interrupt, error, pendingRequest } = useChat(session, engine, chatOptions);
  const hasSubmittedInitialPromptRef = useRef(false);
  const textEntryRef = useRef(false);
  const setTextEntry = useCallback((active: boolean) => {
    textEntryRef.current = active;
  }, []);
  const busy = status === "submitted" || status === "streaming";
  const mountedRef = useRef(true);
  // A pi turn waits for the model check (a login or logout can change which models exist) before it starts.
  const [choosingModel, setChoosingModel] = useState(false);

  // Stop the pending reply when the user leaves this session.
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      abort();
    };
  }, [abort]);

  // Starts a turn for `turnAgent` on the model this session's engine uses: the agent's own when this engine can use it,
  // else the session's (a pi session sends the pi model that has credentials now).
  const send = useCallback(
    (userText: string, turnAgent: Agent, claudeModel: string) => {
      const turn = { userText, mode: turnAgent.mode, agent: { name: turnAgent.name, prompt: turnAgent.prompt, pluginDir: turnAgent.pluginDir } };
      const agentModel = turnAgent.model && agentModelFits(turnAgent.model, session.engine) ? turnAgent.model : undefined;
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
    const fallback = agent.mode === initialPrompt.mode ? agent.id : initialPrompt.mode === Mode.PLAN ? "plan" : "build";
    const first = findAgent(agents, initialPrompt.agent ?? fallback);
    send(initialPrompt.message, first, initialPrompt.model);
  }, [initialPrompt, agents, agent, send]);

  return (
    <>
      <SessionShell
        cwd={session.cwd}
        engine={session.engine}
        onSubmit={(text) => send(text, agent, model)}
        inputDisabled={busy || choosingModel}
        loading={busy}
        interruptible={busy}
      >
        {messages.map((msg) => (
          <ChatMessage key={msg.id} msg={msg} />
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
    </>
  );
}

export function Session() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();

  const initialPrompt = useMemo(() => {
    const parsed = sessionLocationSchema.safeParse(location.state);
    return parsed.success ? parsed.data.initialPrompt : undefined;
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
