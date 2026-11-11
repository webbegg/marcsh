import { describe, expect, test } from "bun:test";
import { attachInput, HAND_OFF_MS, handOffDraft, isComposing, mergeGivenBack, noteKeyActivity, setDraft, setInputTakesKeys, takeHandOffDraft } from "./prompt-lock";

// Verifier probes for the pre-PR hardening (R4-004 hand-off expiry, R3-003 Claude carried draft, give-back merge).

describe("a hand-off expires after HAND_OFF_MS (R4-004)", () => {
  test("taken exactly at the window's end it is kept; one ms later it is dropped for good", () => {
    const a = {};
    handOffDraft(a, "kept", 1_000);
    expect(takeHandOffDraft(a, 1_000 + HAND_OFF_MS)).toBe("kept");
    const b = {};
    handOffDraft(b, "stale", 1_000);
    expect(takeHandOffDraft(b, 1_000 + HAND_OFF_MS + 1)).toBe("");
    // Dropped, not kept for a later bar either.
    expect(takeHandOffDraft(b, 1_001)).toBe("");
  });

  test("the window is 5 s", () => {
    expect(HAND_OFF_MS).toBe(5000);
  });

  test("taken once: a second bar mounting gets nothing", () => {
    const owner = {};
    handOffDraft(owner, "once", 0);
    expect(takeHandOffDraft(owner, 10)).toBe("once");
    expect(takeHandOffDraft(owner, 20)).toBe("");
  });
});

describe("a carried draft in an input that takes no keys (R3-003)", () => {
  test("does not count as composing; a key in the last 2 s still does", () => {
    const owner = {};
    const detach = attachInput(owner, true);
    setInputTakesKeys(owner, false);
    expect(isComposing(owner, Date.now() + 10_000)).toBe(false);
    noteKeyActivity(owner, 50_000);
    expect(isComposing(owner, 51_999)).toBe(true);
    expect(isComposing(owner, 52_000)).toBe(false);
    detach();
  });

  test("an input that takes keys again (the turn ended) makes its draft count again", () => {
    const owner = {};
    attachInput(owner, false);
    setDraft(owner, true);
    setInputTakesKeys(owner, false);
    expect(isComposing(owner, Date.now() + 10_000)).toBe(false);
    setInputTakesKeys(owner, true);
    expect(isComposing(owner, Date.now() + 10_000)).toBe(true);
  });
});

describe("text given back is merged, never truncated or replacing (R1-002, R3-001)", () => {
  const long = `LONG ${"w".repeat(500)} END`;

  test("a long text comes back whole, ahead of what was typed since", () => {
    expect(mergeGivenBack(long, "typed since").text).toBe(`${long}\ntyped since`);
  });

  test("two give-backs keep the typed order, both ahead of the newer typing", () => {
    const first = mergeGivenBack("steer one", "since");
    const second = mergeGivenBack("follow two", first.text, first.block);
    expect(second.text).toBe("steer one\nfollow two\nsince");
  });

  test("a multi-line text given back keeps its lines", () => {
    expect(mergeGivenBack("a\nb", "").text).toBe("a\nb");
  });
});
