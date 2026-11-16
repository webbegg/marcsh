import type { InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describeLeftover, scanLeftovers, stopLeftovers, type StopOptions } from "../background/leftovers";
import { leftoverWatch } from "../background/leftover-watch";
import type { ToolSource } from "./pi-permissions";

/**
 * marcsh's leftover-process tools for a pi session (see `background/leftovers.ts`): `proc_list` lists the processes this marcsh run's
 * tools started that still run on their own, `proc_stop` stops some of them. Only a turn with a background hub loads them, like the
 * bg tools. Both run unasked: they only read the process table, or stop what this run's own tools left behind (never another
 * process). Plan mode offers `proc_list` only.
 */

export const PROC_TOOLS = ["proc_list", "proc_stop"] as const;
/** The proc tools plan mode offers: it only reads. */
export const PROC_PLAN_TOOLS = ["proc_list"] as const;
const PROC_EXTENSION = "marcsh-procs";
/** Where pi says a tool comes from when an inline extension named `marcsh-procs` registered it. */
const PROC_SOURCE = `<inline:${PROC_EXTENSION}>`;

/** Whether pi's tool is one of marcsh's own proc tools: the name alone proves nothing, it must come from marcsh's extension. */
export function isMarcshProcTool(tool: ToolSource): boolean {
  return (PROC_TOOLS as readonly string[]).includes(tool.name) && tool.sourceInfo.path === PROC_SOURCE;
}

/** How the tools find and stop processes. Default: this marcsh process's marker and the platform's process table (tests inject them). */
export type ProcToolsOptions = StopOptions;

/** At most this many processes are listed in one result, and so many pids taken by one stop. */
const MAX_LISTED = 30;
const MAX_STOP = 50;

const LIST_DESCRIPTION =
  "List the processes this marcsh run's tools started that still run on their own after the tool call or background terminal that started them ended " +
  "(for example a server started with `cmd &`, a browser a test left open, a watcher): pid, age, memory and command. Running tool calls, running " +
  "background terminals (see bg_list) and the user's own processes are never listed. Check it before you finish work that started servers, browsers or watchers.";

const STOP_DESCRIPTION =
  "Stop leftover processes by pid, as proc_list lists them: SIGTERM, then SIGKILL after 2 seconds. Only this marcsh run's leftover processes can be " +
  "stopped; any other pid is refused. Do not stop a process the user asked to keep running.";

const text = (value: string, details: unknown) => ({ content: [{ type: "text" as const, text: value }], details });

export function createProcTools(options: ProcToolsOptions = {}): ToolDefinition[] {
  const list: ToolDefinition = {
    name: "proc_list",
    label: "List leftover processes",
    description: LIST_DESCRIPTION,
    parameters: { type: "object", properties: {}, additionalProperties: false } as never,
    async execute() {
      const found = await scanLeftovers(options);
      if (found.length === 0) return text("No leftover processes.", { processes: [] });
      const shown = found.slice(0, MAX_LISTED);
      const lines = [
        `${found.length} leftover process${found.length === 1 ? "" : "es"} started by this marcsh run, newest first:`,
        ...shown.map((left) => describeLeftover(left)),
        ...(found.length > shown.length ? [`… and ${found.length - shown.length} more`] : []),
      ];
      return text(lines.join("\n"), {
        processes: shown.map(({ pid, startedAt, rssMb, bg, call }) => ({ pid, startedAt, rssMb, ...(bg ? { bg } : {}), ...(call ? { call } : {}) })),
        total: found.length,
      });
    },
  };

  const stop: ToolDefinition = {
    name: "proc_stop",
    label: "Stop leftover processes",
    description: STOP_DESCRIPTION,
    parameters: {
      type: "object",
      properties: { pids: { type: "array", items: { type: "integer" }, description: "The pids to stop, as proc_list lists them." } },
      required: ["pids"],
      additionalProperties: false,
    } as never,
    async execute(_toolCallId, params) {
      const raw = (params as { pids?: unknown } | undefined)?.pids;
      const pids = [...new Set(Array.isArray(raw) ? raw.filter((pid): pid is number => Number.isInteger(pid) && pid > 1) : [])];
      if (pids.length === 0) throw new Error("Pass at least one pid in pids, as proc_list lists them.");
      if (pids.length > MAX_STOP) throw new Error(`At most ${MAX_STOP} pids at once.`);
      const result = await stopLeftovers(pids, options);
      void leftoverWatch.refresh({ force: true });
      const lines = [
        ...result.stopped.map((item) => `Stopped pid ${item.pid} (${item.signal}${item.group ? ", with its process group" : ""}): ${item.command.slice(0, 160)}`),
        ...result.failed.map((item) => `Not stopped pid ${item.pid}: ${item.reason}`),
      ];
      return text(lines.join("\n"), result);
    },
  };

  return [list, stop];
}

/** The named inline extension that offers the tools, so pi's tool list says they are marcsh's. */
export function createProcToolsExtension(options: ProcToolsOptions = {}): InlineExtension {
  return {
    name: PROC_EXTENSION,
    hidden: true,
    factory: (pi) => {
      for (const tool of createProcTools(options)) pi.registerTool(tool);
    },
  };
}
