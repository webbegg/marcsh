import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { isPiToolDenied, notAvailableReason } from "../agent-tools";
import type { Group } from "../tool-names";
import { isMarcshAskUser } from "./pi-ask-user";
import { isMarcshBgTool } from "./pi-bg-tools";
import type { ToolSource } from "./pi-permissions";
import { isMarcshTask, isMarcshTaskTool } from "./pi-subagent";

// What marcsh took away for an agent's `tools` field, kept in the session file: pi restores a resumed session's tools, so the next agent would inherit it.
const NARROWING_ENTRY = "marcsh-agent-tools";
type Narrowing = { denied: Group[]; removed: string[] };

type SessionManagerLike = AgentSession["sessionManager"];

const sameGroups = (a: readonly string[], b: readonly string[]) => a.join(",") === b.join(",");

/** The last narrowing recorded on this session's branch; undefined when marcsh never recorded one. */
function lastNarrowing(sessionManager: Pick<SessionManagerLike, "getBranch">): Narrowing | undefined {
  const branch = sessionManager.getBranch();
  for (let at = branch.length - 1; at >= 0; at--) {
    const entry = branch[at]!;
    if (entry.type !== "custom" || entry.customType !== NARROWING_ENTRY) continue;
    const data = entry.data as { denied?: unknown; removed?: unknown } | undefined;
    if (!Array.isArray(data?.denied) || !Array.isArray(data?.removed)) continue;
    return { denied: data.denied.filter((x): x is Group => typeof x === "string"), removed: data.removed.filter((x): x is string => typeof x === "string") };
  }
  return undefined;
}

/** Where pi says a tool comes from when marcsh's inline MCP extension (see `createMarcshMcpExtension`) registered it. */
const MCP_SOURCE = "<inline:marcsh-mcp>";

/** Task and the task tools, AskUserQuestion, the bg tools and the tools of marcsh's MCP extension: the ones marcsh itself offers by default. A name alone proves nothing. */
function isMarcshOwned(tool: ToolSource): boolean {
  return isMarcshTask(tool) || isMarcshTaskTool(tool) || isMarcshAskUser(tool) || isMarcshBgTool(tool) || tool.sourceInfo.path === MCP_SOURCE;
}

/**
 * Takes the denied groups' tools away from a session and blocks a call to one without asking; `restore` names come back once marcsh registers them.
 * Loaded before the approval extension and again after it, because plan mode's handler there would put a denied tool back.
 */
export function createDeniedToolsExtension(
  denied: readonly Group[],
  { restore = [], onRemoved }: { restore?: readonly string[]; onRemoved?: (names: string[]) => void } = {},
): ExtensionFactory {
  return (pi) => {
    const isDenied = (name: string) => isPiToolDenied(name, denied);
    // A tool that registers late (an MCP server connecting after start) comes back when it shows up; `restore` is filled in after the session exists.
    let pending: Set<string> | undefined;
    pi.on("tool_call", (event) => (isDenied(event.toolName) ? { block: true, reason: notAvailableReason(event.toolName) } : undefined));
    const narrow = () => {
      let active = pi.getActiveTools();
      pending ??= new Set(restore);
      if (pending.size > 0) {
        const owned = new Set(pi.getAllTools().filter(isMarcshOwned).map((tool) => tool.name));
        const back = [...pending].filter((name) => owned.has(name));
        for (const name of back) pending.delete(name);
        active = [...new Set([...active, ...back])];
      }
      const removed = active.filter(isDenied);
      if (removed.length > 0) onRemoved?.(removed);
      pi.setActiveTools(active.filter((name) => !isDenied(name)));
    };
    pi.on("before_agent_start", narrow);
    pi.on("turn_start", narrow);
    // The first turn declares its tools before `turn_start` runs: the model is shown only the tools that are active when the request goes out.
    pi.on("context_with_system", (event) => {
      const active = new Set(pi.getActiveTools());
      return {
        messages: event.messages.map((message) =>
          message.role === "system" && message.toolsAdded ? { ...message, toolsAdded: message.toolsAdded.filter((tool) => active.has(tool.name)) } : message,
        ),
      };
    });
  };
}

/** What one turn does to the tools of a session for the selected agent's `tools` field. */
export type TurnNarrowing = {
  /** Whether the agent keeps a tool of this name (for allow-lists built from names). */
  allowed(name: string): boolean;
  /** Whether the agent denies any group at all. */
  denies: boolean;
  /** The extension for the turn's own session (empty when there is nothing to take away or bring back). Load it before and after the approval extension. */
  extensions: ExtensionFactory[];
  /** The extension for a Task child: it starts clean, so it gets the denial and never the parent's restore. */
  childExtensions: ExtensionFactory[];
  /** Brings back what an earlier agent took away. Run it before `bindExtensions`; `offered` lists what a new session would offer. */
  restore(session: AgentSession, offered: () => Promise<readonly string[]>): Promise<void>;
  /** Makes `names` (default: the active tools) the active ones, minus the denied; what was taken is remembered for `record`. */
  narrow(session: AgentSession, names?: readonly string[]): void;
  /** Writes what this turn took away to the session when it differs from the last record. */
  record(session: AgentSession | undefined): void;
};

/**
 * The narrowing of one turn. Only what marcsh itself narrowed on an earlier turn of this conversation is undone,
 * and only when this turn's agent narrows differently (plan mode can only get narrower, never widen).
 */
export function narrowForTurn({
  denied,
  planMode,
  sessionManager,
}: {
  denied: readonly Group[];
  planMode: boolean;
  sessionManager: Pick<SessionManagerLike, "getBranch"> | undefined;
}): TurnNarrowing {
  const allowed = (name: string) => !isPiToolDenied(name, denied);
  const previous = sessionManager && lastNarrowing(sessionManager);
  const toRestore = !planMode && previous && !sameGroups(previous.denied, denied) ? previous.removed : [];
  // What this turn took away, by name, for the record the next turn reads.
  const removedNow = new Set<string>();
  const removedBy = (names: readonly string[]) => names.forEach((name) => removedNow.add(name));
  // The recorded names that are not registered when the session starts (MCP's connect later); filled in by `restore`, before any extension runs.
  const restoreLater: string[] = [];

  return {
    allowed,
    denies: denied.length > 0,
    extensions: denied.length > 0 || toRestore.length > 0 ? [createDeniedToolsExtension(denied, { restore: restoreLater, onRemoved: removedBy })] : [],
    childExtensions: denied.length > 0 ? [createDeniedToolsExtension(denied)] : [],
    async restore(session, offered) {
      if (toRestore.length === 0) return;
      // Only tools a new session would offer or marcsh owns come back, so a tool the user never had is not handed out.
      const registered = new Map(session.getAllTools().map((tool) => [tool.name, tool]));
      const fresh = new Set(await offered());
      const comeBack = toRestore.filter((name) => {
        const tool = registered.get(name);
        return allowed(name) && tool !== undefined && (fresh.has(name) || isMarcshOwned(tool));
      });
      restoreLater.push(...toRestore.filter((name) => allowed(name) && !registered.has(name)));
      session.setActiveToolsByName([...new Set([...session.getActiveToolNames(), ...comeBack])]);
    },
    narrow(session, names = session.getActiveToolNames()) {
      removedBy(names.filter((name) => !allowed(name)));
      session.setActiveToolsByName(names.filter(allowed));
    },
    // A record that is never written only means the next turn undoes nothing.
    record(session) {
      if (!session) return;
      try {
        const same = previous !== undefined && sameGroups(previous.denied, denied);
        const registered = new Set(session.getAllTools().map((tool) => tool.name));
        // Names an earlier narrowing took away and this turn could not put back yet (not registered) stay on the record.
        const carried = previous ? previous.removed.filter((name) => same || !registered.has(name)) : [];
        const removed = [...new Set([...removedNow, ...carried])].sort();
        const unchanged = previous ? same && sameGroups(removed, [...previous.removed].sort()) : denied.length === 0;
        if (!unchanged) session.sessionManager.appendCustomEntry(NARROWING_ENTRY, { denied: [...denied], removed } satisfies Narrowing);
      } catch {}
    },
  };
}
