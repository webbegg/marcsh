import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// S20 (verifier): a signal while a pi turn runs an approved command must also close the turn's MCP servers, and a second
// signal during a slow shutdown must still leave no command behind. The MCP fixture ignores the end of its stdin, as some
// servers do, so only an explicit close stops it.

let dir: string;
const killLater: number[] = [];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-quit-mcp-")));
  mkdirSync(join(dir, "project"), { recursive: true });
  mkdirSync(join(dir, "agent"), { recursive: true });
});

afterEach(() => {
  for (const pid of killLater.splice(0)) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {}
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const readNumber = (path: string) => (existsSync(path) ? Number(readFileSync(path, "utf8").trim().split("\n")[0]) || 0 : 0);

async function until(condition: () => boolean, ms = 15_000) {
  for (let waited = 0; waited < ms && !condition(); waited += 25) await sleep(25);
  if (!condition()) throw new Error("condition not met in time");
}

/** True while a process (or, for a negative id, any process of the group) runs; zombies run nothing. */
function running(id: number) {
  const ps = Bun.spawnSync(["ps", "-A", "-o", "pid=,pgid=,stat="]).stdout.toString();
  return ps
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .some(([pid, pgid, stat]) => Number(id < 0 ? pgid : pid) === Math.abs(id) && !stat?.startsWith("Z"));
}

async function gone(id: number, ms = 3000) {
  for (let waited = 0; waited < ms && running(id); waited += 50) await sleep(50);
  return !running(id);
}

const MCP_SERVER = `import { appendFileSync } from "node:fs";
appendFileSync(process.argv[2], process.pid + "\\n");
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf("\\n"); end >= 0; end = buffer.indexOf("\\n")) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (r.id === undefined) continue;
    if (r.method === "initialize") send({ id: r.id, result: { protocolVersion: r.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
    else if (r.method === "tools/list") send({ id: r.id, result: { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: {} } }] } });
    else send({ id: r.id, result: {} });
  }
});
// Keeps running after stdin ends.
setInterval(() => {}, 1000);
`;

const SLOW_EXTENSION = `export default function (pi) {
  pi.on("session_shutdown", async () => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
  });
}
`;

// A whole marcsh-like process: a pi turn with a long approved command, registered with the app's quit path and signal handlers.
const CHILD = (cliSrc: string) => `
const [, , agentDir, cwd, pgidFile, marker] = process.argv;
const { createPiEngine } = await import(${JSON.stringify(join(cliSrc, "lib/engine/pi.ts"))});
const { openStorage } = await import(${JSON.stringify(join(cliSrc, "lib/storage.ts"))});
const { registerTurn, installQuitSignals } = await import(${JSON.stringify(join(cliSrc, "lib/quit.ts"))});
const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText, InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
const faux = fauxProvider({ models: [{ id: "faux-1" }] });
const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
modelRuntime.registerNativeProvider(faux.provider);
faux.setResponses([
  fauxAssistantMessage([fauxToolCall("bash", { command: "echo $$ > " + pgidFile + "; sleep 8; touch " + marker }, { id: "b1" })], { stopReason: "toolUse" }),
  fauxAssistantMessage([fauxText("done")]),
]);
const engine = createPiEngine({ agentDir, modelRuntime, permissionRules: openStorage(":memory:") });
const abort = new AbortController();
installQuitSignals({ destroy() {} });
const turn = engine.startTurn(
  { prompt: "go", cwd, mode: "BUILD", model: "faux/faux-1", signal: abort.signal },
  { emit() {}, askPermission: async () => "allow", askQuestions: async () => null },
);
registerTurn({ stop: () => abort.abort(), done: turn.done });
`;

async function startChild(options: { mcp?: boolean; slowShutdown?: boolean }) {
  const agentDir = join(dir, "agent");
  const pgidFile = join(dir, "pgid");
  const marker = join(dir, "marker");
  const mcpPids = join(dir, "mcp.pids");
  if (options.mcp) {
    writeFileSync(join(dir, "mcp-server.ts"), MCP_SERVER);
    writeFileSync(
      join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [join(dir, "mcp-server.ts"), mcpPids], exposure: "direct" } } }),
    );
  }
  if (options.slowShutdown) {
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(join(agentDir, "extensions", "slow.ts"), SLOW_EXTENSION);
  }
  const script = join(dir, "child.ts");
  writeFileSync(script, CHILD(join(import.meta.dir, "..", "..")));
  const child = Bun.spawn([process.execPath, script, agentDir, join(dir, "project"), pgidFile, marker], { cwd: dir, stdout: "ignore", stderr: "ignore" });
  killLater.push(child.pid);
  await until(() => readNumber(pgidFile) > 0 && (!options.mcp || readNumber(mcpPids) > 0));
  const pgid = readNumber(pgidFile);
  const mcpPid = readNumber(mcpPids);
  killLater.push(pgid);
  if (mcpPid) killLater.push(mcpPid);
  return { child, pgid, mcpPid, marker };
}

describe("quitting by signal during a pi turn with an MCP server (S20, verifier)", () => {
  test.each([
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const)("%s closes the turn's MCP server and kills its command group; exit %d", async (signal, code) => {
    const { child, pgid, mcpPid, marker } = await startChild({ mcp: true });
    expect(running(mcpPid)).toBe(true);
    child.kill(signal);
    const outcome = await Promise.race([child.exited, sleep(8000).then(() => "still running" as const)]);
    expect(outcome).toBe(code);
    expect(await gone(-pgid)).toBe(true);
    expect(await gone(mcpPid)).toBe(true);
    await sleep(500);
    expect(existsSync(marker)).toBe(false);
  }, 40_000);

  test("a second SIGTERM during a slow extension shutdown exits at once, and the command group is still gone", async () => {
    const { child, pgid, marker } = await startChild({ slowShutdown: true });
    child.kill("SIGTERM");
    await sleep(300);
    // Still waiting for the extension's session_shutdown (2.5 s).
    expect(child.exitCode).toBeNull();
    const second = Date.now();
    child.kill("SIGTERM");
    const outcome = await Promise.race([child.exited, sleep(5000).then(() => "still running" as const)]);
    expect(outcome).toBe(143);
    expect(Date.now() - second).toBeLessThan(1500);
    expect(await gone(-pgid)).toBe(true);
    expect(existsSync(marker)).toBe(false);
  }, 40_000);
});
