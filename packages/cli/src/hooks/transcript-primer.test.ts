import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../lib/chat-types";
import { MAX_PRIMER_CHARS, primeWithTranscript } from "./transcript-primer";

const session = { id: "abcdef12-0000", title: "Fix the build", cwd: "/tmp/p", engine: "claude", createdAt: new Date("2026-01-02T00:00:00Z"), updatedAt: new Date("2026-01-02T00:00:00Z") };
const user = (id: string, text: string): ChatMessage => ({ id, role: "user", parts: [{ type: "text", text }] });
const bot = (id: string, text: string): ChatMessage => ({ id, role: "assistant", parts: [{ type: "text", text }], metadata: { model: "sonnet" } });

describe("primeWithTranscript", () => {
  test("puts the earlier messages in front of the prompt, with the prompt last and as typed", () => {
    const primed = primeWithTranscript("and now the tests?", session, [user("1", "why does the build fail?"), bot("2", "a missing import")]);
    expect(primed).toContain("why does the build fail?");
    expect(primed).toContain("a missing import");
    expect(primed.endsWith("and now the tests?")).toBe(true);
    expect(primed.indexOf("a missing import")).toBeLessThan(primed.indexOf("and now the tests?"));
  });

  test("a conversation with nothing said yet leaves the prompt alone", () => {
    expect(primeWithTranscript("hello", session, [])).toBe("hello");
    expect(primeWithTranscript("hello", session, [{ id: "x", role: "assistant", parts: [] }])).toBe("hello");
  });

  test("a /command is never primed: the engine must see it first on the line", () => {
    expect(primeWithTranscript("/compact", session, [user("1", "hi"), bot("2", "yo")])).toBe("/compact");
  });

  test("a long transcript keeps its newest part and says earlier messages were left out", () => {
    const messages = Array.from({ length: 200 }, (_, i) => [user(`u${i}`, `question ${i} ${"x".repeat(600)}`), bot(`a${i}`, `answer ${i}`)]).flat();
    const primed = primeWithTranscript("next", session, messages);
    expect(primed).toContain("answer 199");
    expect(primed).not.toContain("question 0 ");
    expect(primed).toContain("earlier messages are left out");
    expect(primed.length).toBeLessThan(MAX_PRIMER_CHARS + 2000);
  });
});
