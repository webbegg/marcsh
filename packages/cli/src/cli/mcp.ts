import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { McpArgs } from "../cli-args";
import { defaultPiAgentDir } from "../lib/engine/pi";
import { isProjectTrusted } from "../lib/engine/pi-trust";
import { printable } from "../lib/safe-text";
import { getStorage } from "../lib/storage";
import { EXIT, processIo, type Io } from "./io";

export type McpDeps = { io?: Io; cwd?: string; isTrusted?: (cwd: string) => boolean };

type Servers = Record<string, unknown>;
type McpFile = { path: string; text?: string; config: Record<string, unknown> & { mcpServers?: Servers } };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** pi names a server's tools `mcp__<server>__<tool>` with `-` as `_`, so two names that only differ there would share tools. */
const namespace = (name: string) => name.replace(/-/g, "_");

/** The file as pi reads it (`mcp.json`: an object whose `mcpServers` is an object). A file that is not there is an empty config. Throws with the reason. */
function readMcpFile(path: string): McpFile {
  if (!existsSync(path)) return { path, config: {} };
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(config) || (config.mcpServers !== undefined && !isRecord(config.mcpServers))) {
    throw new Error(`${path}: expected an object with an "mcpServers" object`);
  }
  return { path, text, config };
}

/** Writes `text` next to `path` and renames it over: a reader never sees half a file. A symlink is followed, so the link stays. */
function writeAtomically(path: string, text: string) {
  const target = existsSync(path) ? realpathSync(path) : path;
  // mcp.json can hold tokens in headers: a new file is owner-only, an existing one keeps the permissions it has.
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
  try {
    writeFileSync(temp, text, { flag: "wx", mode });
    chmodSync(temp, mode);
    renameSync(temp, target);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/** A URL as it is safe to print: no user name, password or query (they carry credentials). */
function showUrl(text: string): string {
  try {
    const url = new URL(text);
    return `${url.origin}${url.pathname}${url.search ? "?…" : ""}`;
  } catch {
    return "(invalid url)";
  }
}

/** One line for a server: what it runs or where it connects, never its environment or headers. */
function describeServer(name: string, entry: unknown): string {
  const what = !isRecord(entry)
    ? "(invalid)"
    : typeof entry.command === "string"
      ? [entry.command, ...(Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [])].join(" ")
      : typeof entry.url === "string"
        ? showUrl(entry.url)
        : "(invalid)";
  const disabled = isRecord(entry) && entry.enabled === false ? " (disabled)" : "";
  // Names and commands come from files a project can ship: nothing in them may reach the terminal as a control sequence.
  return `  ${printable(name)}  ${printable(what)}${disabled}`;
}

/** `marcsh mcp list|add`: resolves with the exit code. */
export async function mcpCommand(args: McpArgs, deps: McpDeps = {}): Promise<number> {
  const { io = processIo, cwd = process.cwd(), isTrusted = (path) => isProjectTrusted(path, getStorage) } = deps;
  const fail = (message: string) => {
    io.stderr(`marcsh: ${message}\n`);
    return EXIT.failed;
  };
  const globalPath = join(defaultPiAgentDir(), "mcp.json");

  if (args.action === "add") {
    try {
      const file = readMcpFile(globalPath);
      const servers = file.config.mcpServers ?? {};
      if (servers[args.name] !== undefined && !args.force) {
        return fail(`MCP server "${args.name}" already exists in ${globalPath} (use --force to replace it)`);
      }
      const clash = Object.keys(servers).find((other) => other !== args.name && namespace(other) === namespace(args.name));
      if (clash) return fail(`MCP server "${args.name}" conflicts with "${clash}" (their tools would share a name)`);

      const [command = "", ...rest] = args.command;
      servers[args.name] = { command, ...(rest.length > 0 ? { args: rest } : {}) };
      file.config.mcpServers = servers;
      // The indentation the file already has is kept, like pi's own editor of this file does.
      const indent = (file.text && /^([ \t]+)\S/m.exec(file.text)?.[1]) || "  ";
      writeAtomically(globalPath, `${JSON.stringify(file.config, null, indent)}\n`);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    io.stdout(`Added MCP server "${args.name}" to ${globalPath}\n`);
    return EXIT.ok;
  }

  let code: number = EXIT.ok;
  const show = (path: string, label: string, emptyText?: string) => {
    try {
      const names = Object.entries(readMcpFile(path).config.mcpServers ?? {});
      if (names.length === 0 && emptyText) io.stdout(`${emptyText}\n`);
      else io.stdout(`${path} (${label})\n${names.map(([name, entry]) => describeServer(name, entry)).join("\n")}${names.length > 0 ? "\n" : ""}`);
    } catch (err) {
      io.stderr(`marcsh: ${err instanceof Error ? err.message : String(err)}\n`);
      code = EXIT.failed;
    }
  };

  show(globalPath, "global", `No MCP servers in ${globalPath}.`);
  const projectPath = join(cwd, ".pi", "mcp.json");
  if (existsSync(projectPath)) {
    io.stdout("\n");
    show(projectPath, isTrusted(cwd) ? "project, trusted" : "project, not trusted: pi does not load it");
  }
  return code;
}
