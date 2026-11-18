import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { SessionListEntry } from "../../lib/storage";
import { SessionRow, sessionMeta } from "./sessions-dialog";

const now = new Date(2026, 10, 13, 12);
const entry = (overrides: Partial<SessionListEntry> = {}): SessionListEntry => ({
  id: "s1",
  title: "Fix the login flow",
  cwd: "/work",
  createdAt: new Date(2026, 10, 13, 8),
  updatedAt: new Date(2026, 10, 13, 9),
  engine: "claude",
  model: "sonnet",
  messageCount: 4,
  ...overrides,
});

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
afterEach(() => {
  act(() => screen?.renderer.destroy());
  screen = null;
});

describe("sessionMeta (S18)", () => {
  test("engine, model, message count and the same relative time as `marcsh session list`", () => {
    expect(sessionMeta(entry(), now)).toBe("claude · sonnet · 4 messages · 3h ago");
  });

  test("one message is singular, and no recorded model is a dash", () => {
    expect(sessionMeta(entry({ engine: "pi", model: null, messageCount: 1 }), now)).toBe("pi · — · 1 message · 3h ago");
  });

  test("a model name cannot send terminal escapes", () => {
    expect(sessionMeta(entry({ model: "evil\x1b]0;x\x07" }), now)).not.toMatch(/[\x1b\x07]/);
  });
});

describe("SessionRow (S18)", () => {
  test("a long title is cut with an ellipsis so the details stay whole", async () => {
    const title = "A very long session title that goes on and on well past the width of the row";
    screen = await testRender(
      <box flexDirection="row" width={60}>
        <SessionRow session={entry({ title })} isSelected={false} highlighted={{ current: null }} width={60} now={now} />
      </box>,
      { width: 60, height: 3 },
    );
    await act(async () => screen!.renderOnce());
    const line = screen.captureCharFrame().split("\n")[0]!;
    expect(line).toContain("…");
    expect(line).toContain("claude · sonnet · 4 messages · 3h ago");
  });
});
