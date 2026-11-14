import { useCallback } from "react";
import { TextAttributes } from "@opentui/core";
import { useDialog } from "../../providers/dialog";
import { useToast } from "../../providers/toast";
import { DialogSearchList } from "../dialog-search-list";
import { FavoriteMark, RecentMark, useModelPicks, type ModelRow } from "./models-dialog";
import { recordRecentModel } from "../../lib/preferences";
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
  const picks = useModelPicks("pi", models, (model) => model.ref);

  const handleSelect = useCallback(
    ({ item: model }: ModelRow<PiModelOption>) => {
      onSelectModel(model.ref);
      recordRecentModel("pi", model.ref);
      toast.show({ variant: "success", message: `pi will use ${model.ref}` });
      dialog.close();
    },
    [dialog, toast, onSelectModel],
  );

  return (
    <DialogSearchList
      items={picks.rows}
      onSelect={handleSelect}
      filterFn={({ item: model }, query) => `${model.ref} ${model.name}`.toLowerCase().includes(query.toLowerCase())}
      renderItem={(row, isSelected) => {
        const model = row.item;
        picks.track(row, isSelected);
        return (
          <box flexDirection="row" gap={1} overflow="hidden">
            <box flexDirection="row">
              <FavoriteMark favorite={picks.isFavorite(model)} selected={isSelected} />
              <text selectable={false} fg={isSelected ? "black" : "white"}>
                {model.ref === currentModel ? " • " : "   "}
                {model.ref}
              </text>
            </box>
            <text selectable={false} fg={isSelected ? "black" : "gray"} attributes={TextAttributes.DIM}>
              {model.name}
            </text>
            <RecentMark section={row.section} selected={isSelected} />
          </box>
        );
      }}
      getKey={({ item: model }) => model.ref}
      placeholder="Search models"
      emptyText="No matching models"
    />
  );
};
