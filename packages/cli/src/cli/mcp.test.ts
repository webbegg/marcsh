import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpArgs } from "../cli-args";
import { mcpCommand } from "./mcp";

/** The arguments of one action, without the `kind` every command carries (`Omit` alone would merge the actions). */
type Without<T> = T extends unknown ? Omit<T, "kind"> : never;

let dir: string;
let agentDir: string;
let project: string;
let out: string;
let err: string;
let trusted: boolean;
let savedAgentDir: string | undefined;
const io = { stdout: (text: string) => void (out += text), stderr: (text: string) => void (err += text) };

const globalFile = () => join(agentDir, "mcp.json");
const projectFile = () => join(project, ".pi", "mcp.json");
const run = (args: Without<McpArgs>) => mcpCommand({ kind: "mcp", ...args } as McpArgs, { io, cwd: project, isTrusted: () => trusted });
const add = (name: string, command: string[], force = false) => run({ action: "add", name, command, force });
const read = (path = globalFile()) => JSON.parse(readFileSync(path, "utf8"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-cli-mcp-"));
  agentDir = join(dir, "agent");
  project = join(dir, "project");
  mkdirSync(project);
  savedAgentDir = process.env.MARCSH_AGENT_DIR;
  process.env.MARCSH_AGENT_DIR = agentDir;
  out = "";
  err = "";
  trusted = false;
});
afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.MARCSH_AGENT_DIR;
  else process.env.MARCSH_AGENT_DIR = savedAgentDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("mcp add", () => {
  test("creates the agent dir and mcp.json with the command and its arguments", async () => {
    expect(await add("fs", ["npx", "-y", "server", "--flag"])).toBe(0);
    expect(read()).toEqual({ mcpServers: { fs: { command: "npx", args: ["-y", "server", "--flag"] } } });
    expect(out).toBe(`Added MCP server "fs" to ${globalFile()}\n`);
    expect(statSync(agentDir).mode & 0o777).toBe(0o700);
    expect(statSync(globalFile()).mode & 0o777).toBe(0o600);
  });

  test("a command without arguments has no args key", async () => {
    await add("solo", ["my-server"]);
    expect(read().mcpServers.solo).toEqual({ command: "my-server" });
  });

  test("keeps the other servers, other keys and the indentation", async () => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(globalFile(), `{\n    "autoEnableCodemode": false,\n    "mcpServers": {\n        "docs": { "url": "https://example.com/mcp" }\n    }\n}\n`);

    expect(await add("fs", ["srv"])).toBe(0);

    expect(read()).toEqual({ autoEnableCodemode: false, mcpServers: { docs: { url: "https://example.com/mcp" }, fs: { command: "srv" } } });
    expect(readFileSync(globalFile(), "utf8")).toContain('\n    "autoEnableCodemode"');
  });

  test("refuses an existing name unless --force, and leaves the file as it was", async () => {
    await add("fs", ["one"]);
    const before = readFileSync(globalFile(), "utf8");

    expect(await add("fs", ["two"])).toBe(1);
    expect(err).toBe(`marcsh: MCP server "fs" already exists in ${globalFile()} (use --force to replace it)\n`);
    expect(readFileSync(globalFile(), "utf8")).toBe(before);

    err = "";
    expect(await add("fs", ["two"], true)).toBe(0);
    expect(read().mcpServers.fs).toEqual({ command: "two" });
    expect(err).toBe("");
  });

  test("refuses a name pi would treat as the same tool namespace", async () => {
    await add("my-server", ["one"]);
    expect(await add("my_server", ["two"])).toBe(1);
    expect(err).toContain('conflicts with "my-server"');
    expect(Object.keys(read().mcpServers)).toEqual(["my-server"]);
  });

  test("a file that is not valid is not touched", async () => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(globalFile(), "{ not json");
    expect(await add("fs", ["srv"])).toBe(1);
    expect(err).toStartWith(`marcsh: ${globalFile()}: `);
    expect(readFileSync(globalFile(), "utf8")).toBe("{ not json");

    writeFileSync(globalFile(), '{"mcpServers": []}');
    err = "";
    expect(await add("fs", ["srv"])).toBe(1);
    expect(err).toBe(`marcsh: ${globalFile()}: expected an object with an "mcpServers" object\n`);
    expect(readFileSync(globalFile(), "utf8")).toBe('{"mcpServers": []}');
  });

  test("writes atomically: no temp file is left, and a symlinked mcp.json keeps its link", async () => {
    mkdirSync(agentDir, { recursive: true });
    const real = join(dir, "dotfiles-mcp.json");
    writeFileSync(real, '{"mcpServers":{}}');
    symlinkSync(real, globalFile());

    expect(await add("fs", ["srv"])).toBe(0);

    expect(read(real).mcpServers.fs).toEqual({ command: "srv" });
    expect(readdirSync(agentDir)).toEqual(["mcp.json"]);
    expect(readdirSync(dir).filter((name) => name.includes("tmp"))).toEqual([]);
  });

  test("keeps the permissions of an existing file", async () => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(globalFile(), '{"mcpServers":{}}', { mode: 0o640 });
    await add("fs", ["srv"]);
    expect(statSync(globalFile()).mode & 0o777).toBe(0o640);
  });
});

describe("mcp list", () => {
  test("says so when nothing is configured", async () => {
    expect(await run({ action: "list" })).toBe(0);
    expect(out).toBe(`No MCP servers in ${globalFile()}.\n`);
  });

  test("lists the global servers: commands, urls and disabled ones, without secrets", async () => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      globalFile(),
      JSON.stringify({
        mcpServers: {
          fs: { command: "npx", args: ["-y", "server"], env: { TOKEN: "s3cret" } },
          docs: { url: "https://user:pw@example.com/mcp?key=s3cret", headers: { Authorization: "Bearer s3cret" } },
          off: { command: "x", enabled: false },
        },
      }),
    );

    expect(await run({ action: "list" })).toBe(0);

    expect(out).toContain(`${globalFile()} (global)`);
    expect(out).toContain("fs  npx -y server");
    expect(out).toContain("docs  https://example.com/mcp");
    expect(out).toContain("off  x (disabled)");
    expect(out).not.toContain("s3cret");
    expect(out).not.toContain("pw@");
    expect(out).not.toContain(projectFile());
  });

  test("shows the project file as project, not trusted, when the project is not trusted", async () => {
    mkdirSync(join(project, ".pi"));
    writeFileSync(projectFile(), JSON.stringify({ mcpServers: { local: { command: "./srv" } } }));

    expect(await run({ action: "list" })).toBe(0);

    expect(out).toContain(`${projectFile()} (project, not trusted: pi does not load it)`);
    expect(out).toContain("local  ./srv");
  });

  test("labels the project file trusted when it is", async () => {
    mkdirSync(join(project, ".pi"));
    writeFileSync(projectFile(), JSON.stringify({ mcpServers: { local: { command: "./srv" } } }));
    trusted = true;
    await run({ action: "list" });
    expect(out).toContain(`${projectFile()} (project, trusted)`);
  });

  test("an unreadable file is reported and exits 1, the other file is still listed", async () => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(globalFile(), "{ nope");
    mkdirSync(join(project, ".pi"));
    writeFileSync(projectFile(), JSON.stringify({ mcpServers: { local: { command: "./srv" } } }));

    expect(await run({ action: "list" })).toBe(1);

    expect(err).toStartWith(`marcsh: ${globalFile()}: `);
    expect(out).toContain("local  ./srv");
  });

  test("names and commands from the files cannot send terminal escapes", async () => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(globalFile(), JSON.stringify({ mcpServers: { bad: { command: "x\u001b[2Jy" } } }));
    await run({ action: "list" });
    expect(out).not.toContain("\u001b");
  });

  test("never writes anything", async () => {
    await run({ action: "list" });
    expect(existsSync(agentDir)).toBe(false);
  });
});
