// Pastes run one at a time, in order. Follows opencode's prompt `enqueuePaste` (MIT; see THIRD_PARTY_NOTICES.md).

export const PASTE_TIMED_OUT = "The paste took too long and was dropped.";

/** A job is told whether its time ran out (`expired`): one that ends late must not put anything in. */
export type PasteJob = (expired: () => boolean) => Promise<void>;

export type PasteQueue = {
  enqueue(job: PasteJob): void;
  /** Whether no job is waiting or running. */
  readonly idle: boolean;
};

/**
 * Runs paste jobs one after the other. Each has `timeoutMs` to finish (a stuck clipboard or a stale network mount): then it is
 * reported through `onError` and the next job starts. A job that fails is reported the same way.
 */
export function createPasteQueue({ timeoutMs, onError }: { timeoutMs: number; onError: (error: unknown) => void }): PasteQueue {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  return {
    get idle() {
      return pending === 0;
    },
    enqueue(job) {
      pending++;
      tail = tail.then(async () => {
        let expired = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(new Error(PASTE_TIMED_OUT));
          }, timeoutMs);
        });
        try {
          await Promise.race([job(() => expired), deadline]);
        } catch (error) {
          onError(error);
        } finally {
          clearTimeout(timer);
          pending--;
        }
      });
    },
  };
}
