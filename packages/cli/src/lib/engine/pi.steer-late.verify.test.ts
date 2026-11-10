import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, InMemoryCredentialStore, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { ChatMessage } from "../chat-types";
import { Mode } from "../modes";
import { openStorage } from "../storage";
import { createPiEngine } from "./pi";
import { trustEveryProject } from "./test-trust";
import type { EngineEvent, TurnHost } from "./types";

// S4: Enter during a pi turn sends a steer. The turn stays "running" (input on, "enter steers") while pi shuts the session
// down (extension and MCP `session_shutdown`, up to 3 s). A steer typed then must reach the model or be refused, never
// be accepted and then dropped.

let dir: string;
let agentDir: string;
let cwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-steer-late-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
  // A global extension whose shutdown takes a while, like an MCP server that needs time to exit.
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(
    join(agentDir, "extensions", "slow-shutdown.ts"),
    `export default function (pi: any) { pi.on("session_shutdown", async () => { await new Promise((r) => setTimeout(r, 800)); }); }\n`,
  );
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function recording(text: string) {
  const contexts: string[][] = [];
  const step: FauxResponseStep = (context) => {
    contexts.push(
      context.messages
        .filter((m) => m.role === "user")
        .map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "text" ? b.text : "")).join(""))),
    );
    return fauxAssistantMessage([fauxText(text)]);
  };
  return { step, contexts };
}

test("a steer sent after the answer but before the turn is over reaches the model or is refused", async () => {
  const faux = fauxProvider({ models: [{ id: "faux-1" }], tokensPerSecond: 2000, tokenSize: { min: 1, max: 1 } });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const first = recording("first answer");
  const second = recording("answer to the late steer");
  faux.setResponses([first.step, second.step]);
  const engine = createPiEngine({ agentDir, modelRuntime, permissionRules: openStorage(":memory:"), projectTrust: trustEveryProject });

  // The reply gets its duration once pi has nothing left to do: that is when the user sees the answer finished.
  const answered = Promise.withResolvers<void>();
  const events: EngineEvent[] = [];
  const host: TurnHost = {
    emit: (event) => {
      events.push(event);
      if (event.type === "reply" && event.update({ id: "x", role: "assistant", parts: [] } as ChatMessage).metadata?.durationMs !== undefined) answered.resolve();
    },
    askPermission: async () => "allow",
    askQuestions: async () => null,
  };
  const turn = engine.startTurn({ prompt: "hello", cwd, mode: Mode.BUILD, model: "faux/faux-1", signal: new AbortController().signal }, host);
  await answered.promise;

  let refused = false;
  await turn.steer!("one more thing").catch(() => (refused = true));
  await turn.done;
  await new Promise((r) => setTimeout(r, 200));

  if (!refused) {
    expect(second.contexts.flat()).toContain("one more thing");
    expect(events.some((e) => e.type === "delivered" && e.text === "one more thing")).toBe(true);
  }
}, 30000);
