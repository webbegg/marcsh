import { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import type { ReactNode } from "react";
import type { ModeType } from "../../lib/modes";
import { findAgent, loadAgents, nextAgent, type Agent } from "../../lib/agents";
import { isChatModelId, lastUsedModel, PI_DEFAULT_MODEL, type SupportedChatModelId } from "../../lib/models";
import { getPiRuntime, type EngineId } from "../../lib/engine";
import { DEFAULT_APPROVAL_MODE, type ApprovalMode } from "../../lib/approval-policy";
import { listAvailablePiModels, pickPiModel, pickTurnPiModel } from "../../lib/engine/pi-models";
import {
  getAgentId,
  getClaudeModel,
  getDefaultApprovalMode,
  getDefaultEngine,
  getPiModel,
  setAgentId,
  setClaudeModel as persistClaudeModel,
  setDefaultApprovalMode as persistDefaultApprovalMode,
  setDefaultEngine as persistDefaultEngine,
  setPiModel as persistPiModel,
} from "../../lib/preferences";

/**
 * What the status line may say about the pi model: `ready` = `piModel` is the one the next turn uses, `none` = no model has
 * credentials (the line says to run /login), `pending` = not checked yet (the line names no model), `unavailable` = the
 * check failed or took too long, so no model can be named (the line says pi is unavailable).
 */
export type PiModelStatus = "pending" | "ready" | "none" | "unavailable";

type PromptConfigContextValue = {
  /** Build, Plan, then the user's own agents; Tab cycles them in this order. */
  agents: Agent[];
  /** The selected agent: its permission profile is `mode`, its prompt and model go with every turn. */
  agent: Agent;
  /** The selected agent's permission profile. */
  mode: ModeType;
  /** Selects the agent with this ID (Build when it is gone) and keeps the choice; resolves the selected agent. */
  selectAgent: (id: string) => Agent;
  /** Selects the agent after the current one, wrapping around; resolves the selected agent. */
  cycleAgent: () => Agent;
  /** Reads the agent files again (one may have been added or removed) and resolves the new list. */
  reloadAgents: () => Agent[];
  /** The Claude model Claude turns use; starts as the one the user last chose (kept in the preferences). */
  model: SupportedChatModelId;
  /** Picks the Claude model for the following turns and for new Claude sessions (kept in the preferences). */
  setModel: (model: SupportedChatModelId) => void;
  /**
   * Makes an opened (resumed) session start on the model it used last, for this run only: the saved choices stay as they are. A
   * model that is not usable on the session's engine (not a Claude alias, not a pi ref, no model named) leaves the current one;
   * a pi model that has no credentials any more is replaced by the saved pick at the next check.
   */
  adoptSessionModel: (engine: string, messages: readonly { metadata?: { model?: string } }[]) => void;
  /** The engine new sessions start on; an open session keeps the one it was created with. */
  defaultEngine: EngineId;
  setDefaultEngine: (engine: EngineId) => void;
  /** What the policy lets run without asking in this app session; apart from the agent's Plan/Build `mode`. Not kept unless saved as the default. */
  approvalMode: ApprovalMode;
  setApprovalMode: (mode: ApprovalMode) => void;
  /** The approval mode new sessions start in (kept in the preferences); `approvalMode` starts as this. */
  defaultApprovalMode: ApprovalMode;
  setDefaultApprovalMode: (mode: ApprovalMode) => void;
  /** The model pi turns use ("provider/id"): the chosen one while it is available, else a fallback. */
  piModel: string;
  /** Whether `piModel` is known to be usable; see {@link PiModelStatus}. */
  piModelStatus: PiModelStatus;
  /** Picks the pi model for the following turns and for new pi sessions (kept in the preferences). */
  setPiModel: (model: string) => void;
  /**
   * Checks the pi model against the models that have credentials now, and resolves with the one to use: `turnModel` (an
   * agent's) when it is available, else the same pick the status line shows.
   */
  refreshPiModel: (turnModel?: string) => Promise<string>;
};

/** How long the pi model check may take before it counts as failed. Mutable so tests can shorten it. */
export const piModelCheck = { timeoutMs: 15_000 };

// Fails when `work` takes longer than `ms`; its late result is dropped.
function withinLimit<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The pi model check took longer than ${ms} ms`)), ms);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** A pi model ref: "provider/id". */
const PI_REF = /^[^/\s]+\/\S+$/;

const PromptConfigContext = createContext<PromptConfigContextValue | null>(null);

export function usePromptConfig(): PromptConfigContextValue {
  const value = useContext(PromptConfigContext);
  if (!value) {
    throw new Error("usePromptConfig must be used within a PromptConfigProvider");
  }
  return value;
};

/** The approval mode in use, or normal outside a provider: for hooks that must not throw there. */
export function useApprovalMode(): ApprovalMode {
  return useContext(PromptConfigContext)?.approvalMode ?? DEFAULT_APPROVAL_MODE;
}

type PromptConfigProviderProps = {
  children: ReactNode;
};

export function PromptConfigProvider({ children }: PromptConfigProviderProps) {
  const [agents, setAgents] = useState<Agent[]>(() => loadAgents());
  const [agentId, setAgentIdState] = useState(() => findAgent(agents, getAgentId()).id);
  const agent = findAgent(agents, agentId);
  // Tab can fire twice before a render: the next agent is computed from what was selected last, not from the render.
  const agentsRef = useRef(agents);
  const agentIdRef = useRef(agentId);

  const selectAgent = useCallback((id: string) => {
    const next = findAgent(agentsRef.current, id);
    agentIdRef.current = next.id;
    setAgentIdState(next.id);
    setAgentId(next.id);
    return next;
  }, []);

  const cycleAgent = useCallback(() => selectAgent(nextAgent(agentsRef.current, agentIdRef.current).id), [selectAgent]);

  const reloadAgents = useCallback(() => {
    const loaded = loadAgents();
    agentsRef.current = loaded;
    setAgents(loaded);
    return loaded;
  }, []);

  const [model, setModelState] = useState<SupportedChatModelId>(() => getClaudeModel());

  const setModel = useCallback((next: SupportedChatModelId) => {
    setModelState(next);
    persistClaudeModel(next);
  }, []);

  const [defaultEngine, setDefaultEngineState] = useState<EngineId>(() => getDefaultEngine());

  const setDefaultEngine = useCallback((engine: EngineId) => {
    setDefaultEngineState(engine);
    persistDefaultEngine(engine);
  }, []);

  const [defaultApprovalMode, setDefaultApprovalModeState] = useState<ApprovalMode>(() => getDefaultApprovalMode());
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(defaultApprovalMode);

  const setDefaultApprovalMode = useCallback((next: ApprovalMode) => {
    setDefaultApprovalModeState(next);
    persistDefaultApprovalMode(next);
  }, []);

  // What the user chose stays apart from what is in use: a model that is unavailable for a while
  // (logged out) is replaced for the turns, and comes back when its provider has credentials again.
  const preferredPiModel = useRef(getPiModel() ?? PI_DEFAULT_MODEL);
  const piModelInUse = useRef(preferredPiModel.current);
  const [piModel, setPiModelState] = useState(preferredPiModel.current);
  // A stored choice is the best guess until the check answers; without one the built-in default is not worth showing.
  const [piModelStatus, setPiModelStatus] = useState<PiModelStatus>(() => (getPiModel() ? "ready" : "pending"));

  const applyPiModel = useCallback((next: string, status: PiModelStatus = "ready") => {
    piModelInUse.current = next;
    setPiModelState(next);
    setPiModelStatus(status);
  }, []);

  // The pi model a resumed session used: tried first at each check, until the user picks another.
  const sessionPiModel = useRef<string | undefined>(undefined);

  const setPiModel = useCallback((next: string) => {
    preferredPiModel.current = next;
    sessionPiModel.current = undefined;
    applyPiModel(next);
    persistPiModel(next);
  }, [applyPiModel]);

  // Checks overlap (a screen opening, a turn starting): only the latest one may change what the line says.
  const latestCheck = useRef(0);

  const refreshPiModel = useCallback(async (turnModel?: string) => {
    const check = ++latestCheck.current;
    try {
      const available = await withinLimit(
        (async () => listAvailablePiModels(await getPiRuntime()))(),
        piModelCheck.timeoutMs,
      );
      const session = sessionPiModel.current;
      const wanted = session && available.some((option) => option.ref === session) ? session : preferredPiModel.current;
      const next = pickPiModel(wanted, available);
      if (check === latestCheck.current) applyPiModel(next, available.length > 0 ? "ready" : "none");
      return pickTurnPiModel(turnModel, wanted, available);
    } catch {
      // No runtime to ask, or it took too long: the line names no model (the built-in default is only a guess), nothing is
      // shown as a toast, and a turn still goes out with what is in use so it reports what is missing.
      if (check === latestCheck.current) setPiModelStatus("unavailable");
      return piModelInUse.current;
    }
  }, [applyPiModel]);

  const adoptSessionModel = useCallback((engine: string, messages: readonly { metadata?: { model?: string } }[]) => {
    const used = lastUsedModel(messages);
    if (engine === "pi") {
      if (!used || !PI_REF.test(used)) return;
      sessionPiModel.current = used;
      applyPiModel(used);
    } else if (engine === "claude" && isChatModelId(used)) {
      setModelState(used);
    }
  }, [applyPiModel]);

  // New sessions start on pi: the status line on the home screen shows the model they will use.
  useEffect(() => {
    if (defaultEngine === "pi") void refreshPiModel();
  }, [defaultEngine, refreshPiModel]);

  return (
    <PromptConfigContext.Provider 
      value={{ 
        agents,
        agent,
        mode: agent.mode,
        selectAgent,
        cycleAgent,
        reloadAgents,
        model, 
        setModel,
        adoptSessionModel,
        defaultEngine,
        setDefaultEngine,
        approvalMode,
        setApprovalMode,
        defaultApprovalMode,
        setDefaultApprovalMode,
        piModel,
        piModelStatus,
        setPiModel,
        refreshPiModel,
    }}>
      {children}
    </PromptConfigContext.Provider>
  );
};
