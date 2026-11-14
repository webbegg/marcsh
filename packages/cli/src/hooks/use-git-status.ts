import { useEffect, useRef, useState } from "react";
import { readGitStatus, type GitStatus } from "../lib/git-status";

type Options = {
  /** Reads the git state of a folder; injectable so tests do not spawn git. */
  read?: (cwd: string) => Promise<GitStatus | null>;
  /** Any value that changes when the files may have changed (e.g. after a tool call); each change reads again. */
  trigger?: unknown;
  intervalMs?: number;
};

/** git's answer, or none while `MARCSH_GIT_STATUS=off` (the test preload sets it, so screens tested without a reader never spawn git). */
const defaultRead = (cwd: string): Promise<GitStatus | null> =>
  process.env.MARCSH_GIT_STATUS?.trim().toLowerCase() === "off" ? Promise.resolve(null) : readGitStatus(cwd);

/** The longest wait between two polls after reads that found nothing (or an `intervalMs` above it). */
export const MAX_GIT_BACKOFF_MS = 60_000;

const same = (a: GitStatus | null, b: GitStatus | null) => a === b || (a !== null && b !== null && a.branch === b.branch && a.changed === b.changed);

/**
 * The git state of `cwd`, read on mount, every `intervalMs` and whenever `trigger` changes; null until known, outside a repo
 * and without a folder. One read runs at a time: asking during a read runs one more read after it, however often it was asked.
 * A read that finds nothing (git timed out or failed, or no repo) doubles the wait before the next poll, up to
 * `MAX_GIT_BACKOFF_MS`, and a poll that came during it is dropped; a trigger still reads, and a good read resets the wait.
 */
export function useGitStatus(cwd: string | undefined, { read = defaultRead, trigger, intervalMs = 3000 }: Options = {}): GitStatus | null {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const readRef = useRef(read);
  readRef.current = read;
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    setStatus(null);
    if (cwd === undefined) return;

    let alive = true;
    let reading = false;
    /** Asked during a read by a trigger, and by a poll. */
    let again = false;
    let againByPoll = false;
    const maxDelay = Math.max(intervalMs, MAX_GIT_BACKOFF_MS);
    let delay = intervalMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(poll, delay);
    };
    const refresh = (byPoll = false) => {
      if (!alive) return;
      if (reading) {
        if (byPoll) againByPoll = true;
        else again = true;
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
          const failed = next === null;
          if (failed) {
            delay = Math.min(delay * 2, maxDelay);
            schedule();
          } else if (delay !== intervalMs) {
            delay = intervalMs;
            schedule();
          }
          const rerun = again || (!failed && againByPoll);
          again = false;
          againByPoll = false;
          if (rerun) refresh();
        });
    };
    const poll = () => {
      schedule();
      refresh(true);
    };

    refreshRef.current = () => refresh();
    refresh();
    schedule();
    return () => {
      alive = false;
      clearTimeout(timer);
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
