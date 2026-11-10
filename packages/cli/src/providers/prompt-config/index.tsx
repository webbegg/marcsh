import { createContext, useContext, useState, useCallback } from "react";
import type { ReactNode } from "react";
import { Mode, type ModeType } from "../../lib/modes";
import { DEFAULT_CHAT_MODEL_ID, type SupportedChatModelId } from "../../lib/models";
import type { EngineId } from "../../lib/engine";
import { getDefaultEngine, setDefaultEngine as persistDefaultEngine } from "../../lib/preferences";

type PromptConfigContextValue = {
  mode: ModeType;
  toggleMode: () => void;
  setMode: (mode: ModeType) => void;
  model: SupportedChatModelId;
  setModel: (model: SupportedChatModelId) => void;
  /** The engine new sessions start on; an open session keeps the one it was created with. */
  defaultEngine: EngineId;
  setDefaultEngine: (engine: EngineId) => void;
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
    }}>
      {children}
    </PromptConfigContext.Provider>
  );
};
