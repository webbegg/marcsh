import { useEffect, useRef, useSyncExternalStore } from "react";
import { LEFTOVER_SCAN_INTERVAL_MS, leftoverWatch, type LeftoverWatch } from "./leftover-watch";
import type { Leftover } from "./leftovers";

/** The status line scans only when not turned off (`MARCSH_LEFTOVERS=off`: tests, like `MARCSH_GIT_STATUS`). `/ps` and the tools always scan. */
const autoScanOff = () => process.env.MARCSH_LEFTOVERS?.trim().toLowerCase() === "off";

/** The leftovers the watch last found, kept current. */
export function useLeftovers(watch: LeftoverWatch = leftoverWatch): readonly Leftover[] {
  return useSyncExternalStore(watch.subscribe, watch.list, watch.list);
}

/**
 * How many leftover processes there are, for the status line: scanned when the line appears, every `LEFTOVER_SCAN_INTERVAL_MS` at most,
 * and when a turn ends (`turnActive` goes false). Never per keystroke.
 */
export function useLeftoverCount(turnActive: boolean, watch: LeftoverWatch = leftoverWatch): number {
  const count = useLeftovers(watch).length;
  useEffect(() => {
    if (autoScanOff()) return;
    void watch.refresh();
    const timer = setInterval(() => void watch.refresh(), LEFTOVER_SCAN_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [watch]);
  const wasActive = useRef(turnActive);
  useEffect(() => {
    if (wasActive.current && !turnActive && !autoScanOff()) void watch.refresh({ force: true });
    wasActive.current = turnActive;
  }, [turnActive, watch]);
  return count;
}
