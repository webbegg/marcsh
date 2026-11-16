import type { InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describeLeftover, redactCommand, scanLeftovers, stopLeftovers, type StopOptions } from "../background/leftovers";
import { createLeftoverWatch, leftoverWatch, type LeftoverWatch } from "../background/leftover-watch";
import type { ToolSource } from "./pi-permissions";

/**
 * marcsh's leftover-process tools for a pi session (see `background/leftovers.ts`): `proc_list` lists the processes this marcsh run's
 * tools started that still run on their own, `proc_stop` stops some of them. Only a turn with a background hub loads them, like the
 * bg tools. `proc_list` runs unasked: it only reads the process table (command lines redacted). `proc_stop` always asks first, in every
 * approval mode, showing each process, and the ask offers no "always" (see `pi-permissions.ts`): a long-lived program a tool call
 * started (an editor, tmux) can carry the run's marker into processes that are really the user's. Plan mode offers `proc_list` only.
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

/** marcsh's own `proc_stop`: it always asks. */
export function isMarcshProcStop(tool: ToolSource): boolean {
  return tool.name === "proc_stop" && isMarcshProcTool(tool);
}

/** How the tools find and stop processes. Default: this marcsh process's marker and the platform's process table (tests inject them). */
export type ProcToolsOptions = StopOptions;

/** At most this many processes are listed in one result, and so many pids taken by one stop. */
const MAX_LISTED = 30;
const MAX_STOP = 50;

const LIST_DESCRIPTION =
  "List the processes this marcsh run's tools started that still run on their own after the tool call or background terminal that started them ended " +
  "(for example a server started with `cmd &`, a browser a test left open, a watcher): pid, age, memory and command (secret-looking values hidden). " +
  "Running tool calls, running background terminals (see bg_list) and processes the user started themselves are never listed. A process marked " +
  "\"possibly yours\" may be the user's own, opened through something a tool call started (an editor, tmux): do not suggest stopping it. Check the " +
  "list before you finish work that started servers, browsers or watchers.";

const STOP_DESCRIPTION =
  "Stop leftover processes by pid, as proc_list lists them: SIGTERM, then SIGKILL after 2 seconds. The user is always asked first, shown each process. " +
  "Only this marcsh run's leftover processes can be stopped; any other pid is refused. Do not stop a process proc_list marks \"possibly yours\" unless " +
  "the user asked for that process, nor one the user asked to keep running.";

const text = (value: string, details: unknown) => ({ content: [{ type: "text" as const, text: value }], details });

/** The pids a `proc_stop` call names: whole numbers above 1, each once. */
function pidsOf(input: unknown): number[] {
  const raw = (input as { pids?: unknown } | undefined)?.pids;
  return [...new Set(Array.isArray(raw) ? raw.filter((pid): pid is number => Number.isInteger(pid) && pid > 1) : [])];
}

/** `promise`, or a rejection as soon as `signal` aborts (what it waits for keeps going: the watch's scan is shared). */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** marcsh's shared watch (one scan at a time for the status line, `/ps` and the agent), or one of its own for injected options (tests). */
function watchFor(options: ProcToolsOptions): LeftoverWatch {
  if (Object.keys(options).length === 0) return leftoverWatch;
  return createLeftoverWatch({ scan: () => scanLeftovers(options), stop: (targets, extra) => stopLeftovers(targets, { ...options, ...extra }) });
}

/** What the stop prompt says for a `proc_stop` call, by the tool's (shared) parameters object: each tool instance describes with its own watch. */
const stopAsks = new WeakMap<object, (input: unknown) => Promise<string>>();

/** The processes a `proc_stop` call would stop, one per pid, as the approval prompt shows them (commands redacted, "possibly yours" marked). */
async function describeStop(watch: LeftoverWatch, input: unknown): Promise<string> {
  const pids = pidsOf(input).slice(0, MAX_STOP);
  if (pids.length === 0) return "No pid given: nothing will be stopped.";
  await watch.refresh({ force: true });
  const error = watch.scanError();
  const listed = new Map(watch.list().map((left) => [left.pid, left]));
  const lines = pids.map((pid) => {
    const left = listed.get(pid);
    return left ? describeLeftover(left, 120) : `pid ${pid} · not a leftover of this run: it will be refused`;
  });
  return [
    `Stops ${pids.length === 1 ? "this process" : `these ${pids.length} processes`} (SIGTERM, then SIGKILL after 2 s; marcsh checks each again right before)`,
    ...(error ? [`the process table could not be read (${error}): what is shown may be out of date`] : []),
    ...lines,
  ].join("; ");
}

/** The stop prompt's text for marcsh's `proc_stop` call (`tool` as pi lists it, with its parameters). Falls back to the shared watch. */
export function describeProcStop(tool: ToolSource & { parameters?: unknown }, input: unknown): Promise<string> {
  const describe = tool.parameters && typeof tool.parameters === "object" ? stopAsks.get(tool.parameters) : undefined;
  return describe ? describe(input) : describeStop(leftoverWatch, input);
}

export function createProcTools(options: ProcToolsOptions = {}): ToolDefinition[] {
  const watch = watchFor(options);
  const list: ToolDefinition = {
    name: "proc_list",
    label: "List leftover processes",
    description: LIST_DESCRIPTION,
    parameters: { type: "object", properties: {}, additionalProperties: false } as never,
    async execute(_toolCallId, _params, signal) {
      const found = await abortable(watch.refresh({ force: true }), signal);
      const error = watch.scanError();
      if (error) throw new Error(`The process table could not be read (${error}), so nothing is listed. Try again later.`);
      if (found.length === 0) return text("No leftover processes.", { processes: [] });
      const shown = found.slice(0, MAX_LISTED);
      const lines = [
        `${found.length} leftover process${found.length === 1 ? "" : "es"} started by this marcsh run, newest first:`,
        ...shown.map((left) => describeLeftover(left)),
        ...(found.length > shown.length ? [`… and ${found.length - shown.length} more`] : []),
      ];
      return text(lines.join("\n"), {
        processes: shown.map(({ pid, startedAt, rssMb, bg, possiblyYours }) => ({ pid, startedAt, rssMb, ...(bg ? { bg } : {}), ...(possiblyYours ? { possiblyYours } : {}) })),
        total: found.length,
      });
    },
  };

  const stopParameters = {
    type: "object",
    properties: { pids: { type: "array", items: { type: "integer" }, description: "The pids to stop, as proc_list lists them." } },
    required: ["pids"],
    additionalProperties: false,
  };
  stopAsks.set(stopParameters, (input) => describeStop(watch, input));
  const stop: ToolDefinition = {
    name: "proc_stop",
    label: "Stop leftover processes",
    description: STOP_DESCRIPTION,
    parameters: stopParameters as never,
    async execute(_toolCallId, params, signal) {
      const pids = pidsOf(params);
      if (pids.length === 0) throw new Error("Pass at least one pid in pids, as proc_list lists them.");
      if (pids.length > MAX_STOP) throw new Error(`At most ${MAX_STOP} pids at once.`);
      const result = await watch.stop(pids, signal ? { signal } : undefined);
      const stopped = result.stopped.map((item) => ({ ...item, command: redactCommand(item.command) }));
      const lines = [
        ...stopped.map((item) => `Stopped pid ${item.pid} (${item.signal}${item.group ? ", with its process group" : ""}): ${item.command.slice(0, 160)}`),
        ...result.failed.map((item) => `Not stopped pid ${item.pid}: ${item.reason}`),
      ];
      return text(lines.join("\n"), { stopped, failed: result.failed });
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
