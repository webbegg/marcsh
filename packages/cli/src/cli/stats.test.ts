import { beforeEach, describe, expect, test } from "bun:test";
import type { StatsArgs } from "../cli-args";
import type { ChatMessage, ChatUsage } from "../lib/chat-types";
import { openStorage, type Storage } from "../lib/storage";
import { collectStats, statsCommand } from "./stats";

let storage: Storage;
let out: string;
let err: string;
const io = { stdout: (text: string) => void (out += text), stderr: (text: string) => void (err += text) };
const DAY = 86_400_000;

const user = (model: string): ChatMessage => ({ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: "q" }], metadata: { model } });
const reply = (model: string, usage?: ChatUsage): ChatMessage => ({
  id: crypto.randomUUID(),
  role: "assistant",
  parts: [{ type: "text", text: "a" }],
  metadata: { model, ...(usage ? { usage } : {}) },
});

const seed = (messages: ChatMessage[]) => {
  const session = storage.createSession({ title: "t", cwd: "/w", engine: "claude" });
  storage.saveMessages(session.id, messages);
  return session;
};

const run = (args: Partial<StatsArgs> = {}, now = Date.now()) =>
  statsCommand({ kind: "stats", json: false, ...args }, { storage, io, now: () => now });

beforeEach(() => {
  storage = openStorage(":memory:");
  out = "";
  err = "";
});

describe("collectStats", () => {
  test("groups sessions, messages, tokens and cost by model", () => {
    seed([
      user("opus"),
      reply("opus", { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, costUsd: 0.5 }),
      user("opus"),
      reply("opus", { inputTokens: 200, outputTokens: 70, costUsd: 0.25 }),
    ]);
    seed([user("sonnet"), reply("sonnet", { inputTokens: 40, outputTokens: 4 })]);
    seed([user("opus"), reply("opus", { inputTokens: 1, outputTokens: 2, costUsd: 1 })]);

    const stats = collectStats(storage, undefined, Date.now());

    expect(stats.days).toBeNull();
    expect(stats.models).toEqual([
      { model: "opus", sessions: 2, messages: 6, inputTokens: 301, outputTokens: 122, cacheReadTokens: 10, cacheWriteTokens: 5, costUsd: 1.75 },
      { model: "sonnet", sessions: 1, messages: 2, inputTokens: 40, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null },
    ]);
    expect(stats.totals).toEqual({ sessions: 3, messages: 8, inputTokens: 341, outputTokens: 126, cacheReadTokens: 10, cacheWriteTokens: 5, costUsd: 1.75 });
  });

  test("a session that used two models counts for both, and once in the total", () => {
    seed([user("opus"), reply("opus", { costUsd: 1 }), user("haiku"), reply("haiku", { costUsd: 0.5 })]);
    const stats = collectStats(storage, undefined, Date.now());
    expect(stats.models.map((m) => [m.model, m.sessions, m.costUsd])).toEqual([
      ["haiku", 1, 0.5],
      ["opus", 1, 1],
    ]);
    expect(stats.totals.sessions).toBe(1);
    expect(stats.totals.costUsd).toBe(1.5);
  });

  test("messages without a model are counted as unknown", () => {
    seed([{ id: "a", role: "user", parts: [] }, { id: "b", role: "assistant", parts: [] }]);
    expect(collectStats(storage, undefined, Date.now()).models).toMatchObject([{ model: "unknown", messages: 2 }]);
  });

  test("--days keeps only the sessions updated in the last N days", () => {
    seed([user("opus"), reply("opus", { inputTokens: 1 })]);
    const now = Date.now();

    expect(collectStats(storage, 7, now + 6 * DAY).totals.sessions).toBe(1);
    expect(collectStats(storage, 7, now + 8 * DAY).totals.sessions).toBe(0);
    expect(collectStats(storage, 7, now + 8 * DAY).days).toBe(7);
  });

  test("a session without messages counts as a session only", () => {
    seed([]);
    expect(collectStats(storage, undefined, Date.now())).toMatchObject({ models: [], totals: { sessions: 1, messages: 0 } });
  });
});

describe("stats", () => {
  test("prints a table per model and the totals", async () => {
    seed([user("opus"), reply("opus", { inputTokens: 1500, outputTokens: 20, cacheReadTokens: 1000, costUsd: 0.125 })]);

    expect(await run()).toBe(0);

    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toBe("All sessions");
    const header = lines.find((line) => line.startsWith("Model"))!;
    for (const column of ["Sessions", "Messages", "Input", "Output", "Cache", "Cost"]) expect(header).toContain(column);
    const opus = lines.find((line) => line.startsWith("opus"))!;
    expect(opus.split(/\s+/)).toEqual(["opus", "1", "2", "1,500", "20", "1,000", "$0.13"]);
    expect(lines.find((line) => line.startsWith("Total"))!.split(/\s+/)).toEqual(["Total", "1", "2", "1,500", "20", "1,000", "$0.13"]);
    expect(err).toBe("");
  });

  test("an unknown cost shows a dash", async () => {
    seed([user("opus"), reply("opus", { inputTokens: 1 })]);
    await run();
    expect(out.split("\n").find((line) => line.startsWith("opus"))!.trim().endsWith("-")).toBe(true);
  });

  test("--days says which period and says so when nothing matches", async () => {
    seed([user("opus")]);
    await run({ days: 7 }, Date.now() + 30 * DAY);
    expect(out).toBe("No sessions updated in the last 7 days.\n");
  });

  test("--days 1 reads 'day'", async () => {
    await run({ days: 1 });
    expect(out).toBe("No sessions updated in the last day.\n");
  });

  test("no session at all", async () => {
    await run();
    expect(out).toBe("No sessions.\n");
  });

  test("--json prints the whole result", async () => {
    seed([user("opus"), reply("opus", { inputTokens: 3, costUsd: 0.5 })]);
    expect(await run({ json: true, days: 30 })).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.days).toBe(30);
    expect(parsed.totals).toMatchObject({ sessions: 1, messages: 2, inputTokens: 3, costUsd: 0.5 });
    expect(parsed.models).toHaveLength(1);
  });

  test("--json with no session is still the whole shape", async () => {
    await run({ json: true });
    expect(JSON.parse(out)).toEqual({
      days: null,
      models: [],
      totals: { sessions: 0, messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null },
    });
  });

  test("model names cannot send terminal escapes", async () => {
    seed([user("evil\x1b[2Jmodel")]);
    await run();
    expect(out).not.toContain("\x1b");
  });
});
