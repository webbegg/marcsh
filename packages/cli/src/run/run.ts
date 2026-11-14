import type { RunArgs } from "../cli-args";
import { agentModelFits, findAgent, loadAgents, type Agent } from "../lib/agents";
import type { ChatMessage } from "../lib/chat-types";
import { getEngine, getPiRuntime, unknownEngine } from "../lib/engine";
import { listAvailablePiModels, pickTurnPiModel } from "../lib/engine/pi-models";
import type { EngineEvent, PermissionDecision, TurnHost } from "../lib/engine/types";
import { DEFAULT_CHAT_MODEL_ID, modelForEngine, PI_DEFAULT_MODEL } from "../lib/models";
import { getAgentId, getDefaultEngine, getPiModel } from "../lib/preferences";
import { registerTurn as registerQuitTurn } from "../lib/quit";
import { finishReply } from "../lib/reply";
import { getStorage, type Storage, type StoredSession } from "../lib/storage";
import { latestSessionForCwd } from "../startup/launch";

/** What `marcsh run` was asked: the parsed arguments plus the standard input (when it was not a terminal) and the folder. */
export type RunOptions = Omit<RunArgs, "kind"> & { stdin?: string; cwd?: string };

export type RunDeps = {
  storage: Pick<Storage, "listSessions" | "getSession" | "createSession" | "saveMessages">;
  io: { stdout: (text: string) => void; stderr: (text: string) => void };
  /** Quitting (Ctrl+C) stops every registered turn and waits for its `done`. */
  registerTurn: typeof registerQuitTurn;
};

export const EXIT = { ok: 0, failed: 1, usage: 2, interrupted: 130 } as const;

/** Why a permission ask is denied: nobody is there to answer. */
const NO_APPROVER = "headless runs cannot ask for approval";

/** The message and the standard input as one prompt: the input follows the message after a blank line. */
function joinMessage(message: string, stdin: string | undefined): string {
  return [message.trim(), stdin?.trim() ?? ""].filter(Boolean).join("\n\n");
}

/** The agent named by `--agent` (its id, its name, or the file name inside its id), or the selected one when none is named. */
function pickAgent(agents: readonly Agent[], name: string | undefined): Agent | undefined {
  if (name === undefined) return findAgent(agents, getAgentId());
  const wanted = name.toLowerCase();
  return (
    agents.find((agent) => agent.id.toLowerCase() === wanted) ??
    agents.find((agent) => agent.name.toLowerCase() === wanted) ??
    agents.find((agent) => agent.id.toLowerCase().split("/").pop() === wanted)
  );
}

/** The model of the turn: `--model`, else the agent's own when this engine can use it, else the session's (a pi turn takes a pi model that has credentials). */
async function pickModel(engineId: string, flag: string | undefined, agent: Agent): Promise<string> {
  if (flag) return flag;
  const agentModel = agent.model && agentModelFits(agent.model, engineId) ? agent.model : undefined;
  if (engineId !== "pi") return agentModel ?? modelForEngine(engineId, DEFAULT_CHAT_MODEL_ID);
  const preferred = getPiModel() ?? PI_DEFAULT_MODEL;
  try {
    return pickTurnPiModel(agentModel, preferred, await listAvailablePiModels(await getPiRuntime()));
  } catch {
    // No runtime to ask: the turn still goes out with the best guess, so it reports what is missing.
    return agentModel ?? preferred;
  }
}

/** The final text of the last reply: what it says after its last tool or task, thinking left out. */
export function finalText(messages: readonly ChatMessage[]): string {
  const reply = messages.findLast((message) => message.role === "assistant");
  const texts: string[] = [];
  for (const part of [...(reply?.parts ?? [])].reverse()) {
    if (part.type === "text") texts.unshift(part.text);
    else if (part.type !== "reasoning") break;
  }
  return texts.join("\n");
}

/**
 * `marcsh run`: one turn without the interface. Resolves with the exit code; the session is saved as a TUI session is, so it
 * can be resumed there. Nobody is there to answer, so every ask is declined (see `docs/cli.md`).
 */
export async function runHeadless(options: RunOptions, deps: Partial<RunDeps> = {}): Promise<number> {
  const { io = { stdout: (text) => void process.stdout.write(text), stderr: (text) => void process.stderr.write(text) }, registerTurn = registerQuitTurn } = deps;
  const cwd = options.cwd ?? process.cwd();
  const usage = (message: string) => {
    io.stderr(`marcsh: ${message}\n`);
    return EXIT.usage;
  };

  const prompt = joinMessage(options.message, options.stdin);
  if (!prompt) return usage("no message: pass it as arguments or on standard input");

  const agent = pickAgent(loadAgents(), options.agent);
  if (!agent) return usage(`no agent "${options.agent}"`);

  let storage: RunDeps["storage"];
  let session: StoredSession;
  try {
    storage = deps.storage ?? getStorage();
    let found: StoredSession | null = null;
    if (options.session !== undefined) {
      found = storage.getSession(options.session);
      if (!found) return usage(`no session with id "${options.session}"`);
    } else if (options.continue) {
      const latest = latestSessionForCwd(storage.listSessions(), cwd);
      found = latest ? storage.getSession(latest.id) : null;
    }
    // A new session is created as the new-session screen creates it.
    session = found ?? storage.createSession({ title: prompt.slice(0, 100), cwd, engine: options.engine ?? getDefaultEngine() });
    if (found && options.engine && options.engine !== found.engine) {
      io.stderr(`marcsh: the session uses the ${found.engine} engine, so --engine ${options.engine} is ignored\n`);
    }
  } catch (err) {
    io.stderr(`marcsh: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.failed;
  }

  const engine = getEngine(session.engine) ?? unknownEngine(session.engine);
  const model = await pickModel(session.engine, options.model, agent);
  const json = options.format === "json";
  const writeJson = (value: Record<string, unknown>) => io.stdout(`${JSON.stringify(value)}\n`);

  // The same messages the TUI builds: a user message and an empty reply, which the engine's events fill.
  const metadata = { mode: agent.mode, model, agent: agent.name };
  let replyId = crypto.randomUUID();
  const replyIds: string[] = [replyId];
  let messages: ChatMessage[] = [
    ...session.messages,
    { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: prompt }], metadata },
    { id: replyId, role: "assistant", parts: [], metadata },
  ];
  let resumeRef = session.engineSessionRef ?? undefined;
  const errors: string[] = [];
  let aborted = false;

  const abortController = new AbortController();
  let finishTurn = () => {};
  const finished = new Promise<void>((resolve) => (finishTurn = resolve));
  const unregisterTurn = registerTurn({
    stop: () => {
      aborted = true;
      abortController.abort();
    },
    done: finished,
  });

  const onEvent = (event: EngineEvent) => {
    switch (event.type) {
      case "reply": {
        const id = replyId;
        messages = messages.map((m) => (m.id === id ? event.update(m) : m));
        // The update is a function: the JSON carries the parts it produced.
        if (json) writeJson({ type: "reply", parts: messages.find((m) => m.id === id)?.parts ?? [] });
        return;
      }
      case "session":
        resumeRef = event.ref;
        break;
      case "error":
        if (!aborted) {
          errors.push(event.message);
          io.stderr(`marcsh: ${event.message}\n`);
        }
        break;
      case "delivered": {
        const closed = replyId;
        replyId = crypto.randomUUID();
        replyIds.push(replyId);
        const next = replyId;
        messages = [
          // A reply that said nothing before the message came leaves no empty bot row behind.
          ...messages.filter((m) => !(m.id === closed && m.parts.length === 0)),
          { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: event.text }], metadata: event.kind === "steer" ? { ...metadata, steered: true } : metadata },
          { id: next, role: "assistant", parts: [], metadata },
        ];
        break;
      }
    }
    if (json) writeJson({ ...event });
  };

  const decline = <T,>(declined: T) => async () => declined;
  const host: TurnHost = {
    emit: onEvent,
    askPermission: async (ask): Promise<PermissionDecision> => {
      io.stderr(`marcsh: denied ${ask.toolName} (${NO_APPROVER})\n`);
      return "deny";
    },
    askQuestions: decline(null),
    select: decline(undefined),
    confirm: decline(false),
    input: decline(undefined),
    editor: decline(undefined),
    askProjectTrust: decline("skip" as const),
    notify: (message) => io.stderr(`marcsh: ${message}\n`),
  };

  try {
    const turn = engine.startTurn(
      {
        prompt,
        cwd: session.cwd,
        mode: agent.mode,
        model,
        systemPromptAppend: agent.prompt,
        ...(agent.pluginDir ? { packPluginPath: agent.pluginDir } : {}),
        ...(agent.tools && agent.tools.deny.length > 0 ? { deniedTools: agent.tools.deny } : {}),
        resumeRef,
        signal: abortController.signal,
      },
      host,
    );
    await turn.done;
  } catch (err) {
    if (!aborted) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(message);
      io.stderr(`marcsh: ${message}\n`);
    }
  } finally {
    // Tools still running will never get a result: they are saved as interrupted.
    messages = messages.map((m) => (replyIds.includes(m.id) ? finishReply(m) : m));
    try {
      storage.saveMessages(session.id, messages, resumeRef);
    } catch (err) {
      errors.push(`Could not save session: ${err instanceof Error ? err.message : String(err)}`);
      io.stderr(`marcsh: ${errors.at(-1)}\n`);
    }
    unregisterTurn();
    finishTurn();
  }

  const text = finalText(messages);
  const code = aborted ? EXIT.interrupted : errors.length > 0 ? EXIT.failed : EXIT.ok;
  if (json) {
    writeJson({ type: "result", ok: code === EXIT.ok, exitCode: code, sessionId: session.id, text, ...(errors.length > 0 ? { error: errors.join("\n") } : {}) });
  } else if (!aborted && text) {
    io.stdout(`${text}\n`);
  }
  return code;
}
