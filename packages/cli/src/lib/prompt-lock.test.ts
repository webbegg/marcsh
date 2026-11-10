import { describe, expect, test } from "bun:test";
import { attachInput, clearKeyActivity, COMPOSING_MS, isComposing, noteKeyActivity, setDraft } from "./prompt-lock";

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

// The hand-off from the home screen: keys can land in the new input bar before it mounts, and the old bar's unmount can run after.
describe("attachInput", () => {
  test("a bar that mounts holding text composes, whatever keys were seen", () => {
    const owner = {};
    attachInput(owner, true);

    expect(isComposing(owner, 10_000)).toBe(true);
  });

  test("a bar that mounts empty keeps the keys typed just before", () => {
    const owner = {};
    noteKeyActivity(owner, 1_000);
    attachInput(owner, false);

    expect(isComposing(owner, 1_001)).toBe(true);
    expect(isComposing(owner, 1_000 + COMPOSING_MS)).toBe(false);
  });

  test("the old bar unmounting after the new one mounted clears nothing of the new one", () => {
    const owner = {};
    const detachOld = attachInput(owner, false);
    const detachNew = attachInput(owner, true);
    noteKeyActivity(owner, 1_000);
    detachOld();

    expect(isComposing(owner, 1_001)).toBe(true);
    detachNew();
    expect(isComposing(owner, 1_001)).toBe(false);
  });

  test("the bar that is current clears its draft and keys when it unmounts", () => {
    const owner = {};
    const detach = attachInput(owner, true);
    noteKeyActivity(owner, 1_000);
    detach();

    expect(isComposing(owner, 1_001)).toBe(false);
  });
});
