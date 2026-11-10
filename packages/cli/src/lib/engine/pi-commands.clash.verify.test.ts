import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, InMemoryCredentialStore, type Message } from "@earendil-works/pi-ai";
import { Mode } from "../modes";
import { openStorage } from "../storage";
import { createPiEngine } from "./pi";

// S11: the marcsh plugin's feature command and workflow skill stay reachable as /marcsh:feature and /marcsh:workflow
// on pi even when the user (agent dir) or the project (.pi) has a template or skill with the same pi name.

let dir: string;
let agentDir: string;
let cwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-clash-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const userTexts = (messages: Message[]) =>
  messages.flatMap((m) =>
    m.role === "user" ? [typeof m.content === "string" ? m.content : m.content.map((b) => ("text" in b ? b.text : "")).join("")] : [],
  );

async function sentFor(prompt: string) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  let sent: string[] = [];
  faux.setResponses([(context) => ((sent = userTexts(context.messages)), fauxAssistantMessage([fauxText("ok")]))]);
  const engine = createPiEngine({ agentDir, modelRuntime, permissionRules: openStorage(":memory:") });
  const turn = engine.startTurn(
    { prompt, cwd, mode: Mode.BUILD, model: "faux/faux-1", signal: new AbortController().signal },
    { emit() {}, askPermission: async () => "deny", askQuestions: async () => null },
  );
  await turn.done;
  return sent[0] ?? "";
}

const roots = () => ({ "the agent dir": agentDir, "the project's .pi": join(cwd, ".pi") });

describe("plugin commands on pi with a same-named user resource (S11)", () => {
  for (const where of ["the agent dir", "the project's .pi"] as const) {
    test(`/marcsh:workflow expands the plugin's skill when ${where} has a skill named workflow`, async () => {
      const skills = join(roots()[where], "skills", "workflow");
      mkdirSync(skills, { recursive: true });
      writeFileSync(join(skills, "SKILL.md"), "---\nname: workflow\ndescription: my own workflow\n---\nUSER WORKFLOW BODY\n");

      const sent = await sentFor("/marcsh:workflow fix the login bug");

      expect(sent).toContain("# marcsh workflow");
      expect(sent).not.toContain("USER WORKFLOW BODY");
      expect(sent.startsWith("/marcsh:workflow")).toBe(false);
    }, 20000);

    test(`/marcsh:feature expands the plugin's template when ${where} has a template named feature`, async () => {
      const prompts = join(roots()[where], "prompts");
      mkdirSync(prompts, { recursive: true });
      writeFileSync(join(prompts, "feature.md"), "---\ndescription: mine\n---\nUSER TEMPLATE $1");

      const sent = await sentFor("/marcsh:feature my-feature");

      expect(sent).toContain("Create or resume the feature doc named `my-feature`.");
      expect(sent).not.toContain("USER TEMPLATE");
    }, 20000);
  }
});
