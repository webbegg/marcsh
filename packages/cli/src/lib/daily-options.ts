/**
 * The daily options: the home screen's menu lists them, and each is a marcsh command too (the palette and the `/` menu list those).
 * An option runs its `command` when one by that name is loaded (the brigadev pack's names); otherwise the prompt gets its `starter`.
 */
export type DailyOption = {
  label: string;
  /** The user's or a pack's command the option runs when it is loaded. */
  command: string;
  /** What the prompt holds when no such command is loaded. */
  starter: string;
  /**
   * The marcsh command for the option. Not the pack's name: marcsh's own commands win, and would hide the pack's. Nor one starting
   * like a common engine command (`pr-review`, not `review-pr`, which would make `/rev` stop completing Claude's `/review`).
   */
  name: string;
  description: string;
};

export const DAILY_OPTIONS: readonly DailyOption[] = [
  { label: "New feature", command: "feature", starter: "New feature: ", name: "new-feature", description: "Start a new feature (runs /feature when it is loaded)" },
  { label: "Fix a bug", command: "bug-fix", starter: "Fix a bug: ", name: "fix-bug", description: "Fix a bug (runs /bug-fix when it is loaded)" },
  { label: "Work on a ticket", command: "ticket", starter: "Work on ticket: ", name: "work-ticket", description: "Work on a ticket (runs /ticket when it is loaded)" },
  { label: "Review a PR", command: "review-branch", starter: "Review PR: ", name: "pr-review", description: "Review a PR (runs /review-branch when it is loaded)" },
];

const listeners = new Set<() => void>();

/** Asks the home screen on display to open its menu again (`/dashboard`). */
export function requestDashboard() {
  for (const listener of [...listeners]) listener();
}

/** Calls `listener` on each `requestDashboard`; returns the function that stops it. */
export function onDashboardRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
