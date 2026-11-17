import { describe, expect, test } from "bun:test";
import { formatRelativeTime } from "./relative-time";

const now = new Date(2026, 10, 13, 12, 0, 0);
const before = (ms: number) => new Date(now.getTime() - ms);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatRelativeTime", () => {
  test("under a minute is just now", () => {
    expect(formatRelativeTime(now, now)).toBe("just now");
    expect(formatRelativeTime(before(59 * SECOND), now)).toBe("just now");
  });

  test("minutes, then hours", () => {
    expect(formatRelativeTime(before(MINUTE), now)).toBe("1m ago");
    expect(formatRelativeTime(before(59 * MINUTE), now)).toBe("59m ago");
    expect(formatRelativeTime(before(HOUR), now)).toBe("1h ago");
    expect(formatRelativeTime(before(23 * HOUR + 59 * MINUTE), now)).toBe("23h ago");
  });

  test("a day ago is yesterday, then days up to a week", () => {
    expect(formatRelativeTime(before(DAY), now)).toBe("yesterday");
    expect(formatRelativeTime(before(2 * DAY - MINUTE), now)).toBe("yesterday");
    expect(formatRelativeTime(before(2 * DAY), now)).toBe("2d ago");
    expect(formatRelativeTime(before(7 * DAY - MINUTE), now)).toBe("6d ago");
  });

  test("a week or more is the local date", () => {
    expect(formatRelativeTime(before(7 * DAY), now)).toBe("2026-11-06");
    expect(formatRelativeTime(new Date(2025, 0, 2, 9), now)).toBe("2025-01-02");
  });

  test("a time in the future (a clock that moved) is just now", () => {
    expect(formatRelativeTime(new Date(now.getTime() + HOUR), now)).toBe("just now");
  });

  test("a date that is not valid prints as unknown rather than NaN", () => {
    expect(formatRelativeTime(new Date(Number.NaN), now)).toBe("unknown");
  });
});
