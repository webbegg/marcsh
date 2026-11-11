import { useCallback } from "react";
import { useDialog } from "../../providers/dialog";
import { DialogSearchList } from "../dialog-search-list";
import { agentLabel, type Agent } from "../../lib/agents";

type AgentsDialogContentProps = {
  agents: Agent[];
  currentId: string;
  onSelectAgent: (id: string) => void;
};

export const AgentsDialogContent = ({ 
  agents, 
  currentId,
  onSelectAgent 
}: AgentsDialogContentProps) => {
  const dialog = useDialog();

  const handleSelect = useCallback(
    (next: Agent) => {
      onSelectAgent(next.id);
      dialog.close();
    },
    [onSelectAgent, dialog],
  );

  const label = (agent: Agent) => agentLabel(agent, agents);

  return (
    <DialogSearchList
      items={agents}
      onSelect={handleSelect}
      filterFn={(item, query) => label(item).toLowerCase().includes(query.toLowerCase())}
      renderItem={(item, isSelected) => (
        <text selectable={false} fg={isSelected ? "black" : "white"}>
          {`${item.id === currentId ? " • " : "   "}${label(item)}${item.description ? `  ${item.description}` : ""}`}
        </text>
      )}
      getKey={(item) => item.id}
      placeholder="Search agents"
      emptyText="No matching agents"
    />
  );
};
