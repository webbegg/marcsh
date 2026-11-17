/** How long a first Ctrl+C waits for the second one that quits. */
export const QUIT_CONFIRM_MS = 1500;

export const QUIT_CONFIRM_MESSAGE = "ctrl+c again to quit";

export type QuitConfirmOptions = {
  windowMs?: number;
  /** The clock; tests pass their own. */
  now?: () => number;
};

/**
 * The double Ctrl+C: the first press arms, a second one inside the window quits, and a press after the window arms again.
 * Only a press nothing handled goes through here; a handled one (clearing text, closing a menu) calls `reset`.
 */
export function createQuitConfirm({ windowMs = QUIT_CONFIRM_MS, now = Date.now }: QuitConfirmOptions = {}) {
  let armedAt: number | null = null;

  return {
    /** True when this press is the second one and the app should quit. */
    press(): boolean {
      const t = now();
      if (armedAt !== null && t - armedAt <= windowMs) {
        armedAt = null;
        return true;
      }
      armedAt = t;
      return false;
    },
    reset() {
      armedAt = null;
    },
  };
}
