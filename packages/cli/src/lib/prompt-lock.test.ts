import { describe, expect, test } from "bun:test";
import {
  attachInput,
  clearKeyActivity,
  COMPOSING_MS,
  giveBackText,
  handOffDraft,
  HAND_OFF_MS,
  isComposing,
  mergeGivenBack,
  noteKeyActivity,
  onGivenBack,
  setDraft,
  setInputTakesKeys,
  takeHandOffDraft,
} from "./prompt-lock";

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

  // R3-003: a Claude session's input is off for the whole turn, so a draft carried into it is not the user composing.
  test("a draft in an input that takes no keys does not count, recent keys still do", () => {
    const owner = {};
    setDraft(owner, true);
    setInputTakesKeys(owner, false);
    expect(isComposing(owner, 600_000)).toBe(false);

    noteKeyActivity(owner, 1_000);
    expect(isComposing(owner, 1_001)).toBe(true);
    expect(isComposing(owner, 1_000 + COMPOSING_MS)).toBe(false);

    setInputTakesKeys(owner, true);
    expect(isComposing(owner, 600_000)).toBe(true);
  });

  test("the input takes keys until it says otherwise, and a bar that goes away restores that", () => {
    const owner = {};
    const detach = attachInput(owner, true);
    expect(isComposing(owner, 10_000)).toBe(true);

    setInputTakesKeys(owner, false);
    expect(isComposing(owner, 10_000)).toBe(false);
    detach();
    attachInput(owner, true);
    expect(isComposing(owner, 10_000)).toBe(true);
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
    // The draft is gone with the bar; the recent keys still count until they are 2 s old.
    expect(isComposing(owner, 1_001)).toBe(true);
    expect(isComposing(owner, 1_000 + COMPOSING_MS)).toBe(false);
  });

  test("the bar that is current clears its draft when it unmounts, but recent keys still count (the home screen hand-off)", () => {
    const owner = {};
    const detach = attachInput(owner, true);
    detach();
    expect(isComposing(owner, 1_001)).toBe(false);

    const detachAgain = attachInput(owner, false);
    noteKeyActivity(owner, 1_000);
    detachAgain();
    expect(isComposing(owner, 1_500)).toBe(true);
    expect(isComposing(owner, 1_000 + COMPOSING_MS)).toBe(false);
  });
});

// The new-session screen hands what was typed in its bar to the next bar when it unmounts, not when it navigates.
describe("handOffDraft", () => {
  test("the next bar takes the text once", () => {
    const owner = {};
    handOffDraft(owner, "please check the ");

    expect(takeHandOffDraft(owner)).toBe("please check the ");
    expect(takeHandOffDraft(owner)).toBe("");
  });

  test("nothing handed off: nothing taken", () => {
    expect(takeHandOffDraft({})).toBe("");
  });

  test("a later hand-off replaces an earlier one, and an empty one clears it", () => {
    const owner = {};
    handOffDraft(owner, "first");
    handOffDraft(owner, "second");
    expect(takeHandOffDraft(owner)).toBe("second");

    handOffDraft(owner, "stale");
    handOffDraft(owner, "");
    expect(takeHandOffDraft(owner)).toBe("");
  });

  test("each owner (a screen's renderer) has its own hand-off", () => {
    const a = {};
    handOffDraft(a, "for a");

    expect(takeHandOffDraft({})).toBe("");
    expect(takeHandOffDraft(a)).toBe("for a");
  });

  // R4-004: a hand-off nobody takes soon is stale; it must not show up in an unrelated session later.
  test("a hand-off not taken within the window is dropped, one taken in time is kept", () => {
    const stale = {};
    handOffDraft(stale, "old words", 1_000);
    expect(takeHandOffDraft(stale, 1_000 + HAND_OFF_MS + 1)).toBe("");
    // Dropped for good, not kept for a later bar.
    expect(takeHandOffDraft(stale, 1_000 + HAND_OFF_MS + 2)).toBe("");

    const fresh = {};
    handOffDraft(fresh, "new words", 1_000);
    expect(takeHandOffDraft(fresh, 1_000 + HAND_OFF_MS)).toBe("new words");
  });

  test("a later hand-off restarts the window", () => {
    const owner = {};
    handOffDraft(owner, "first", 1_000);
    handOffDraft(owner, "second", 1_000 + HAND_OFF_MS);
    expect(takeHandOffDraft(owner, 1_000 + 2 * HAND_OFF_MS - 1)).toBe("second");
  });
});

// Text the engine could not take (a rejected steer, an interrupted turn) goes back to the input that is on screen now.
describe("giveBackText", () => {
  test("the live input takes it, and the caller hears that it was taken", () => {
    const owner = {};
    const taken: string[] = [];
    onGivenBack(owner, (text) => (taken.push(text), true));

    expect(giveBackText(owner, "my steer")).toBe(true);
    expect(taken).toEqual(["my steer"]);
  });

  test("with no live input nothing is taken and nothing is kept for a later one", () => {
    const owner = {};
    expect(giveBackText(owner, "my steer")).toBe(false);
    expect(takeHandOffDraft(owner)).toBe("");
  });

  test("an input that cannot take it (no textarea) is reported as not taken", () => {
    const owner = {};
    onGivenBack(owner, () => false);
    expect(giveBackText(owner, "my steer")).toBe(false);
  });

  test("a bar that goes away stops listening, but only if it is still the current one", () => {
    const owner = {};
    const old: string[] = [];
    const current: string[] = [];
    const stopOld = onGivenBack(owner, (text) => (old.push(text), true));
    onGivenBack(owner, (text) => (current.push(text), true));
    stopOld();

    giveBackText(owner, "x");
    expect(old).toEqual([]);
    expect(current).toEqual(["x"]);
  });
});

describe("mergeGivenBack", () => {
  test("an empty input just gets the text", () => {
    expect(mergeGivenBack("my steer", "")).toEqual({ text: "my steer", block: "my steer" });
  });

  test("what is in the input stays, after the returned text, on its own line", () => {
    expect(mergeGivenBack("my steer", "half a sentence")).toEqual({ text: "my steer\nhalf a sentence", block: "my steer" });
  });

  test("several returned texts keep the order they were typed in, ahead of what was typed since", () => {
    const first = mergeGivenBack("one", "typing");
    const second = mergeGivenBack("two", first.text, first.block);
    const third = mergeGivenBack("three", second.text, second.block);

    expect(third.text).toBe("one\ntwo\nthree\ntyping");
  });

  test("when the user changed the returned block, everything held stays and nothing is replaced", () => {
    const first = mergeGivenBack("one", "typing");
    const second = mergeGivenBack("two", first.text.replace("one", "1"), first.block);

    expect(second.text).toBe("two\n1\ntyping");
  });
});
