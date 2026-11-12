import { useCallback, useState } from "react";
import { useDialog } from "../../providers/dialog";
import { DialogSearchList } from "../dialog-search-list";
import { PackInstallDialogContent, PackPickerDialogContent } from "./pack-dialogs";
import { agentLabel, type Agent } from "../../lib/agents";
import { lockProblem, packsWithHooksOn } from "../../lib/packs";
import { Mode } from "../../lib/modes";

type AgentsDialogContentProps = {
  agents: Agent[];
  currentId: string;
  onSelectAgent: (id: string) => void;
  /** Called after a pack was installed, updated or removed, so the agent list is read again. */
  onPacksChanged?: () => void;
};

type Row = { kind: "agent"; agent: Agent } | { kind: "action"; id: "install" | "update" | "remove" | "hooks"; label: string };

// After the agents: the pack actions.
const ACTIONS: Row[] = [
  { kind: "action", id: "install", label: "Install from GitHub…" },
  { kind: "action", id: "update", label: "Update packs…" },
  { kind: "action", id: "remove", label: "Remove a pack…" },
  { kind: "action", id: "hooks", label: "Pack hooks…" },
];

// The permission comes before the description, which is the pack's own words and may claim anything. Build needs no tag.
const permissionTag = (agent: Agent) => (agent.mode === Mode.PLAN ? "(read-only)" : agent.pack ? "(build)" : undefined);

/** One agent's row: a bullet on the current one, its label, its permission tag (and "hooks on" when its pack's hooks run), then its description. */
function agentRowText(agent: Agent, agents: readonly Agent[], currentId: string, hooksOn: ReadonlySet<string>) {
  const parts = [agent.id === currentId ? " • " : "   ", agentLabel(agent, agents)];
  const tag = permissionTag(agent);
  if (tag) parts.push(`  ${tag}`);
  if (agent.pack && hooksOn.has(agent.pack)) parts.push("  (hooks on)");
  if (agent.description) parts.push(`  ${agent.description}`);
  return parts.join("");
}

export const AgentsDialogContent = ({ 
  agents, 
  currentId,
  onSelectAgent,
  onPacksChanged = () => {},
}: AgentsDialogContentProps) => {
  const dialog = useDialog();
  // An unreadable packs.json hides every pack agent without a word otherwise.
  const [problem] = useState(() => lockProblem());
  // The packs whose hooks are enabled and still match what was approved: their agents' rows say so.
  const [hooksOn] = useState(() => packsWithHooksOn());

  const rows: Row[] = [...agents.map((agent): Row => ({ kind: "agent", agent })), ...ACTIONS];

  const handleSelect = useCallback(
    (row: Row) => {
      if (row.kind === "agent") {
        onSelectAgent(row.agent.id);
        dialog.close();
      } else if (row.id === "install") {
        dialog.open({ title: "Install from GitHub", children: <PackInstallDialogContent onChanged={onPacksChanged} /> });
      } else {
        const title = row.id === "update" ? "Update a pack" : row.id === "hooks" ? "Pack hooks" : "Remove a pack";
        dialog.open({ title, children: <PackPickerDialogContent action={row.id} onChanged={onPacksChanged} /> });
      }
    },
    [onSelectAgent, onPacksChanged, dialog],
  );

  const label = (row: Row) => (row.kind === "agent" ? agentLabel(row.agent, agents) : row.label);

  return (
    <box flexDirection="column" gap={1}>
      {problem && (
        <text fg="yellow" wrapMode="word" width="100%">
          {`packs.json could not be read: ${problem}; pack agents are hidden`}
        </text>
      )}
      <DialogSearchList
        items={rows}
        onSelect={handleSelect}
        filterFn={(row, query) => label(row).toLowerCase().includes(query.toLowerCase())}
        renderItem={(row, isSelected) => (
          <text selectable={false} fg={isSelected ? "black" : "white"}>
            {row.kind === "agent" ? agentRowText(row.agent, agents, currentId, hooksOn) : `   ${row.label}`}
          </text>
        )}
        getKey={(row) => (row.kind === "agent" ? row.agent.id : `action:${row.id}`)}
        placeholder="Search agents"
        emptyText="No matching agents"
      />
    </box>
  );
};
