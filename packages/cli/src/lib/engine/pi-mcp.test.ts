import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  InMemoryCredentialStore,
  type FauxResponseStep,
  type Message,
} from "@earendil-works/pi-ai";
import type { ChatMessage } from "../chat-types";
import { Mode } from "../modes";
import { openStorage } from "../storage";
import { createPiEngine } from "./pi";
import { trustEveryProject } from "./test-trust";
import type { AgentSession, LoadedMcpConfig, McpServerEntry } from "@earendil-works/pi-coding-agent";
import { createMarcshMcpExtension, disposePiSession, MCP_TOOL_PREFIX, withDirectExposure } from "./pi-mcp";
import type { Engine, EngineEvent, PermissionAsk, PermissionDecision, TurnHost, TurnRequest } from "./types";

let dir: string;
let agentDir: string;
let cwd: string;
let calls: string;
let starts: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-mcp-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  calls = join(dir, "calls.log");
  starts = join(dir, "starts.log");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// A stdio MCP server in one small Bun script: newline-delimited JSON-RPC, one tool `echo`, a log of its starts and calls.
const SERVER = `import { appendFileSync } from "node:fs";
const [callsPath, startsPath] = process.argv.slice(2);
appendFileSync(startsPath, "start\\n");
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
function handle(request) {
  if (request.id === undefined) return;
  switch (request.method) {
    case "initialize":
      return send({ id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } } });
    case "tools/list":
      return send({ id: request.id, result: { tools: [{ name: "echo", description: "Echoes the text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } });
    case "tools/call":
      appendFileSync(callsPath, JSON.stringify(request.params.arguments) + "\\n");
      return send({ id: request.id, result: { content: [{ type: "text", text: "echo: " + request.params.arguments.text }] } });
    default:
      return send({ id: request.id, result: {} });
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf("\\n"); end >= 0; end = buffer.indexOf("\\n")) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
`;

/** Writes the fixture server and an mcp.json that launches it (tools declared to the model, as pi needs for a plain tool). */
function installServer(configPath: string, extra: Record<string, unknown> = {}) {
  const script = join(dir, "server.ts");
  writeFileSync(script, SERVER);
  mkdirSync(join(configPath, ".."), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [script, calls, starts], exposure: "direct", ...extra } } }));
}
const callsMade = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const startsMade = () => (existsSync(starts) ? readFileSync(starts, "utf8").trim().split("\n").filter(Boolean).length : 0);

async function setup(responses: FauxResponseStep[], permissionRules = openStorage(":memory:")) {
  const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses(responses);
  return { engine: createPiEngine({ agentDir, modelRuntime, permissionRules, projectTrust: trustEveryProject }), faux, model: "faux/faux-1", permissionRules };
}

function summarize(events: EngineEvent[]) {
  let reply: ChatMessage = { id: "reply", role: "assistant", parts: [] };
  for (const event of events) if (event.type === "reply") reply = event.update(reply);
  return { reply, errors: events.flatMap((e) => (e.type === "error" ? [e.message] : [])) };
}

async function runTurn(engine: Engine, model: string, overrides: Partial<TurnRequest> = {}, decision: PermissionDecision = "deny") {
  const events: EngineEvent[] = [];
  const asks: PermissionAsk[] = [];
  const notices: string[] = [];
  const host: TurnHost = {
    emit: (event) => events.push(event),
    notify: (message) => notices.push(message),
    askPermission: async (ask) => {
      asks.push(ask);
      return decision;
    },
    askQuestions: async () => null,
  };
  const turn = engine.startTurn({ prompt: "hello", cwd, mode: Mode.BUILD, model, signal: new AbortController().signal, ...overrides }, host);
  await turn.done;
  return { ...summarize(events), asks, notices };
}

const TOOL = `${MCP_TOOL_PREFIX}fixture__echo`;
const echoCall = fauxAssistantMessage([fauxToolCall(TOOL, { text: "hi" }, { id: "mcp-1" })], { stopReason: "toolUse" });
const toolParts = (reply: ChatMessage) => reply.parts.flatMap((p) => (p.type === "tool" ? [p] : []));
const offeredTools = (messages: Message[]) => messages.flatMap((m) => (m.role === "system" ? (m.toolsAdded ?? []).map((tool) => tool.name) : []));
const toolResultTexts = (messages: Message[]) =>
  messages.flatMap((m) => (m.role === "toolResult" ? [m.content.map((block) => ("text" in block ? block.text : "")).join("")] : []));
function reading() {
  const seen: string[][] = [];
  const step: FauxResponseStep = (context) => {
    seen.push(toolResultTexts(context.messages));
    return fauxAssistantMessage([fauxText("ok")]);
  };
  return { seen, step };
}

const entry = (name: string, config: Record<string, unknown>): McpServerEntry => ({ name, config: { command: "srv", ...config }, source: "/agent/mcp.json", scope: "global" }) as McpServerEntry;

describe("withDirectExposure", () => {
  test("a server with no exposure becomes direct; every explicit exposure and the rest of the config are kept", () => {
    const loaded: LoadedMcpConfig = {
      servers: [
        entry("plain", { args: ["a"], toolExposure: { x: "hidden" } }),
        entry("direct", { exposure: "direct" }),
        entry("codemode", { exposure: "codemode" }),
        entry("deferred", { exposure: "deferred" }),
        entry("hidden", { exposure: "hidden" }),
      ],
      errors: ["oops"],
      autoEnableCodemode: false,
      projectConfig: "/p/.pi/mcp.json",
    };

    const result = withDirectExposure(loaded);

    expect(result.servers.map((server) => [server.name, server.config.exposure])).toEqual([
      ["plain", "direct"],
      ["direct", "direct"],
      ["codemode", "codemode"],
      ["deferred", "deferred"],
      ["hidden", "hidden"],
    ]);
    expect(result.servers[0]!.config).toMatchObject({ command: "srv", args: ["a"], toolExposure: { x: "hidden" } });
    expect(result.servers[0]).toMatchObject({ source: "/agent/mcp.json", scope: "global" });
    expect(result.errors).toEqual(["oops"]);
    expect(result.autoEnableCodemode).toBe(false);
    expect(result.projectConfig).toBe("/p/.pi/mcp.json");
    expect(loaded.servers[0]!.config.exposure).toBeUndefined();
  });
});

describe("disposePiSession", () => {
  const fake = (emit: () => Promise<unknown>, log: string[] = []) =>
    ({
      extensionRunner: {
        emit: (event: { type: string; reason: string }) => {
          log.push(`emit ${event.type} ${event.reason}`);
          return emit();
        },
      },
      dispose: () => log.push("dispose"),
    }) as unknown as AgentSession;

  test("tells the extensions the session is over with session_shutdown, then disposes", async () => {
    const log: string[] = [];
    await disposePiSession(fake(async () => log.push("handled"), log));
    expect(log).toEqual(["emit session_shutdown quit", "handled", "dispose"]);
  });

  test("a handler that never finishes cannot hold the turn: the wait is bounded, then it disposes", async () => {
    const log: string[] = [];
    const started = Date.now();
    await disposePiSession(fake(() => new Promise(() => {}), log), 50);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(log).toEqual(["emit session_shutdown quit", "dispose"]);
  });

  test("errors from the shutdown or from dispose are swallowed, and dispose still runs", async () => {
    const log: string[] = [];
    await disposePiSession(fake(async () => { throw new Error("boom"); }, log));
    expect(log).toEqual(["emit session_shutdown quit", "dispose"]);
    const throwing = { extensionRunner: { emit: async () => {} }, dispose: () => { throw new Error("dispose"); } } as unknown as AgentSession;
    await disposePiSession(throwing);
  });

  test("no session is fine", async () => {
    await disposePiSession(undefined);
  });
});

describe("createMarcshMcpExtension", () => {
  test("is pi's MCP extension in a hidden inline extension named marcsh-mcp, logging under the agent dir", () => {
    const factory = () => {};
    const options: unknown[] = [];
    const extension = createMarcshMcpExtension((given) => {
      options.push(given);
      return factory;
    }, "/agent");

    expect(typeof extension).toBe("object");
    if (typeof extension === "function") throw new Error("expected a named inline extension");
    expect(extension.name).toBe("marcsh-mcp");
    expect(extension.hidden).toBe(true);
    expect(extension.factory).toBe(factory);
    expect(options).toEqual([{ logPath: join("/agent", "mcp.log") }]);
  });

  test("given pi's config reader it loads the agent dir and the project with the session's trust, servers defaulting to direct", () => {
    const options: { loadConfig?: (ctx: { cwd: string; isProjectTrusted(): boolean }) => LoadedMcpConfig }[] = [];
    const reads: unknown[] = [];
    createMarcshMcpExtension(
      (given) => {
        options.push(given as never);
        return () => {};
      },
      "/agent",
      (read) => {
        reads.push(read);
        return { servers: [entry("s", {})], errors: [] };
      },
    );

    const loaded = options[0]!.loadConfig!({ cwd: "/project", isProjectTrusted: () => true });

    expect(reads).toEqual([{ agentDir: "/agent", cwd: "/project", projectTrusted: true }]);
    expect(loaded.servers[0]!.config.exposure).toBe("direct");
  });

  test("MCP tools are named mcp__<server>__<tool>", () => {
    expect(MCP_TOOL_PREFIX).toBe("mcp__");
  });
});

describe("MCP on the pi engine (S14)", () => {
  const configs = [
    ["<agentDir>/mcp.json", () => join(agentDir, "mcp.json")],
    ["<project>/.pi/mcp.json", () => join(cwd, ".pi", "mcp.json")],
  ] as const;

  for (const [label, configPath] of configs) {
    describe(`a server configured in ${label}`, () => {
      beforeEach(() => installServer(configPath()));

      test("its tool is offered to the model", async () => {
        let offered: string[] = [];
        const step: FauxResponseStep = (context) => {
          offered = offeredTools(context.messages);
          return fauxAssistantMessage([fauxText("ok")]);
        };
        const { engine, model } = await setup([step]);

        const { errors } = await runTurn(engine, model);

        expect(errors).toEqual([]);
        expect(offered).toContain(TOOL);
      }, 30000);

      test("a server whose config has no exposure exposes its tool directly: offered, asks, runs on allow", async () => {
        installServer(configPath(), { exposure: undefined });
        let offered: string[] = [];
        const { seen, step } = reading();
        const first: FauxResponseStep = (context) => {
          offered = offeredTools(context.messages);
          return echoCall;
        };
        const { engine, model } = await setup([first, step]);

        const { asks, errors, notices } = await runTurn(engine, model, {}, "allow");

        expect(errors).toEqual([]);
        expect(offered).toContain(TOOL);
        expect(asks).toEqual([{ toolName: TOOL, input: { text: "hi" } }]);
        expect(callsMade()).toEqual([{ text: "hi" }]);
        expect(seen[0]).toEqual(["echo: hi"]);
        expect(notices).toEqual([]);
      }, 30000);

      for (const exposure of ["codemode", "deferred"]) {
        test(`an explicit ${exposure} exposure is respected: not offered, never called, one notice`, async () => {
          installServer(configPath(), { exposure });
          let offered: string[] = [];
          const first: FauxResponseStep = (context) => {
            offered = offeredTools(context.messages);
            return echoCall;
          };
          const { engine, model } = await setup([first, fauxAssistantMessage([fauxText("ok")])]);

          const { asks, notices } = await runTurn(engine, model, {}, "allow");

          expect(offered).not.toContain(TOOL);
          expect(asks).toEqual([]);
          expect(callsMade()).toEqual([]);
          expect(notices.filter((notice) => notice.includes("they cannot be called"))).toHaveLength(1);
        }, 30000);
      }

      test("its tool asks through marcsh's approval with the tool and input, and runs on allow", async () => {
        const { seen, step } = reading();
        const { engine, model } = await setup([echoCall, step]);

        const { asks, reply, errors } = await runTurn(engine, model, {}, "allow");

        expect(errors).toEqual([]);
        expect(asks).toEqual([{ toolName: TOOL, input: { text: "hi" } }]);
        expect(callsMade()).toEqual([{ text: "hi" }]);
        expect(toolParts(reply).map((t) => [t.toolName, t.state])).toEqual([[TOOL, "done"]]);
        expect(seen[0]).toEqual(["echo: hi"]);
      }, 30000);

      test("its tool is blocked on deny: the server is never called and the model is told", async () => {
        const { seen, step } = reading();
        const { engine, model } = await setup([echoCall, step]);

        const { asks, reply } = await runTurn(engine, model, {}, "deny");

        expect(asks).toHaveLength(1);
        expect(callsMade()).toEqual([]);
        expect(toolParts(reply)[0]?.state).toBe("error");
        expect(seen[0]?.[0]).toContain("The user denied this tool call.");
      }, 30000);

      test("its tool is neither offered nor callable in plan mode, and never asks", async () => {
        let offered: string[] = [];
        const first: FauxResponseStep = (context) => {
          offered = offeredTools(context.messages);
          return echoCall;
        };
        const { engine, model } = await setup([first, fauxAssistantMessage([fauxText("ok")])]);

        const { asks, reply } = await runTurn(engine, model, { mode: Mode.PLAN }, "allow");

        expect(offered).not.toContain(TOOL);
        expect(asks).toEqual([]);
        expect(callsMade()).toEqual([]);
        expect(toolParts(reply)[0]?.state).toBe("error");
      }, 30000);
    });
  }

  describe("with a server configured", () => {
    beforeEach(() => installServer(join(agentDir, "mcp.json")));

    test("an always answer stores a rule for the tool, so the next call in the project does not ask", async () => {
      const { engine, model, permissionRules } = await setup([echoCall, fauxAssistantMessage([fauxText("ok")]), echoCall, fauxAssistantMessage([fauxText("ok")])]);

      const first = await runTurn(engine, model, {}, "always");
      const second = await runTurn(engine, model, {}, "deny");

      expect(first.asks).toHaveLength(1);
      expect(permissionRules.hasPermissionRule({ cwd, toolName: TOOL })).toBe(true);
      expect(second.asks).toEqual([]);
      expect(callsMade()).toEqual([{ text: "hi" }, { text: "hi" }]);
    }, 30000);

    test("a plan-mode block holds even with a stored always rule", async () => {
      const { engine, model, permissionRules } = await setup([echoCall, fauxAssistantMessage([fauxText("ok")])]);
      permissionRules.addPermissionRule({ cwd, toolName: TOOL });

      const { asks } = await runTurn(engine, model, { mode: Mode.PLAN }, "allow");

      expect(asks).toEqual([]);
      expect(callsMade()).toEqual([]);
    }, 30000);

    test("the / menu list has pi's /mcp command, and listing it does not start the server", async () => {
      const { engine } = await setup([]);
      const saved: Parameters<Parameters<Engine["warmUpCommands"]>[0]["save"]>[0][] = [];

      await engine.warmUpCommands({ cwd, save: (commands) => saved.push(commands) });

      expect(saved).toHaveLength(1);
      expect(saved[0]!.find((command) => command.name === "mcp")).toMatchObject({ source: "extension" });
      expect(startsMade()).toBe(0);
    }, 30000);

    test("a subagent has no MCP tools and does not start a second server", async () => {
      const childOffered: string[][] = [];
      const child: FauxResponseStep = (context) => {
        childOffered.push(offeredTools(context.messages));
        return fauxAssistantMessage([fauxText("child done")]);
      };
      const task = fauxAssistantMessage([fauxToolCall("Task", { description: "Look around", prompt: "go" }, { id: "task-1" })], { stopReason: "toolUse" });
      const { engine, model } = await setup([task, child, fauxAssistantMessage([fauxText("ok")])]);

      const { errors } = await runTurn(engine, model, {}, "allow");

      expect(errors).toEqual([]);
      expect(childOffered).toHaveLength(1);
      expect(childOffered[0]!.filter((name) => name.startsWith(MCP_TOOL_PREFIX))).toEqual([]);
      expect(startsMade()).toBe(1);
    }, 30000);
  });

  test("with no MCP config no MCP tool is offered and the turn is quiet", async () => {
    let offered: string[] = [];
    const step: FauxResponseStep = (context) => {
      offered = offeredTools(context.messages);
      return fauxAssistantMessage([fauxText("ok")]);
    };
    const { engine, model } = await setup([step]);

    const { errors } = await runTurn(engine, model);

    expect(errors).toEqual([]);
    expect(offered.filter((name) => name.startsWith(MCP_TOOL_PREFIX))).toEqual([]);
  }, 30000);
});
