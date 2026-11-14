import { useEffect, useMemo, useRef } from "react";
import { z } from "zod";
import { modeSchema } from "../lib/modes";
import { useNavigate, useLocation } from "react-router";
import { SessionShell } from "../components/session-shell";
import { UserMessage } from "../components/messages";
import { useToast } from "../providers/toast";
import { getStorage } from "../lib/storage";
import { usePromptConfig } from "../providers/prompt-config";

const newSessionStateSchema = z.object({
  message: z.string(),
  mode: modeSchema,
  model: z.string(),
  /** The ID of the agent selected on the home screen. */
  agentId: z.string().optional(),
  /** The model a custom command chose for the first turn only. */
  agentModel: z.string().optional(),
});

export function NewSession() {
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const { defaultEngine } = usePromptConfig();
  const hasStartedRef = useRef(false);

  const state = useMemo(() => {
    const parsed = newSessionStateSchema.safeParse(location.state);
    return parsed.success ? parsed.data : null;
  }, [location.state])

  // Guard: if navigated here directly without state, go home
  useEffect(() => {
    if (!state) {
      navigate("/", { replace: true });
    }
  }, [state, navigate]);

  // Create the session on mount — this screen exists to do this
  useEffect(() => {
    if (!state || hasStartedRef.current) return;

    hasStartedRef.current = true;

    try {
      const session = getStorage().createSession({
        title: state.message.slice(0, 100),
        cwd: process.cwd(),
        engine: defaultEngine,
      });
      navigate(
        `/sessions/${session.id}`,
        { replace: true, state: { initialPrompt: state } }
      );
    } catch (error) {
      toast.show({
        variant: "error",
        message: error instanceof Error ? error.message : "Failed to create session",
      });
      navigate("/", { replace: true });
    }
  }, [state, navigate, toast, defaultEngine]);

  if (!state) return null;

  // Keys typed here (a burst right after Enter on the home screen) are the start of the next message: the bar hands them to the session's input when it unmounts.
  return (
    <SessionShell onSubmit={() => {}} inputTypeOnly loading>
      <UserMessage message={state.message} mode={state.mode} />
    </SessionShell>
  );
};
