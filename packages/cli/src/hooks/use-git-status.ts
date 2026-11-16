import { useEffect, useRef, useState } from "react";
import type { BranchState } from "../lib/git-branch";
import { readGitBranchState, readGitStatus, type GitStatus } from "../lib/git-status";
import { projectTrustHolds } from "../lib/engine/pi-trust";
import { getStorage } from "../lib/storage";

/** Reads the git state of a folder; `trusted` says whether it may count the changed files (see `readGitStatus`). */
export type GitReader = (cwd: string, options: { trusted: boolean }) => Promise<GitStatus | null>;

type Options = {
  /** Reads the git state of a folder; injectable so tests do not spawn git. */
  read?: GitReader;
  /** Whether the user trusted the project at `cwd`; asked before every read, so a `/trust` change applies from the next one. */
  isTrusted?: (cwd: string) => boolean;
  /** Any value that changes when the files may have changed (e.g. after a tool call); each change reads again. */
  trigger?: unknown;
  intervalMs?: number;
};

/** git's answer, or none while `MARCSH_GIT_STATUS=off` (the test preload sets it, so screens tested without a reader never spawn git). */
const defaultRead: GitReader = (cwd, { trusted }) =>
  process.env.MARCSH_GIT_STATUS?.trim().toLowerCase() === "off" ? Promise.resolve(null) : readGitStatus(cwd, { trusted });

/**
 * marcsh's own trust for the project at `cwd` (the pi trust question, `/trust`), by the rule project commands follow too
 * (`projectTrustHolds`): a stored "trusted" whose review still equals the project. Undecided, untrusted, stale, a trust from before
 * reviews, or a store that cannot be read does not count. Cheap enough for every poll: the review is cached.
 */
export function trustedForGit(cwd: string): boolean {
  return projectTrustHolds(cwd, getStorage);
}

const safely = (isTrusted: (cwd: string) => boolean, cwd: string) => {
  try {
    return isTrusted(cwd) === true;
  } catch {
    return false;
  }
};

/** The longest wait between two polls after reads that found nothing (or an `intervalMs` above it). */
export const MAX_GIT_BACKOFF_MS = 60_000;

const same = (a: GitStatus | null, b: GitStatus | null) =>
  a === b || (a !== null && b !== null && a.branch === b.branch && a.changed === b.changed && a.worktree === b.worktree);

/**
 * The git state of `cwd`, read on mount, every `intervalMs` and whenever `trigger` changes; null until known, outside a repo
 * and without a folder. One read runs at a time: asking during a read runs one more read after it, however often it was asked.
 * A read that finds nothing (git timed out or failed, or no repo) doubles the wait before the next poll, up to
 * `MAX_GIT_BACKOFF_MS`, and a poll that came during it is dropped; a trigger still reads, and a good read resets the wait.
 * The changed files are counted only while `isTrusted` says the project is trusted; otherwise the branch comes alone.
 */
export function useGitStatus(cwd: string | undefined, { read = defaultRead, isTrusted = trustedForGit, trigger, intervalMs = 3000 }: Options = {}): GitStatus | null {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const readRef = useRef(read);
  readRef.current = read;
  const trustRef = useRef(isTrusted);
  trustRef.current = isTrusted;
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
        .current(cwd, { trusted: safely(trustRef.current, cwd) })
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

/** Reads where a folder's checkout stands for the approval policy (see `branchState`); a sync answer is taken too (tests). */
export type BranchReader = (cwd: string) => Promise<BranchState> | BranchState;

type BranchOptions = {
  /** Default: `readGitBranchState`, the status line's hardened async git reads. */
  read?: BranchReader;
  /** Any value that changes when the branch may have changed (the polled git branch, a finished tool call); each change reads again. */
  trigger?: unknown;
  /** Whether to poll on its own every `pollMs` (when nothing else tells it the branch changed: git status off or failing). */
  poll?: boolean;
  pollMs?: number;
};

/** The last state read per folder, so a status line mounted again shows it at once rather than flickering. Oldest entries go first. */
const lastBranch = new Map<string, BranchState>();
const MAX_BRANCHES = 32;
const remember = (cwd: string, state: BranchState) => {
  lastBranch.delete(cwd);
  if (lastBranch.size >= MAX_BRANCHES) lastBranch.delete(lastBranch.keys().next().value!);
  lastBranch.set(cwd, state);
};

/**
 * Where the checkout at `cwd` stands, read asynchronously (never in render): on mount, whenever `trigger` changes and, while `poll`
 * is on, every `pollMs`. One read at a time (asking during one reads once more after it); a read that fails keeps the last state.
 * Null until known and without a folder (nothing is read then).
 */
export function useBranchState(cwd: string | undefined, { read = readGitBranchState, trigger, poll = false, pollMs = 3000 }: BranchOptions = {}): BranchState | null {
  const [state, setState] = useState<BranchState | null>(() => (cwd === undefined ? null : (lastBranch.get(cwd) ?? null)));
  const readRef = useRef(read);
  readRef.current = read;
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    setState(cwd === undefined ? null : (lastBranch.get(cwd) ?? null));
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
      void Promise.resolve()
        .then(() => readRef.current(cwd))
        .then(
          (next) => {
            remember(cwd, next);
            return next;
          },
          () => null,
        )
        .then((next) => {
          reading = false;
          if (!alive) return;
          if (next !== null) setState((previous) => (previous !== null && sameBranch(previous, next) ? previous : next));
          if (again) {
            again = false;
            refresh();
          }
        });
    };
    refreshRef.current = refresh;
    refresh();
    const timer = poll ? setInterval(refresh, pollMs) : undefined;
    return () => {
      alive = false;
      clearInterval(timer);
      refreshRef.current = () => {};
    };
  }, [cwd, poll, pollMs]);

  // The mount read above covers the first value of the trigger.
  const firstTrigger = useRef(true);
  useEffect(() => {
    if (firstTrigger.current) {
      firstTrigger.current = false;
      return;
    }
    refreshRef.current();
  }, [trigger]);

  return state;
}

const sameBranch = (a: BranchState, b: BranchState) =>
  a.kind === b.kind && (a.kind === "none" ? a.reason === (b as typeof a).reason : a.branch === (b as typeof a).branch);
