const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * When `date` was, said relative to `now`: `just now`, `5m ago`, `3h ago`, `yesterday`, `4d ago`, then the local date (`2026-11-02`)
 * from a week on. The session list in the TUI and `marcsh session list` both use it, so they say the same thing.
 * A time after `now` (a clock that moved) is `just now`.
 */
export function formatRelativeTime(date: Date, now: Date): string {
  const time = date.getTime();
  if (Number.isNaN(time)) return "unknown";
  const ago = now.getTime() - time;
  if (ago < MINUTE) return "just now";
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)}m ago`;
  if (ago < DAY) return `${Math.floor(ago / HOUR)}h ago`;
  if (ago < 2 * DAY) return "yesterday";
  if (ago < 7 * DAY) return `${Math.floor(ago / DAY)}d ago`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
