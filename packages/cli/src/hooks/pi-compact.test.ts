import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Mode } from "../lib/modes";
import { openStorage } from "../lib/storage";
import { createPiEngine } from "../lib/engine/pi";
import { trustEveryProject } from "../lib/engine/test-trust";
import type { EngineEvent, TurnHost } from "../lib/engine/types";

// The pi engine's `compact` (S5), against pi's faux provider. It lives here because the engine's own test folder is outside this unit's surfaces.

let dir: string;
let cwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-compact-"));
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
  // pi keeps the last 20k tokens as they are, so a small test conversation would have nothing to summarize.
  mkdirSync(join(dir, "agent"), { recursive: true });
  writeFileSync(join(dir, "agent", "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 200 } }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function setup() {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const engine = createPiEngine({
    agentDir: join(dir, "agent"),
    sessionDir: join(dir, "sessions"),
    modelRuntime,
    permissionRules: openStorage(":memory:"),
    projectTrust: trustEveryProject,
  });
  return { engine, faux, model: "faux/faux-1" };
}

/** Runs one turn and returns the conversation's reference. */
async function converse(engine: Awaited<ReturnType<typeof setup>>["engine"], model: string, prompt: string, resumeRef?: string): Promise<string> {
  const events: EngineEvent[] = [];
  const host: TurnHost = { emit: (event) => events.push(event), askPermission: async () => "deny", askQuestions: async () => null };
  const turn = engine.startTurn({ prompt, cwd, mode: Mode.BUILD, model, resumeRef, signal: new AbortController().signal }, host);
  await turn.done;
  const ref = events.flatMap((event) => (event.type === "session" ? [event.ref] : [])).at(-1);
  if (!ref) throw new Error("the turn reported no session reference");
  return ref;
}

describe("the pi engine's compact", () => {
  test("summarizes the conversation the reference names and reports the tokens before and after", async () => {
    const { engine, faux, model } = await setup();
    faux.setResponses([fauxAssistantMessage([fauxText("a".repeat(2000))]), fauxAssistantMessage([fauxText("b".repeat(2000))])]);
    let ref = await converse(engine, model, "first question ".repeat(100));
    ref = await converse(engine, model, "second question ".repeat(100), ref);

    // pi may summarize the history and the split turn's prefix in separate requests.
    const summary = () => fauxAssistantMessage([fauxText("## Summary\nthe user asked two questions")]);
    faux.setResponses([summary(), summary(), summary()]);
    const result = await engine.compact!({ cwd, model, resumeRef: ref, signal: new AbortController().signal });
    expect(result.tokensBefore).toBeGreaterThan(0);
    // What pi kept is smaller than what it had.
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore!);
  });

  test("an unknown model is a plain message, not a crash", async () => {
    const { engine } = await setup();
    await expect(engine.compact!({ cwd, model: "nope/missing", resumeRef: join(dir, "sessions", "x.jsonl"), signal: new AbortController().signal })).rejects.toThrow(
      'Unknown pi model "nope/missing"',
    );
  });

  test("an aborted signal stops before anything is read", async () => {
    const { engine, model } = await setup();
    const controller = new AbortController();
    controller.abort();
    await expect(engine.compact!({ cwd, model, resumeRef: join(dir, "sessions", "x.jsonl"), signal: controller.signal })).rejects.toThrow("cancelled");
  });
});
