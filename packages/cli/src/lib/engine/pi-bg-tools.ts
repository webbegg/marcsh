import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BackgroundHub } from "../background/hub";
import { terminalsFor } from "../background/session-terminals";
import {
  BG_KILL_DESCRIPTION,
  BG_LIST_DESCRIPTION,
  BG_START_DESCRIPTION,
  BG_START_GUIDELINES,
  BG_START_SNIPPET,
  BG_STATUS_DESCRIPTION,
  buildStartResult,
  buildStatusResult,
  buildTerminalResult,
  describeKill,
  describeTerminal,
} from "../background/terminal-prompt";
import type { ToolSource } from "./pi-permissions";

/**
 * marcsh's background terminal tools for a pi session (davi7's `extensions/background-terminals/index.ts`, MIT license). Only a
 * turn with a background hub loads them, so child sessions and headless `marcsh run` never have them. `bg_start` asks like
 * `bash` (see `pi-permissions.ts`); the others only read or stop this session's own terminals, and run unasked.
 */

export const BG_START_TOOL = "bg_start";
export const BG_TOOLS = ["bg_start", "bg_status", "bg_list", "bg_kill"] as const;
/** The bg tools plan mode offers: they only read. */
export const BG_PLAN_TOOLS = ["bg_status", "bg_list"] as const;
const BG_EXTENSION = "marcsh-background";
/** Where pi says a tool comes from when an inline extension named `marcsh-background` registered it. */
const BG_SOURCE = `<inline:${BG_EXTENSION}>`;

/** Whether pi's tool is one of marcsh's own bg tools. The name alone proves nothing: it must come from marcsh's extension. */
export function isMarcshBgTool(tool: ToolSource): boolean {
  return (BG_TOOLS as readonly string[]).includes(tool.name) && tool.sourceInfo.path === BG_SOURCE;
}

export const isMarcshBgStart = (tool: ToolSource) => tool.name === BG_START_TOOL && isMarcshBgTool(tool);

/**
 * Where a `bg_start` call runs: its `working_dir` resolved against the session's folder, or that folder without one. Approval, pack
 * hooks and `bg_start` itself all use this, so the command is judged in the directory it runs in.
 */
export function bgStartDir(cwd: string, input: Record<string, unknown>): string {
  const dir = input.working_dir;
  return resolve(cwd, typeof dir === "string" && dir ? dir : ".");
}

/** Whether the call names a `working_dir` of its own. */
export const hasWorkingDir = (input: Record<string, unknown>) => typeof input.working_dir === "string" && input.working_dir !== "";

/** Why `bg_start` cannot run in `dir`, or undefined when it is a directory. */
export function workingDirError(dir: string): string | undefined {
  try {
    if (statSync(dir).isDirectory()) return undefined;
  } catch {}
  return `working_dir is not a directory: ${dir}`;
}

export type BackgroundToolsOptions = {
  hub: BackgroundHub;
  /** The session's project directory: where a command runs unless it names a `working_dir`. */
  cwd: string;
};

const text = (value: string, details: unknown) => ({ content: [{ type: "text" as const, text: value }], details });

const unknownId = (id: string, known: string[]) => new Error(`Unknown terminal id "${id}". Known: ${known.join(", ") || "none"}.`);

export function createBackgroundTools({ hub, cwd }: BackgroundToolsOptions): ToolDefinition[] {
  const terminals = () => terminalsFor(hub);
  const knownIds = () => terminals().list().map((snapshot) => snapshot.id);

  const start: ToolDefinition = {
    name: "bg_start",
    label: "Start background terminal",
    description: BG_START_DESCRIPTION,
    promptSnippet: BG_START_SNIPPET,
    promptGuidelines: BG_START_GUIDELINES,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run in the background (sh -c). It gets no stdin; interactive commands will not work." },
        title: { type: "string", description: "A short name, shown in listings and in /ps." },
        working_dir: { type: "string", description: "Where it runs (default: the project directory)." },
      },
      required: ["command", "title"],
      additionalProperties: false,
    } as never,
    async execute(_toolCallId, params) {
      const input = (params ?? {}) as Record<string, unknown>;
      const command = typeof input.command === "string" ? input.command.trim() : "";
      if (!command) throw new Error("command must be a non-empty string.");
      const title = (typeof input.title === "string" ? input.title : "").replace(/\s+/g, " ").trim().slice(0, 80) || "terminal";
      const dir = bgStartDir(cwd, input);
      const error = workingDirError(dir);
      if (error) throw new Error(error);
      const snapshot = terminals().start({ command, title, cwd: dir });
      return text(buildStartResult(snapshot), { id: snapshot.id, title: snapshot.title, cwd: dir, pid: snapshot.pid });
    },
  };

  const status: ToolDefinition = {
    name: "bg_status",
    label: "Check background terminal",
    description: BG_STATUS_DESCRIPTION,
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: 'The terminal id, e.g. "bt-1".' } },
      required: ["id"],
      additionalProperties: false,
    } as never,
    async execute(_toolCallId, params) {
      const id = String((params as { id?: unknown } | undefined)?.id ?? "");
      const snapshot = terminals().get(id);
      if (!snapshot) throw unknownId(id, knownIds());
      // This result reports the finished terminal itself, so it is not announced again.
      if (snapshot.status !== "running") hub.consume([id]);
      return text(buildStatusResult(snapshot), { id, status: snapshot.status, pid: snapshot.pid, exitCode: snapshot.exitCode, signal: snapshot.signal });
    },
  };

  const list: ToolDefinition = {
    name: "bg_list",
    label: "List background terminals",
    description: BG_LIST_DESCRIPTION,
    parameters: { type: "object", properties: {}, additionalProperties: false } as never,
    async execute() {
      const all = terminals().list();
      return text(all.length === 0 ? "No background terminals." : all.map(describeTerminal).join("\n"), {
        terminals: all.map((snapshot) => ({ id: snapshot.id, title: snapshot.title, status: snapshot.status, pid: snapshot.pid })),
      });
    },
  };

  const kill: ToolDefinition = {
    name: "bg_kill",
    label: "Stop background terminals",
    description: BG_KILL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" }, description: 'The terminal ids to stop, e.g. ["bt-1"].' } },
      required: ["ids"],
      additionalProperties: false,
    } as never,
    async execute(_toolCallId, params) {
      const raw = (params as { ids?: unknown } | undefined)?.ids;
      const ids = [...new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [])];
      if (ids.length === 0) throw new Error("Pass at least one terminal id in ids.");
      // Only this session's terminals: an id it did not start is unknown here.
      const missing = ids.find((id) => !terminals().get(id));
      if (missing) throw unknownId(missing, knownIds());
      const results = await terminals().kill(ids);
      // This call reports them, so they are never announced. The hub may have handed a result on already, to a turn that can still
      // end before the model reads it: the output is shown here anyway (a duplicate, never a loss).
      hub.consume(ids);
      const lines = results.map((result) => {
        const snapshot = terminals().get(result.id);
        return snapshot && snapshot.status !== "running" ? `${describeKill(result)}\n${buildTerminalResult(snapshot)}` : describeKill(result);
      });
      return text(lines.join("\n\n"), { results });
    },
  };

  return [start, status, list, kill];
}

/** The named inline extension that offers the tools, so pi's tool list says they are marcsh's. */
export function createBackgroundTerminalsExtension(options: BackgroundToolsOptions): InlineExtension {
  return {
    name: BG_EXTENSION,
    hidden: true,
    factory: (pi) => {
      for (const tool of createBackgroundTools(options)) pi.registerTool(tool);
    },
  };
}
