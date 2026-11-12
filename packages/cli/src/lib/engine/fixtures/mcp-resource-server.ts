// A minimal stdio MCP server for the pi agent-tools tests: one tool (`echo`) and one resource (`file:///secret`).
// Reading the resource writes a marker file (the path in argv[2]), so a test can tell that a read really reached the server.
import { writeFileSync } from "node:fs";

const marker = process.argv[2];
let buffer = "";

const send = (message: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

function handle(request: { id?: number; method: string; params?: { protocolVersion?: string } }) {
  if (request.id === undefined) return;
  switch (request.method) {
    case "initialize":
      return send({
        id: request.id,
        result: { protocolVersion: request.params?.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "fx", version: "1" } },
      });
    case "tools/list":
      return send({ id: request.id, result: { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } }] } });
    case "resources/list":
      return send({ id: request.id, result: { resources: [{ uri: "file:///secret", name: "secret" }] } });
    case "resources/templates/list":
      return send({ id: request.id, result: { resourceTemplates: [] } });
    case "resources/read":
      if (marker) writeFileSync(marker, "1");
      return send({ id: request.id, result: { contents: [{ uri: "file:///secret", text: "SECRET" }] } });
    default:
      return send({ id: request.id, result: {} });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
