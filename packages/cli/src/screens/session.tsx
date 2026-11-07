import { useEffect, useMemo, useRef } from "react";
import { useParams, useLocation, useNavigate } from "react-router";
import { z } from "zod";
import { useKeyboard } from "@opentui/react";
import { type ModeType } from "../lib/modes";
import { SessionShell } from "../components/session-shell";
import { 
  UserMessage, 
  BotMessage, 
  ErrorMessage
} from "../components/messages";
import { PermissionPrompt } from "../components/permission-prompt";
import { useToast } from "../providers/toast";
import { useChat } from "../hooks/use-chat";
import { usePromptConfig } from "../providers/prompt-config";
import type { ChatMessage as ChatMessageData } from "../lib/chat-types";
import { getStorage, type StoredSession } from "../lib/storage";
import { useKeyboardLayer } from "../providers/keyboard-layer";

const sessionLocationSchema = z.object({
  initialPrompt: z
    .object({
      message: z.string(),
      mode: z.custom<ModeType>(),
      model: z.string(),
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
  initialPrompt?: { message: string; mode: ModeType; model: string };
}) {
  const { mode, model } = usePromptConfig();
  const { isTopLayer } = useKeyboardLayer();
  const { messages, status, submit, abort, interrupt, error, permissionRequest } = useChat(session);
  const hasSubmittedInitialPromptRef = useRef(false);
  const busy = status === "submitted" || status === "streaming";

  // Stop the pending reply when the user leaves this session.
  useEffect(() => {
    return () => {
      abort();
    };
  }, [abort]);

  // Let the user cancel a reply even before the first message arrives.
  useKeyboard((key) => {
    if (key.name === "escape" && isTopLayer("base") && busy) {
      key.preventDefault();
      interrupt();
    }
  });

  useEffect(() => {
    if (!initialPrompt || hasSubmittedInitialPromptRef.current) return;
    hasSubmittedInitialPromptRef.current = true;
    void submit({
      userText: initialPrompt.message,
      mode: initialPrompt.mode,
      model: initialPrompt.model,
    });
  }, [initialPrompt, submit]);

  return (
    <SessionShell
      onSubmit={(text) => submit({ userText: text, mode, model })}
      inputDisabled={busy}
      loading={busy}
      interruptible={busy}
    >
      {messages.map((msg) => (
        <ChatMessage key={msg.id} msg={msg} />
      ))}
      {permissionRequest && <PermissionPrompt request={permissionRequest} />}
      {error && <ErrorMessage message={error} />}
    </SessionShell>
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

  const session = useMemo(() => (id ? getStorage().getSession(id) : null), [id]);

  useEffect(() => {
    if (session) return;

    toast.show({ variant: "error", message: "Failed to load session" });
    navigate("/", { replace: true });
  }, [session, toast, navigate]);

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
