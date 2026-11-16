import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, InMemoryCredentialStore, type FauxResponseStep, type Message } from "@earendil-works/pi-ai";
import { parseSubagentFile } from "../agent-file";
import { turnSubagents } from "../agents";
import { activeProfiles, parseProfiles } from "../profiles";
import { Mode } from "../modes";
import { openStorage } from "../storage";
import { createPiEngine } from "./pi";
import { trustEveryProject } from "./test-trust";
import type { EngineEvent, PermissionAsk, TurnHost, TurnRequest, TurnSubagent } from "./types";

// Model profiles on real pi sessions with the faux provider: the model a Task child runs on is the one the active profile routes it to
// (precedence: session profile, default profile, the agent file's model, the turn's), and its thinking level comes with it.

let dir: string;
let agentDir: string;
let cwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-profiles-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CHILD_PROMPT = "child: do the task";
const firstUserText = (messages: Message[]) => {
  const user = messages.find((m) => m.role === "user");
  if (!user) return "";
  return typeof user.content === "string" ? user.content : user.content.map((block) => ("text" in block ? block.text : "")).join("");
};
const toolResults = (messages: Message[]) => messages.flatMap((m) => (m.role === "toolResult" ? [m.content.map((block) => ("text" in block ? block.text : "")).join("")] : []));

type Seen = { model: string; reasoning?: string };

/** The parent calls `Task` for `agent` once and then answers "ok"; every child request records its model and thinking level. */
async function setup(agent = "refuter") {
  const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }, { id: "faux-2", reasoning: true }, { id: "faux-3", reasoning: true }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const children: Seen[] = [];
  const parents: Seen[] = [];
  const router: FauxResponseStep = (context, options, _state, model) => {
    const messages = context.messages as Message[];
    const seen: Seen = { model: model.id, ...(options?.reasoning ? { reasoning: String(options.reasoning) } : {}) };
    if (firstUserText(messages) === CHILD_PROMPT) {
      children.push(seen);
      return fauxAssistantMessage([fauxText("child answer")]);
    }
    parents.push(seen);
    return toolResults(messages).length === 0
      ? fauxAssistantMessage([fauxToolCall("Task", { description: "Do the task", prompt: CHILD_PROMPT, agent } as never, { id: "task-1" })], { stopReason: "toolUse" })
      : fauxAssistantMessage([fauxText("ok")]);
  };
  faux.setResponses(Array.from({ length: 12 }, () => router));
  const engine = createPiEngine({ agentDir, modelRuntime, permissionRules: openStorage(":memory:"), projectTrust: trustEveryProject });

  async function turn(overrides: Partial<TurnRequest> = {}) {
    const events: EngineEvent[] = [];
    const host: TurnHost = { emit: (event) => events.push(event), askPermission: async (_ask: PermissionAsk) => "allow", askQuestions: async () => null };
    await engine.startTurn({ prompt: "hello", cwd, mode: Mode.BUILD, model: "faux/faux-1", signal: new AbortController().signal, ...overrides }, host).done;
    return { errors: events.flatMap((e) => (e.type === "error" ? [e.message] : [])) };
  }
  return { turn, children, parents };
}

const agentFile = (frontmatter: string) => parseSubagentFile(`---\nmode: subagent\n${frontmatter}\n---\nYou are the refuter.`, { pack: "user", file: "refuter.md" })!;
const file = (profiles: Record<string, unknown>, defaultName?: string) => parseProfiles({ version: 1, ...(defaultName ? { default: defaultName } : {}), profiles }).file;

describe("the main turn's primary route (pi)", () => {
  test("its thinking level applies while the turn runs on the route's own model, not on another the user picked since", async () => {
    const onRoute = await setup();
    await onRoute.turn({ model: "faux/faux-1", routing: { model: "faux/faux-1", thinking: "high" } });
    expect(onRoute.parents[0]!.reasoning).toBe("high");

    const elsewhere = await setup();
    await elsewhere.turn({ model: "faux/faux-2", routing: { model: "faux/faux-1", thinking: "high" } });
    expect(elsewhere.parents[0]!.model).toBe("faux-2");
    expect(elsewhere.parents[0]!.reasoning).not.toBe("high");
  });
});

describe("a subagent routed by a profile (pi)", () => {
  test("runs on the routed model, not the turn's or its file's", async () => {
    const { turn, children, parents } = await setup();
    const routed: TurnSubagent[] = turnSubagents({ pack: undefined }, [agentFile("model: faux/faux-3")], { active: activeProfiles(file({ fast: { "*": { model: "faux/faux-2" } } }), "fast"), engine: "pi" });
    expect(routed[0]).toMatchObject({ name: "refuter", model: "faux/faux-2" });

    const { errors } = await turn({ subagents: routed });

    expect(errors).toEqual([]);
    expect(children.map((child) => child.model)).toEqual(["faux-2"]);
    expect(parents.map((parent) => parent.model)).toEqual(["faux-1", "faux-1"]);
  });

  test("its thinking level reaches the model; a route without one sets none", async () => {
    const withThinking = await setup();
    await withThinking.turn({ subagents: [{ name: "refuter", readOnly: true, model: "faux/faux-2", thinking: "high" }] });
    expect(withThinking.children[0]).toEqual({ model: "faux-2", reasoning: "high" });

    const without = await setup();
    await without.turn({ subagents: [{ name: "refuter", readOnly: true, model: "faux/faux-2" }] });
    expect(without.children[0]!.reasoning).not.toBe("high");
  });

  test("precedence: session profile, then default profile, then the agent file's model, then the turn's", async () => {
    const profiles = file({ session: { refuter: { model: "faux/faux-3" } }, base: { "*": { model: "faux/faux-2" } } }, "base");
    const cases: Array<[string, string | undefined, string, string]> = [
      ["session profile wins over default and file", "session", "model: faux/faux-1", "faux-3"],
      ["default profile wins over the file when the session chose none", undefined, "model: faux/faux-3", "faux-2"],
    ];
    for (const [name, session, frontmatter, expected] of cases) {
      const { turn, children } = await setup();
      await turn({ model: "faux/faux-1", subagents: turnSubagents({ pack: undefined }, [agentFile(frontmatter)], { active: activeProfiles(profiles, session), engine: "pi" }) });
      expect(children[0]!.model, name).toBe(expected);
    }

    // No profile: the file's model, then the turn's.
    const fromFile = await setup();
    await fromFile.turn({ subagents: turnSubagents({ pack: undefined }, [agentFile("model: faux/faux-3")], { active: [], engine: "pi" }) });
    expect(fromFile.children[0]!.model).toBe("faux-3");
    const fromTurn = await setup();
    await fromTurn.turn({ model: "faux/faux-2", subagents: turnSubagents({ pack: undefined }, [agentFile("")], { active: [], engine: "pi" }) });
    expect(fromTurn.children[0]!.model).toBe("faux-2");
  });

  test("a routed model that does not fit pi is skipped like the agent file's: the next source is used", async () => {
    const { turn, children } = await setup();
    await turn({
      model: "faux/faux-1",
      subagents: turnSubagents({ pack: undefined }, [agentFile("model: faux/faux-3")], { active: activeProfiles(file({ p: { "*": { model: "sonnet" } } }), "p"), engine: "pi" }),
    });
    expect(children[0]!.model).toBe("faux-3");
  });

  test("a routed model with no login (or that pi does not know) leaves the child on the turn's model, without an error", async () => {
    const { turn, children } = await setup();
    const { errors } = await turn({ subagents: [{ name: "refuter", readOnly: true, model: "faux/missing" }, { name: "other", readOnly: true, model: "nolog/x" }] });
    expect(errors).toEqual([]);
    expect(children.map((child) => child.model)).toEqual(["faux-1"]);
  });
});
