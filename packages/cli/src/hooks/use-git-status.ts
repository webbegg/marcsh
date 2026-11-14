import { useEffect, useRef, useState } from "react";
import { readGitStatus, type GitStatus } from "../lib/git-status";

type Options = {
  /** Reads the git state of a folder; injectable so tests do not spawn git. */
  read?: (cwd: string) => Promise<GitStatus | null>;
  /** Any value that changes when the files may have changed (e.g. after a tool call); each change reads again. */
  trigger?: unknown;
  intervalMs?: number;
};

const same = (a: GitStatus | null, b: GitStatus | null) => a === b || (a !== null && b !== null && a.branch === b.branch && a.changed === b.changed);

/**
 * The git state of `cwd`, read on mount, every `intervalMs` and whenever `trigger` changes; null until known, outside a repo
 * and without a folder. One read runs at a time: asking during a read runs one more read after it, however often it was asked.
 */
export function useGitStatus(cwd: string | undefined, { read = readGitStatus, trigger, intervalMs = 3000 }: Options = {}): GitStatus | null {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const readRef = useRef(read);
  readRef.current = read;
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    setStatus(null);
    if (cwd === undefined) return;

    let alive = true;
    let reading = false;
    let again = false;
    const refresh = () => {
      if (!alive) return;
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      void readRef
        .current(cwd)
        .catch(() => null)
        .then((next) => {
          reading = false;
          if (!alive) return;
          setStatus((previous) => (same(previous, next) ? previous : next));
          if (again) {
            again = false;
            refresh();
          }
        });
    };

    refreshRef.current = refresh;
    refresh();
    const timer = setInterval(refresh, intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
      refreshRef.current = () => {};
    };
  }, [cwd, intervalMs]);

  // The mount read above covers the first value of the trigger.
  const firstTrigger = useRef(true);
  useEffect(() => {
    if (firstTrigger.current) {
      firstTrigger.current = false;
      return;
    }
    refreshRef.current();
  }, [trigger]);

  return status;
}
