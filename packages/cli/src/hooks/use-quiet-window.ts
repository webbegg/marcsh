import { useCallback, useEffect, useRef, useState } from "react";

// Answer keys count only once the keyboard has been quiet this long, so text still being typed can't answer a prompt.
const QUIET_MS = 300;

/**
 * Tracks whether the keyboard has been quiet for the quiet window since `scope` (the prompt's request) appeared
 * or `restart` was last called. The wait starts when the scope changes; unmount clears it.
 */
export function useQuietWindow(scope: unknown) {
  const [quietScope, setQuietScope] = useState<unknown>(null);
  const quietTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const quietRef = useRef(false);

  const restart = useCallback(() => {
    clearTimeout(quietTimer.current);
    quietRef.current = false;
    setQuietScope(null);
    quietTimer.current = setTimeout(() => {
      quietRef.current = true;
      setQuietScope(scope);
    }, QUIET_MS);
  }, [scope]);

  useEffect(() => {
    restart();
    return () => clearTimeout(quietTimer.current);
  }, [restart]);

  return {
    /** For rendering: true once the window has passed for the current scope. */
    quiet: quietScope === scope,
    /** For key handlers: true as soon as the window has passed, without waiting for a render. */
    isQuiet: () => quietRef.current,
    restart,
  };
}
