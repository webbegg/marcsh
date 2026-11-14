import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import type { GitStatus } from "../lib/git-status";

const { testRender } = await import("@opentui/react/test-utils");
const { useGitStatus } = await import("./use-git-status");

// S6: the git segment is refreshed every few seconds and after tool calls, with one git call at a time.

let latest: GitStatus | null = null;
let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = (ms = 20) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  latest = null;
});

// A read that answers only when the test releases it, recording every call.
function fakeRead() {
  const calls: string[] = [];
  const pending: Array<(status: GitStatus | null) => void> = [];
  const read = (cwd: string) => {
    calls.push(cwd);
    return new Promise<GitStatus | null>((resolve) => pending.push(resolve));
  };
  const answer = async (status: GitStatus | null) => {
    const next = pending.shift();
    if (!next) throw new Error("no read is waiting");
    await act(async () => next(status));
  };
  return { read, calls, pending, answer };
}

function Probe(props: { cwd?: string; read: (cwd: string) => Promise<GitStatus | null>; trigger?: unknown; intervalMs?: number }) {
  latest = useGitStatus(props.cwd, { read: props.read, trigger: props.trigger, intervalMs: props.intervalMs ?? 60_000 });
  return <text>probe</text>;
}

let setTrigger: (value: number) => void = () => {};
// Holds the trigger in state so a test can change it without remounting.
function Host(props: { cwd?: string; read: (cwd: string) => Promise<GitStatus | null> }) {
  const [trigger, set] = useState(0);
  setTrigger = set;
  return <Probe {...props} trigger={trigger} />;
}

async function mount(element: React.ReactNode) {
  screen = await testRender(element, { width: 20, height: 2 });
  await settle();
}

describe("useGitStatus", () => {
  test("reads once on mount and shows the answer", async () => {
    const fake = fakeRead();
    await mount(<Probe cwd="/repo" read={fake.read} />);

    expect(fake.calls).toEqual(["/repo"]);
    expect(latest).toBeNull();
    await fake.answer({ branch: "main", changed: 2 });
    expect(latest).toEqual({ branch: "main", changed: 2 });
  });

  test("does nothing without a folder", async () => {
    const fake = fakeRead();
    await mount(<Probe read={fake.read} intervalMs={10} />);
    await settle(50);

    expect(fake.calls).toEqual([]);
    expect(latest).toBeNull();
  });

  test("polls on the interval", async () => {
    const fake = fakeRead();
    await mount(<Probe cwd="/repo" read={fake.read} intervalMs={30} />);
    await fake.answer({ branch: "main", changed: 0 });
    await settle(45);

    expect(fake.calls.length).toBe(2);
    await fake.answer({ branch: "main", changed: 5 });
    expect(latest).toEqual({ branch: "main", changed: 5 });
  });

  test("keeps one read in flight and runs at most one more after it", async () => {
    const fake = fakeRead();
    await mount(<Probe cwd="/repo" read={fake.read} intervalMs={10} />);
    await settle(80);

    expect(fake.calls.length).toBe(1);
    await fake.answer({ branch: "main", changed: 0 });
    await settle(0);
    expect(fake.calls.length).toBe(2);
  });

  test("reads again when the trigger changes", async () => {
    const fake = fakeRead();
    await mount(<Host cwd="/repo" read={fake.read} />);
    await fake.answer({ branch: "main", changed: 0 });
    expect(fake.calls.length).toBe(1);

    await act(async () => setTrigger(1));
    expect(fake.calls.length).toBe(2);
    await fake.answer({ branch: "main", changed: 1 });
    expect(latest).toEqual({ branch: "main", changed: 1 });
  });

  test("a trigger during a read runs one more read after it", async () => {
    const fake = fakeRead();
    await mount(<Host cwd="/repo" read={fake.read} />);
    await act(async () => setTrigger(1));
    await act(async () => setTrigger(2));

    expect(fake.calls.length).toBe(1);
    await fake.answer({ branch: "main", changed: 0 });
    await settle(0);
    expect(fake.calls.length).toBe(2);
  });

  test("stops polling and never updates after unmount", async () => {
    const fake = fakeRead();
    await mount(<Probe cwd="/repo" read={fake.read} intervalMs={10} />);
    await fake.answer({ branch: "main", changed: 0 });
    await settle(15);
    expect(fake.calls.length).toBe(2);
    const counted = latest;

    await act(async () => screen!.renderer.destroy());
    screen = null;
    latest = null;
    await fake.answer({ branch: "main", changed: 9 });
    await settle(50);

    expect(counted).toEqual({ branch: "main", changed: 0 });
    expect(fake.calls.length).toBe(2);
    expect(latest).toBeNull();
  });
});
