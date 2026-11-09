import { join } from "node:path";
import type { ExtensionFactory, InlineExtension, McpExtensionOptions } from "@earendil-works/pi-coding-agent";

/** pi names every MCP tool `mcp__<server>__<tool>`. */
export const MCP_TOOL_PREFIX = "mcp__";
const MCP_EXTENSION = "marcsh-mcp";

/**
 * pi's MCP extension as a hidden inline extension. pi reads the servers from `mcp.json` in its agent dir
 * (marcsh's, since `pi.ts` points `PI_CODING_AGENT_DIR` there) and from `<project>/.pi/mcp.json`, keeps their
 * sign-ins in `mcp-auth.json` next to it, and writes the servers' log to `mcp.log`, which is pinned here to the
 * agent dir too. The tools are ordinary non-built-in tools, so marcsh's approval extension asks for each call
 * and plan mode blocks them.
 *
 * `createMcpExtension` is pi's export, passed in so this module never imports pi.
 */
export function createMarcshMcpExtension(createMcpExtension: (options?: McpExtensionOptions) => ExtensionFactory, agentDir: string): InlineExtension {
  return { name: MCP_EXTENSION, hidden: true, factory: createMcpExtension({ logPath: join(agentDir, "mcp.log") }) };
}
