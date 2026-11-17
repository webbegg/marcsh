import { useCallback } from "react";
import { useDialog } from "../../providers/dialog";
import { useToast } from "../../providers/toast";
import { DialogSearchList } from "../dialog-search-list";
import { fitText } from "../../lib/fit-text";
import { ENGINE_IDS, ENGINE_LABELS, type EngineId } from "../../lib/engine";

type EngineDialogContentProps = {
  currentEngine: EngineId;
  onSelectEngine: (engine: EngineId) => void;
};

export const EngineDialogContent = ({
  currentEngine,
  onSelectEngine,
}: EngineDialogContentProps) => {
  const dialog = useDialog();
  const toast = useToast();

  const handleSelect = useCallback(
    (engine: EngineId) => {
      onSelectEngine(engine);
      toast.show({ variant: "success", message: `New sessions will use ${ENGINE_LABELS[engine]}` });
      dialog.close();
    },
    [dialog, toast, onSelectEngine],
  );

  return (
    <DialogSearchList
      items={[...ENGINE_IDS]}
      onSelect={handleSelect}
      filterFn={(engine, query) =>
        `${engine} ${ENGINE_LABELS[engine]}`.toLowerCase().includes(query.toLowerCase())
      }
      renderItem={(engine, isSelected, width) => (
        <text selectable={false} fg={isSelected ? "black" : "white"}>
          {engine === currentEngine ? " • " : "   "}
          {fitText(ENGINE_LABELS[engine], width - 3)}
        </text>
      )}
      getKey={(engine) => engine}
      placeholder="Search engines"
      emptyText="No matching engines"
    />
  );
};
