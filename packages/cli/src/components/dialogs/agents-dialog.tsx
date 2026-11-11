import { useCallback, useState } from "react";
import { useDialog } from "../../providers/dialog";
import { DialogSearchList } from "../dialog-search-list";
import { PackInstallDialogContent, PackPickerDialogContent } from "./pack-dialogs";
import { agentLabel, type Agent } from "../../lib/agents";
import { lockProblem } from "../../lib/packs";
import { Mode } from "../../lib/modes";

type AgentsDialogContentProps = {
  agents: Agent[];
  currentId: string;
  onSelectAgent: (id: string) => void;
  /** Called after a pack was installed, updated or removed, so the agent list is read again. */
  onPacksChanged?: () => void;
};

type Row = { kind: "agent"; agent: Agent } | { kind: "action"; id: "install" | "update" | "remove"; label: string };

// After the agents: the pack actions.
const ACTIONS: Row[] = [
  { kind: "action", id: "install", label: "Install from GitHub…" },
  { kind: "action", id: "update", label: "Update packs…" },
  { kind: "action", id: "remove", label: "Remove a pack…" },
];

export const AgentsDialogContent = ({ 
  agents, 
  currentId,
  onSelectAgent,
  onPacksChanged = () => {},
}: AgentsDialogContentProps) => {
  const dialog = useDialog();
  // An unreadable packs.json hides every pack agent without a word otherwise.
  const [problem] = useState(() => lockProblem());

  const rows: Row[] = [...agents.map((agent): Row => ({ kind: "agent", agent })), ...ACTIONS];

  const handleSelect = useCallback(
    (row: Row) => {
      if (row.kind === "agent") {
        onSelectAgent(row.agent.id);
        dialog.close();
      } else if (row.id === "install") {
        dialog.open({ title: "Install from GitHub", children: <PackInstallDialogContent onChanged={onPacksChanged} /> });
      } else {
        const title = row.id === "update" ? "Update a pack" : "Remove a pack";
        dialog.open({ title, children: <PackPickerDialogContent action={row.id} onChanged={onPacksChanged} /> });
      }
    },
    [onSelectAgent, onPacksChanged, dialog],
  );

  const label = (row: Row) => (row.kind === "agent" ? agentLabel(row.agent, agents) : row.label);

  // The permission comes before the description, which is the pack's own words and may claim anything. Build needs no tag.
  const permission = (agent: Agent) => (agent.mode === Mode.PLAN ? "(read-only)" : agent.pack ? "(build)" : undefined);
  const agentRow = (agent: Agent) =>
    [agent.id === currentId ? " • " : "   ", agentLabel(agent, agents), permission(agent) && `  ${permission(agent)}`, agent.description && `  ${agent.description}`]
      .filter(Boolean)
      .join("");

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
            {row.kind === "agent" ? agentRow(row.agent) : `   ${row.label}`}
          </text>
        )}
        getKey={(row) => (row.kind === "agent" ? row.agent.id : `action:${row.id}`)}
        placeholder="Search agents"
        emptyText="No matching agents"
      />
    </box>
  );
};
