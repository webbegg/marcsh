import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import "./spinner";

// marcsh draws its own spinner since OpenTUI 0.9 (opentui-spinner does not run on it): the same "aesthetic" frames, advancing on their own.

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
afterEach(() => {
  if (screen && !screen.renderer.isDestroyed) act(() => screen!.renderer.destroy());
  screen = null;
});

const FRAMES = ["▰▱▱▱▱▱▱", "▰▰▱▱▱▱▱", "▰▰▰▱▱▱▱", "▰▰▰▰▱▱▱", "▰▰▰▰▰▱▱", "▰▰▰▰▰▰▱", "▰▰▰▰▰▰▰"];
const shown = () => FRAMES.find((frame) => screen!.captureCharFrame().includes(frame));

test("the spinner draws the aesthetic frames beside its siblings, and moves on by itself", async () => {
  screen = await testRender(
    <box flexDirection="row" gap={2}>
      <spinner color="#ff0000" />
      <text>esc to interrupt</text>
    </box>,
    { width: 40, height: 3 },
  );
  await screen.renderOnce();
  const first = screen.captureCharFrame().split("\n")[0]!;
  expect(first.startsWith("▰▱▱▱▱▱▱  esc to interrupt")).toBe(true);

  // Nothing else asks for frames here: the spinner's own animation does.
  let frames = 0;
  screen.renderer.on("frame", () => frames++);
  await act(() => new Promise<void>((r) => setTimeout(r, 400)));
  expect(frames).toBeGreaterThanOrEqual(3);

  const seen = new Set<string>();
  for (let i = 0; i < 20 && seen.size < 3; i++) {
    await act(() => new Promise<void>((r) => setTimeout(r, 40)));
    await screen.renderOnce();
    const frame = shown();
    if (frame) seen.add(frame);
  }
  expect(seen.size).toBeGreaterThanOrEqual(3);
});
