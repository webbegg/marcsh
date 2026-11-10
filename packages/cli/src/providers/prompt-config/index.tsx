import { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import type { ReactNode } from "react";
import { Mode, type ModeType } from "../../lib/modes";
import { DEFAULT_CHAT_MODEL_ID, PI_DEFAULT_MODEL, type SupportedChatModelId } from "../../lib/models";
import { getPiRuntime, type EngineId } from "../../lib/engine";
import { listAvailablePiModels, pickPiModel } from "../../lib/engine/pi-models";
import {
  getDefaultEngine,
  getPiModel,
  setDefaultEngine as persistDefaultEngine,
  setPiModel as persistPiModel,
} from "../../lib/preferences";

/**
 * What the status line may say about the pi model: `ready` = `piModel` is the one the next turn uses, `none` = no model has
 * credentials (the line says to run /login), `pending` = not checked yet (the line names no model).
 */
export type PiModelStatus = "pending" | "ready" | "none";

type PromptConfigContextValue = {
  mode: ModeType;
  toggleMode: () => void;
  setMode: (mode: ModeType) => void;
  model: SupportedChatModelId;
  setModel: (model: SupportedChatModelId) => void;
  /** The engine new sessions start on; an open session keeps the one it was created with. */
  defaultEngine: EngineId;
  setDefaultEngine: (engine: EngineId) => void;
  /** The model pi turns use ("provider/id"): the chosen one while it is available, else a fallback. */
  piModel: string;
  /** Whether `piModel` is known to be usable; see {@link PiModelStatus}. */
  piModelStatus: PiModelStatus;
  /** Picks the pi model for the following turns and for new pi sessions (kept in the preferences). */
  setPiModel: (model: string) => void;
  /** Checks the pi model against the models that have credentials now, and resolves with the one to use. */
  refreshPiModel: () => Promise<string>;
};

const PromptConfigContext = createContext<PromptConfigContextValue | null>(null);

export function usePromptConfig(): PromptConfigContextValue {
  const value = useContext(PromptConfigContext);
  if (!value) {
    throw new Error("usePromptConfig must be used within a PromptConfigProvider");
  }
  return value;
};

type PromptConfigProviderProps = {
  children: ReactNode;
};

export function PromptConfigProvider({ children }: PromptConfigProviderProps) {
  const [mode, setMode] = useState<ModeType>(Mode.BUILD);
  const [model, setModel] = useState<SupportedChatModelId>(DEFAULT_CHAT_MODEL_ID);

  const [defaultEngine, setDefaultEngineState] = useState<EngineId>(() => getDefaultEngine());

  const setDefaultEngine = useCallback((engine: EngineId) => {
    setDefaultEngineState(engine);
    persistDefaultEngine(engine);
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

  const setPiModel = useCallback((next: string) => {
    preferredPiModel.current = next;
    applyPiModel(next);
    persistPiModel(next);
  }, [applyPiModel]);

  const refreshPiModel = useCallback(async () => {
    try {
      const available = await listAvailablePiModels(await getPiRuntime());
      const next = pickPiModel(preferredPiModel.current, available);
      applyPiModel(next, available.length > 0 ? "ready" : "none");
      return next;
    } catch {
      // No runtime to ask: keep what is in use; a turn then reports what is missing.
      setPiModelStatus((status) => (status === "pending" ? "ready" : status));
      return piModelInUse.current;
    }
  }, [applyPiModel]);

  // New sessions start on pi: the status line on the home screen shows the model they will use.
  useEffect(() => {
    if (defaultEngine === "pi") void refreshPiModel();
  }, [defaultEngine, refreshPiModel]);

  const toggleMode = useCallback(() => {
    setMode((m) => (m === Mode.BUILD ? Mode.PLAN : Mode.BUILD));
  }, []);

  return (
    <PromptConfigContext.Provider 
      value={{ 
        mode, 
        toggleMode, 
        setMode, 
        model, 
        setModel,
        defaultEngine,
        setDefaultEngine,
        piModel,
        piModelStatus,
        setPiModel,
        refreshPiModel,
    }}>
      {children}
    </PromptConfigContext.Provider>
  );
};
