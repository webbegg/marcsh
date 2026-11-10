import { join } from "node:path";
import type { AgentSession, ExtensionFactory, InlineExtension, LoadedMcpConfig, McpExtensionOptions } from "@earendil-works/pi-coding-agent";

/** pi names every MCP tool `mcp__<server>__<tool>`. */
export const MCP_TOOL_PREFIX = "mcp__";
const MCP_EXTENSION = "marcsh-mcp";

/** How long a turn waits for the extensions to shut down before it ends anyway. */
const SHUTDOWN_TIMEOUT_MS = 3000;

/** pi's reader of `mcp.json` in the agent dir and the trusted project. */
export type LoadMcpConfig = (options: { agentDir: string; cwd: string; projectTrusted: boolean }) => LoadedMcpConfig;

/**
 * Servers that do not say how their tools are reached are reachable directly. pi's own default is `codemode`,
 * which only a `codemode` or `tool_search` tool can call, and marcsh offers neither: without this a
 * Claude-style `mcpServers` config would load and connect but its tools could never be called. An `exposure`
 * the user wrote (`direct`, `codemode`, `deferred`, `hidden`) is kept as written; `toolExposure` is untouched.
 */
export function withDirectExposure(loaded: LoadedMcpConfig): LoadedMcpConfig {
  return {
    ...loaded,
    servers: loaded.servers.map((entry) => (entry.config.exposure === undefined ? { ...entry, config: { ...entry.config, exposure: "direct" } } : entry)),
  };
}

/**
 * pi's `loadMcpConfig`, which its package does not export: read from its module file next to the public entry
 * (pi is pinned exactly, so the path is stable). Undefined if pi cannot be read that way (for example in a
 * bundle without `node_modules`); the MCP extension then keeps pi's own `codemode` default.
 */
export async function importLoadMcpConfig(): Promise<LoadMcpConfig | undefined> {
  try {
    const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
    const config = (await import(new URL("extensions/mcp/config.js", entry).href)) as { loadMcpConfig?: LoadMcpConfig };
    return typeof config.loadMcpConfig === "function" ? config.loadMcpConfig : undefined;
  } catch {
    return undefined;
  }
}

/**
 * pi's MCP extension as a hidden inline extension. pi reads the servers from `mcp.json` in its agent dir
 * (marcsh's, since `pi.ts` points `PI_CODING_AGENT_DIR` there) and from `<project>/.pi/mcp.json`, keeps their
 * sign-ins in `mcp-auth.json` next to it, and writes the servers' log to `mcp.log`, which is pinned here to the
 * agent dir too. The tools are ordinary non-built-in tools, so marcsh's approval extension asks for each call
 * and plan mode blocks them. With `loadMcpConfig`, servers with no `exposure` are exposed `direct` (see `withDirectExposure`).
 *
 * `createMcpExtension` is pi's export, passed in so this module never imports pi at load.
 */
export function createMarcshMcpExtension(
  createMcpExtension: (options?: McpExtensionOptions) => ExtensionFactory,
  agentDir: string,
  loadMcpConfig?: LoadMcpConfig,
): InlineExtension {
  const options: McpExtensionOptions = {
    logPath: join(agentDir, "mcp.log"),
    ...(loadMcpConfig
      ? { loadConfig: (ctx) => withDirectExposure(loadMcpConfig({ agentDir, cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() })) }
      : {}),
  };
  return { name: MCP_EXTENSION, hidden: true, factory: createMcpExtension(options) };
}

/**
 * Ends a pi session marcsh created. `dispose()` never tells the extensions the session is over, and pi's MCP
 * extension only closes its server connections (and so lets the servers and this process exit) on
 * `session_shutdown`; so the event goes out first, as pi does when it quits. A hung extension cannot hold the
 * turn: the wait is bounded, and a failing handler is ignored.
 */
export async function disposePiSession(session: AgentSession | undefined, timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<void> {
  if (!session) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
    // The session is going away either way.
  } finally {
    clearTimeout(timer);
  }
  try {
    session.dispose();
  } catch {
    // Same.
  }
}
