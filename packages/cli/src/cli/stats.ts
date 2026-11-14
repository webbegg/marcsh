import type { StatsArgs } from "../cli-args";
import type { ChatMessage } from "../lib/chat-types";
import { printable } from "../lib/safe-text";
import { getStorage, type Storage } from "../lib/storage";
import { reported, sessionUsage } from "../lib/usage";
import { EXIT, processIo, type Io } from "./io";

export type StatsDeps = { storage?: Pick<Storage, "listSessions" | "getSession">; io?: Io; now?: () => number };

const DAY_MS = 86_400_000;
const UNKNOWN_MODEL = "unknown";

/** What one row adds up. `costUsd` is null when no reply reported a cost (unknown is not 0). */
export type StatsRow = {
  sessions: number;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
};

export type Stats = { days: number | null; models: Array<StatsRow & { model: string }>; totals: StatsRow };

const emptyRow = (): StatsRow => ({ sessions: 0, messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null });

const addCost = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));

/**
 * Sessions updated in the last `days` days (all of them without `days`), added up per model. A message belongs to the model it
 * names (user messages name the model they were sent to); a session that used two models is in both rows and once in the totals.
 * Tokens are the sums of what the engines reported; cost is `sessionUsage`'s sum of the replies that reported one.
 */
export function collectStats(storage: Pick<Storage, "listSessions" | "getSession">, days: number | undefined, now: number): Stats {
  const since = days === undefined ? undefined : now - days * DAY_MS;
  const rows = new Map<string, StatsRow>();
  const totals = emptyRow();

  for (const { id, updatedAt } of storage.listSessions()) {
    if (since !== undefined && updatedAt.getTime() < since) continue;
    const session = storage.getSession(id);
    if (!session) continue;
    totals.sessions += 1;

    const byModel = new Map<string, ChatMessage[]>();
    for (const message of session.messages) {
      const model = message.metadata?.model || UNKNOWN_MODEL;
      byModel.set(model, [...(byModel.get(model) ?? []), message]);
    }

    for (const [model, messages] of byModel) {
      const row = rows.get(model) ?? emptyRow();
      rows.set(model, row);
      row.sessions += 1;
      row.messages += messages.length;
      totals.messages += messages.length;
      for (const { metadata } of messages) {
        const usage = metadata?.usage;
        row.inputTokens += reported(usage?.inputTokens) ?? 0;
        row.outputTokens += reported(usage?.outputTokens) ?? 0;
        row.cacheReadTokens += reported(usage?.cacheReadTokens) ?? 0;
        row.cacheWriteTokens += reported(usage?.cacheWriteTokens) ?? 0;
      }
      row.costUsd = addCost(row.costUsd, sessionUsage(messages).costUsd ?? null);
    }
  }

  for (const row of rows.values()) {
    totals.inputTokens += row.inputTokens;
    totals.outputTokens += row.outputTokens;
    totals.cacheReadTokens += row.cacheReadTokens;
    totals.cacheWriteTokens += row.cacheWriteTokens;
    totals.costUsd = addCost(totals.costUsd, row.costUsd);
  }

  return {
    days: days ?? null,
    models: [...rows].map(([model, row]) => ({ model, ...row })).sort((a, b) => a.model.localeCompare(b.model)),
    totals,
  };
}

const count = (value: number) => value.toLocaleString("en-US");
const money = (usd: number | null) => (usd === null ? "-" : usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`);

/** The rows as columns: the first column to the left, numbers to the right. */
function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) => row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!))).join("  ").trimEnd()).join("\n");
}

function render(stats: Stats): string {
  const cells = (label: string, row: StatsRow) => [
    label,
    count(row.sessions),
    count(row.messages),
    count(row.inputTokens),
    count(row.outputTokens),
    count(row.cacheReadTokens + row.cacheWriteTokens),
    money(row.costUsd),
  ];
  // Model names come from stored messages: nothing in them may reach the terminal as a control sequence.
  const rows = [
    ["Model", "Sessions", "Messages", "Input", "Output", "Cache", "Cost"],
    ...stats.models.map((row) => cells(printable(row.model), row)),
    cells("Total", stats.totals),
  ];
  return `${stats.days === null ? "All sessions" : `Sessions updated in the last ${stats.days === 1 ? "day" : `${stats.days} days`}`}\n\n${table(rows)}\n`;
}

/** `marcsh stats`: resolves with the exit code. */
export async function statsCommand(args: StatsArgs, deps: StatsDeps = {}): Promise<number> {
  const { io = processIo, now = Date.now } = deps;
  let stats: Stats;
  try {
    stats = collectStats(deps.storage ?? getStorage(), args.days, now());
  } catch (err) {
    io.stderr(`marcsh: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.failed;
  }

  if (args.json) io.stdout(`${JSON.stringify(stats, null, 2)}\n`);
  else if (stats.totals.sessions === 0) io.stdout(stats.days === null ? "No sessions.\n" : `No sessions updated in the last ${stats.days === 1 ? "day" : `${stats.days} days`}.\n`);
  else io.stdout(render(stats));
  return EXIT.ok;
}
