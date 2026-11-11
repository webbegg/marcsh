import { useCallback } from "react";
import { useDialog } from "../../providers/dialog";
import { DialogSearchList } from "../dialog-search-list";
import { PackInstallDialogContent, PackPickerDialogContent } from "./pack-dialogs";
import { agentLabel, type Agent } from "../../lib/agents";

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

  return (
    <DialogSearchList
      items={rows}
      onSelect={handleSelect}
      filterFn={(row, query) => label(row).toLowerCase().includes(query.toLowerCase())}
      renderItem={(row, isSelected) => (
        <text selectable={false} fg={isSelected ? "black" : "white"}>
          {row.kind === "agent"
            ? `${row.agent.id === currentId ? " • " : "   "}${label(row)}${row.agent.description ? `  ${row.agent.description}` : ""}`
            : `   ${row.label}`}
        </text>
      )}
      getKey={(row) => (row.kind === "agent" ? row.agent.id : `action:${row.id}`)}
      placeholder="Search agents"
      emptyText="No matching agents"
    />
  );
};
