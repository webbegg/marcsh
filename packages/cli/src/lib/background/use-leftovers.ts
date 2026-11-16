import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { leftoverWatch, type LeftoverWatch } from "./leftover-watch";
import type { Leftover } from "./leftovers";

/** The status line scans only when not turned off (`MARCSH_LEFTOVERS=off`: tests, like `MARCSH_GIT_STATUS`). `/ps` and the tools always scan. */
const autoScanOff = () => process.env.MARCSH_LEFTOVERS?.trim().toLowerCase() === "off";

/** The wait when the next scan is already due (a scan slower than the interval): scans never run back to back. */
const MIN_TICK_MS = 1000;

/** The leftovers the watch last found, kept current. */
export function useLeftovers(watch: LeftoverWatch = leftoverWatch): readonly Leftover[] {
  return useSyncExternalStore(watch.subscribe, watch.list, watch.list);
}

/** Why the watch's last scan failed, or undefined. */
export function useLeftoverScanError(watch: LeftoverWatch = leftoverWatch): string | undefined {
  return useSyncExternalStore(watch.subscribe, watch.scanError, watch.scanError);
}

/**
 * How many leftover processes there are, for the status line. Nothing is scanned on its own until the first turn of this run starts
 * (before it, marcsh has started no tool process: no bash call, background terminal or Claude CLI); from then on, when the line
 * appears, an interval after the last scan (forced ones included), and when a turn ends (`turnActive` goes false). Never per keystroke.
 * After a failed scan the count is hidden (0) rather than shown stale; `/ps` says the scan failed.
 */
export function useLeftoverCount(turnActive: boolean, watch: LeftoverWatch = leftoverWatch): number {
  const count = useLeftovers(watch).length;
  const failed = useLeftoverScanError(watch) !== undefined;
  const [armed, setArmed] = useState(() => watch.armed());
  useEffect(() => {
    if (!turnActive || autoScanOff()) return;
    watch.arm();
    setArmed(true);
  }, [turnActive, watch]);
  useEffect(() => {
    if (!armed || autoScanOff()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const tick = () => {
      void watch.refresh().finally(() => {
        if (!done) timer = setTimeout(tick, watch.nextScanIn() || MIN_TICK_MS);
      });
    };
    tick();
    return () => {
      done = true;
      if (timer) clearTimeout(timer);
    };
  }, [armed, watch]);
  const wasActive = useRef(turnActive);
  useEffect(() => {
    if (wasActive.current && !turnActive && !autoScanOff() && watch.armed()) void watch.refresh({ force: true });
    wasActive.current = turnActive;
  }, [turnActive, watch]);
  return failed ? 0 : count;
}

