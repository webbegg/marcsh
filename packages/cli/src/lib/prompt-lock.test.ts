import { describe, expect, test } from "bun:test";
import { clearKeyActivity, COMPOSING_MS, isComposing, noteKeyActivity, setDraft } from "./prompt-lock";

// What "the user is composing" means to a prompt that opens: a draft in the input, or a key typed there in the last 2 s.
describe("isComposing", () => {
  test("nobody typed and there is no draft: not composing", () => {
    expect(isComposing({}, 10_000)).toBe(false);
  });

  test("a key typed within the last 2 s counts, and stops counting after", () => {
    const owner = {};
    noteKeyActivity(owner, 1_000);

    expect(isComposing(owner, 1_000)).toBe(true);
    expect(isComposing(owner, 1_000 + COMPOSING_MS - 1)).toBe(true);
    expect(isComposing(owner, 1_000 + COMPOSING_MS)).toBe(false);
  });

  test("a non-empty draft counts however long ago the last key was", () => {
    const owner = {};
    noteKeyActivity(owner, 1_000);
    setDraft(owner, true);

    expect(isComposing(owner, 600_000)).toBe(true);

    setDraft(owner, false);
    expect(isComposing(owner, 600_000)).toBe(false);
  });

  test("sending the text ends the composing: the key that sent it does not count", () => {
    const owner = {};
    noteKeyActivity(owner, 1_000);
    clearKeyActivity(owner);

    expect(isComposing(owner, 1_001)).toBe(false);
  });

  test("each owner (a screen's renderer) has its own state", () => {
    const typing = {};
    const idle = {};
    noteKeyActivity(typing, 1_000);
    setDraft(typing, true);

    expect(isComposing(typing, 1_001)).toBe(true);
    expect(isComposing(idle, 1_001)).toBe(false);
  });
});
