import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { createLeftoverWatch } from "./leftover-watch";
import type { Leftover } from "./leftovers";
import { useLeftoverCount } from "./use-leftovers";

// M6: the status line's count of leftover processes is scanned at most every 30 s on its own, and when a turn ends; never per keystroke.

const left = (pid: number): Leftover => ({ pid, pgid: pid, startedAt: pid, ageMs: 0, rssMb: 1, command: "x", groupOnly: true });

describe("createLeftoverWatch", () => {
  test("scans at most once per interval unless forced, one scan at a time", async () => {
    let clock = 0;
    let scans = 0;
    const watch = createLeftoverWatch({ scan: async () => (scans++, [left(10)]), intervalMs: 30_000, now: () => clock });
    await watch.refresh();
    expect(scans).toBe(1);
    expect(watch.list().map((item) => item.pid)).toEqual([10]);
    clock = 29_000;
    await watch.refresh();
    expect(scans).toBe(1);
    await watch.refresh({ force: true });
    expect(scans).toBe(2);
    clock = 70_000;
    await Promise.all([watch.refresh(), watch.refresh({ force: true })]);
    expect(scans).toBe(3);
  });

  test("tells its listeners when the list changes, and a stop scans again", async () => {
    let table = [left(10), left(11)];
    const stopped: unknown[] = [];
    const watch = createLeftoverWatch({
      scan: async () => table,
      stop: async (targets) => {
        stopped.push(targets);
        table = [left(11)];
        return { stopped: [], failed: [] };
      },
    });
    let heard = 0;
    watch.subscribe(() => heard++);
    await watch.refresh();
    expect(heard).toBe(1);
    await watch.refresh({ force: true });
    expect(heard).toBe(1);
    await watch.stop([{ pid: 10, startedAt: 10 }]);
    expect(stopped).toEqual([[{ pid: 10, startedAt: 10 }]]);
    expect(watch.list().map((item) => item.pid)).toEqual([11]);
    expect(heard).toBe(2);
  });

  test("a failed scan keeps the last list", async () => {
    let fail = false;
    const watch = createLeftoverWatch({ scan: async () => (fail ? Promise.reject(new Error("ps")) : [left(10)]) });
    await watch.refresh();
    fail = true;
    await watch.refresh({ force: true });
    expect(watch.list().map((item) => item.pid)).toEqual([10]);
  });
});

describe("useLeftoverCount", () => {
  const { testRender } = require("@opentui/react/test-utils") as typeof import("@opentui/react/test-utils");
  let screen: Awaited<ReturnType<typeof testRender>> | null = null;
  const saved = process.env.MARCSH_LEFTOVERS;
  afterEach(async () => {
    if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
    screen = null;
    if (saved === undefined) delete process.env.MARCSH_LEFTOVERS;
    else process.env.MARCSH_LEFTOVERS = saved;
  });

  async function mount(watch: ReturnType<typeof createLeftoverWatch>) {
    let setActive: (active: boolean) => void = () => {};
    function Probe() {
      const [active, set] = useState(true);
      setActive = set;
      return <text>{`count ${useLeftoverCount(active, watch)}`}</text>;
    }
    screen = await testRender(<Probe />, { width: 30, height: 3 });
    await act(() => new Promise<void>((r) => setTimeout(r, 30)));
    return { endTurn: () => act(async () => setActive(false)) };
  }

  test("off (tests' MARCSH_LEFTOVERS=off): never scans on its own", async () => {
    process.env.MARCSH_LEFTOVERS = "off";
    let scans = 0;
    const { endTurn } = await mount(createLeftoverWatch({ scan: async () => (scans++, []) }));
    await endTurn();
    expect(scans).toBe(0);
  });

  test("scans when shown and again when a turn ends, and shows the count", async () => {
    delete process.env.MARCSH_LEFTOVERS;
    let scans = 0;
    const watch = createLeftoverWatch({ scan: async () => (scans++, scans === 1 ? [] : [left(1), left(2)]) });
    const { endTurn } = await mount(watch);
    expect(scans).toBe(1);
    await endTurn();
    await act(() => new Promise<void>((r) => setTimeout(r, 30)));
    expect(scans).toBe(2);
    await screen!.renderOnce();
    expect(screen!.captureCharFrame()).toContain("count 2");
  });
});
