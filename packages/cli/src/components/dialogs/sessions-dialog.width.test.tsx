import { afterEach, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { SessionListEntry } from "../../lib/storage";
import { SessionRow } from "./sessions-dialog";

const now = new Date(2026, 10, 13, 12);
let screen: Awaited<ReturnType<typeof testRender>> | null = null;
afterEach(() => {
  act(() => screen?.renderer.destroy());
  screen = null;
});

const session: SessionListEntry = {
  id: "s1",
  title: "Fix the login flow",
  cwd: "/work",
  createdAt: new Date(2026, 10, 2),
  updatedAt: new Date(2026, 10, 2),
  engine: "pi",
  model: "anthropic/claude-opus-5-5",
  messageCount: 12,
};

const firstLine = async (width: number) => {
  screen = await testRender(
    <box flexDirection="row" width={width}>
      <SessionRow session={session} isSelected={false} highlighted={{ current: null }} width={width} now={now} />
    </box>,
    { width: width + 19, height: 3 },
  );
  await act(async () => screen!.renderOnce());
  return screen.captureCharFrame().split("\n")[0]!.trimEnd();
};

// From the tier 4 verification: a narrow row once lost the title and the end of the time to a long pi model ref.
test("a pi session on the default pi model keeps its title start and its time inside a 51-cell row", async () => {
  const line = await firstLine(51);
  expect(Bun.stringWidth(line)).toBeLessThanOrEqual(51);
  expect(line.startsWith("Fix the")).toBe(true);
  expect(line.endsWith("12 messages · 2026-11-02")).toBe(true);
  expect(line).toContain("…");
});

test("a row wide enough for everything cuts nothing", async () => {
  const line = await firstLine(90);
  expect(line).toContain("Fix the login flow");
  expect(line).toContain("pi · anthropic/claude-opus-5-5 · 12 messages · 2026-11-02");
  expect(line).not.toContain("…");
});
