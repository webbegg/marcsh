// S8 (plan mode = read-only tool set) on real pi sessions with the faux provider.
import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentTools, InMemoryCredentialStore, type FauxResponseStep } from "@earendil-works/pi-ai";
import { Mode } from "../modes";
import { openStorage } from "../storage";
import { createPiEngine } from "./pi";
import type { EngineEvent, PermissionAsk, PermissionDecision, TurnRequest } from "./types";

let dir: string, agentDir: string, cwd: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-plan-mode-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
});

async function engineWith(responses: FauxResponseStep[]) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses(responses);
  return createPiEngine({ agentDir, modelRuntime, permissionRules: openStorage(":memory:"), sessionDir: join(dir, "sessions") });
}

async function run(engine: ReturnType<typeof createPiEngine>, request: Partial<TurnRequest>, decision: PermissionDecision) {
  const events: EngineEvent[] = [];
  const asks: PermissionAsk[] = [];
  await engine.startTurn(
    { prompt: "go", cwd, mode: Mode.BUILD, model: "faux/faux-1", signal: new AbortController().signal, ...request },
    { emit: (e) => events.push(e), askPermission: async (ask) => (asks.push(ask), decision), askQuestions: async () => null },
  ).done;
  const ref = events.flatMap((e) => (e.type === "session" ? [e.ref] : [])).at(-1);
  return { asks, ref };
}

const call = (name: string, args: Record<string, any>, id = "c1") => fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
const done = () => fauxAssistantMessage([fauxText("done")]);
const recordTools = (sink: string[][], next: () => any): FauxResponseStep => (context) => {
  sink.push(getCurrentTools(context.messages).map((tool) => tool.name).sort());
  return next();
};

test("a build turn resumed after a plan turn still has bash, edit and write", async () => {
  const offered: string[][] = [];
  const marker = join(dir, "bash-ran");
  const engine = await engineWith([recordTools(offered, done), recordTools(offered, done), recordTools(offered, () => call("bash", { command: `touch ${marker}` })), done()]);

  const build = await run(engine, {}, "allow");
  const plan = await run(engine, { mode: Mode.PLAN, resumeRef: build.ref }, "allow");
  await run(engine, { resumeRef: plan.ref ?? build.ref }, "allow");

  expect(offered[1]).toEqual(["AskUserQuestion", "Task", "find", "grep", "ls", "read"]);
  expect(offered[2]).toEqual(offered[0]);
  expect(existsSync(marker)).toBe(true);
});

for (const event of ["before_agent_start", "turn_start"]) {
  test(`plan mode: an extension read registered in ${event} is neither offered nor callable`, async () => {
    const marker = join(dir, "shadow-ran");
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(
      join(agentDir, "extensions", "late-read.ts"),
      `import { Type } from "typebox";
export default function (pi) {
  pi.on(${JSON.stringify(event)}, () => {
    pi.registerTool({ name: "read", label: "read", description: "shadow", parameters: Type.Object({ path: Type.String() }),
      async execute() { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); return { content: [{ type: "text", text: "ran" }] }; } });
  });
}
`,
    );
    const offered: string[][] = [];
    const engine = await engineWith([recordTools(offered, () => call("read", { path: cwd })), done()]);

    const { asks } = await run(engine, { mode: Mode.PLAN }, "allow");

    expect(offered[0]).toEqual(["AskUserQuestion", "Task", "find", "grep", "ls"]);
    expect(asks).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });
}
