import { describe, expect, test } from "bun:test";
import { createPasteQueue, PASTE_TIMED_OUT } from "./paste-queue";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createPasteQueue", () => {
  test("runs the jobs one at a time, in order, and is idle once they are done", async () => {
    const order: string[] = [];
    const queue = createPasteQueue({ timeoutMs: 1000, onError: () => {} });
    expect(queue.idle).toBe(true);

    queue.enqueue(async () => {
      await tick(10);
      order.push("first");
    });
    queue.enqueue(async () => {
      order.push("second");
    });
    expect(queue.idle).toBe(false);
    await tick(30);

    expect(order).toEqual(["first", "second"]);
    expect(queue.idle).toBe(true);
  });

  test("a job that fails is reported and the next one still runs", async () => {
    const errors: unknown[] = [];
    let ran = false;
    const queue = createPasteQueue({ timeoutMs: 1000, onError: (error) => errors.push(error) });

    queue.enqueue(async () => {
      throw new Error("boom");
    });
    queue.enqueue(async () => {
      ran = true;
    });
    await tick(10);

    expect((errors[0] as Error).message).toBe("boom");
    expect(ran).toBe(true);
  });

  test("a job that never settles times out: it is reported, told it expired, and the queue moves on", async () => {
    const errors: unknown[] = [];
    let expired: () => boolean = () => false;
    let ran = false;
    const queue = createPasteQueue({ timeoutMs: 20, onError: (error) => errors.push(error) });

    queue.enqueue((isExpired) => {
      expired = isExpired;
      return new Promise(() => {});
    });
    queue.enqueue(async () => {
      ran = true;
    });
    expect(expired()).toBe(false);
    await tick(50);

    expect((errors[0] as Error).message).toBe(PASTE_TIMED_OUT);
    expect(expired()).toBe(true);
    expect(ran).toBe(true);
    expect(queue.idle).toBe(true);
  });
});
