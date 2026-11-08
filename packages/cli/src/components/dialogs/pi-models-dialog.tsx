import { useCallback } from "react";
import { TextAttributes } from "@opentui/core";
import { useDialog } from "../../providers/dialog";
import { useToast } from "../../providers/toast";
import { DialogSearchList } from "../dialog-search-list";
import type { PiModelOption } from "../../lib/engine/pi-models";

type Props = {
  models: PiModelOption[];
  /** The "provider/id" ref in use. */
  currentModel: string;
  onSelectModel: (ref: string) => void;
};

export const PiModelsDialogContent = ({ models, currentModel, onSelectModel }: Props) => {
  const dialog = useDialog();
  const toast = useToast();

  const handleSelect = useCallback(
    (model: PiModelOption) => {
      onSelectModel(model.ref);
      toast.show({ variant: "success", message: `pi will use ${model.ref}` });
      dialog.close();
    },
    [dialog, toast, onSelectModel],
  );

  return (
    <DialogSearchList
      items={models}
      onSelect={handleSelect}
      filterFn={(model, query) => `${model.ref} ${model.name}`.toLowerCase().includes(query.toLowerCase())}
      renderItem={(model, isSelected) => (
        <box flexDirection="row" gap={1} overflow="hidden">
          <text selectable={false} fg={isSelected ? "black" : "white"}>
            {model.ref === currentModel ? " • " : "   "}
            {model.ref}
          </text>
          <text selectable={false} fg={isSelected ? "black" : "gray"} attributes={TextAttributes.DIM}>
            {model.name}
          </text>
        </box>
      )}
      getKey={(model) => model.ref}
      placeholder="Search models"
      emptyText="No matching models"
    />
  );
};
