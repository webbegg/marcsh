import React, { 
  createContext, 
  useContext, 
  useState, 
  useCallback, 
  useEffect,
  useRef
} from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import { quitApp } from "../../lib/quit";
import { useToast, type ToastContextValue } from "../toast";
import { createQuitConfirm, QUIT_CONFIRM_MESSAGE, QUIT_CONFIRM_MS } from "./quit-confirm";

type Responder = () => boolean;

type KeyboardLayerContextValue = {
  push: (id: string, responder?: Responder) => void;
  pop: (id: string) => void;
  isTopLayer: (id: string) => boolean;
  setResponder: (id: string, responder: Responder | null) => void;
  /**
   * Whether a first Ctrl+C is waiting for its second one. While a prompt is on screen (see `registerPrompt`) the prompt says it in
   * its hint line, next to where the user looks; otherwise a toast does.
   */
  quitArmed: boolean;
  /** A prompt with a hint line is on screen: call it when it mounts and run the function it returns when it unmounts. */
  registerPrompt: () => () => void;
};

const KeyboardLayerContext = createContext<KeyboardLayerContextValue | null>(null);

type KeyboardLayerProviderProps = {
  children: React.ReactNode;
  /** What a confirmed Ctrl+C runs; tests replace it. */
  quit?: (renderer: ReturnType<typeof useRenderer>) => unknown;
  /** The window for the second Ctrl+C, in ms. */
  confirmWindowMs?: number;
  /** The clock of that window; tests pass their own. */
  now?: () => number;
};

// The toast is optional here: a layer mounted without a ToastProvider (small screens in tests) still quits, it just cannot show the hint.
function useOptionalToast(): ToastContextValue | null {
  try {
    return useToast();
  } catch {
    return null;
  }
}

export function KeyboardLayerProvider({
  children,
  quit = quitApp,
  confirmWindowMs = QUIT_CONFIRM_MS,
  now,
}: KeyboardLayerProviderProps) {
  const [stack, setStack] = useState<string[]>(["base"]);
  const stackRef = useRef(stack);
  stackRef.current = stack;

  const responders = useRef<Map<string, Responder>>(new Map());
  const renderer = useRenderer();
  const toast = useOptionalToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const confirm = useRef(createQuitConfirm({ windowMs: confirmWindowMs, now }));
  const [quitArmed, setQuitArmed] = useState(false);
  const armedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prompts = useRef(0);

  const disarm = useCallback(() => {
    if (armedTimer.current) clearTimeout(armedTimer.current);
    armedTimer.current = null;
    setQuitArmed(false);
  }, []);
  useEffect(() => disarm, [disarm]);

  const registerPrompt = useCallback(() => {
    prompts.current++;
    return () => {
      prompts.current--;
    };
  }, []);

  const push = useCallback((id: string, responder?: Responder) => {
    if (responder) {
      responders.current.set(id, responder);
    }

    setStack((prev) => {
      if (prev.includes(id)) {
        return prev;
      }

      return [...prev, id];
    });
  }, []);

  const pop = useCallback((id: string) => {
    responders.current.delete(id);
    setStack((prev) => prev.filter((layer) => layer !== id));
  }, []);

  const isTopLayer = useCallback(
    (id: string) => {
      return stack.length === 0 || stack[stack.length - 1] === id;
    },
    [stack],
  );

  const setResponder = useCallback((
    id: string,
    responder: Responder | null
  ) => {
    if (responder) {
      responders.current.set(id, responder);
    } else {
      responders.current.delete(id);
    }
  }, []);

  // Single ctrl+c handler that walks the responder chain
  useKeyboard((key) => {
    if (!key.ctrl || key.name !== "c") return;

    const currentStack = stackRef.current;
    for (let i = currentStack.length - 1; i >= 0; i--) {
      const layerId = currentStack[i]!;
      const responder = responders.current.get(layerId);
      if (responder && responder()) {
        // Handled (text cleared, a menu closed): not a first press.
        confirm.current.reset();
        disarm();
        return;
      }
    };

    // No responder handled it: the first press asks for a second one, which quits (stopping running turns first).
    if (confirm.current.press()) {
      disarm();
      void quit(renderer);
      return;
    }
    if (prompts.current > 0) {
      disarm();
      setQuitArmed(true);
      armedTimer.current = setTimeout(disarm, confirmWindowMs);
    } else {
      toastRef.current?.show({ message: QUIT_CONFIRM_MESSAGE, duration: confirmWindowMs });
    }
  });

  return (
    <KeyboardLayerContext.Provider 
      value={{ push, pop, isTopLayer, setResponder, quitArmed, registerPrompt }}
    >
      {children}
    </KeyboardLayerContext.Provider>
  );
};

export function useKeyboardLayer() {
  const context = useContext(KeyboardLayerContext);
  if (!context) {
    throw new Error("useKeyboardLayer must be used within a KeyboardLayerProvider");
  }
  return context;
};
