import { useCallback, useRef, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useDialog } from "../../providers/dialog";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { DialogSearchList } from "../dialog-search-list";
import type { SupportedChatModelId } from "../../lib/models";
import type { EngineId } from "../../lib/engine";
import { orderModels, toggleFavorite, type ModelSection } from "../../lib/model-picks";
import { getFavoriteModels, getRecentModels, recordRecentModel, setFavoriteModels } from "../../lib/preferences";

export type ModelRow<T> = { item: T; section: ModelSection };

/**
 * What a model dialog adds to its list: favorites first, then recent models, then the rest (each model once, in the order they had when the
 * dialog opened, so marking a favorite never moves the row under the cursor), and Ctrl+F on the highlighted row toggling its favorite.
 */
export function useModelPicks<T>(engine: EngineId, items: readonly T[], keyOf: (item: T) => string) {
  const { isTopLayer } = useKeyboardLayer();
  const [favorites, setFavorites] = useState(() => getFavoriteModels(engine));
  const favoritesRef = useRef(favorites);
  const [rows] = useState(() => orderModels(items, keyOf, favorites, getRecentModels(engine)));
  const highlighted = useRef<T | undefined>(undefined);

  useKeyboard((key) => {
    if (!isTopLayer("dialog") || !key.ctrl || key.name !== "f") return;
    key.preventDefault();
    const item = highlighted.current;
    if (item === undefined) return;
    favoritesRef.current = toggleFavorite(favoritesRef.current, keyOf(item));
    setFavorites(favoritesRef.current);
    setFavoriteModels(engine, favoritesRef.current);
  });

  return {
    rows,
    /** Call from the row renderer: the row the list highlights is the one Ctrl+F acts on. */
    track: (row: ModelRow<T>, isSelected: boolean) => {
      if (isSelected) highlighted.current = row.item;
    },
    isFavorite: (item: T) => favorites.includes(keyOf(item)),
  };
}

/** The marks a row carries in place of section headings (the list has none): ★ before a favorite, "recent" after a recent model. */
export const FavoriteMark = ({ favorite, selected }: { favorite: boolean; selected: boolean }) => (
  <text selectable={false} fg={selected ? "black" : "yellow"}>{favorite ? "★ " : "  "}</text>
);

export const RecentMark = ({ section, selected }: { section: ModelSection; selected: boolean }) =>
  section === "recent" ? (
    <text selectable={false} fg={selected ? "black" : "gray"} attributes={TextAttributes.DIM}>{"recent"}</text>
  ) : null;

type ModelsDialogContentProps = {
  models: SupportedChatModelId[];
  onSelectModel: (modelId: SupportedChatModelId) => void;
};

export const ModelsDialogContent = ({ 
  models, 
  onSelectModel 
}: ModelsDialogContentProps) => {
  const dialog = useDialog();
  const picks = useModelPicks("claude", models, (modelId) => modelId);

  const handleSelect = useCallback(
    ({ item: modelId }: ModelRow<SupportedChatModelId>) => {
      onSelectModel(modelId);
      recordRecentModel("claude", modelId);
      dialog.close();
    },
    [dialog, onSelectModel],
  );

  return (
    <DialogSearchList
      items={picks.rows}
      onSelect={handleSelect}
      filterFn={({ item: modelId }, query) => modelId.toLowerCase().includes(query.toLowerCase())}
      renderItem={(row, isSelected) => {
        picks.track(row, isSelected);
        return (
          <box flexDirection="row" gap={1} overflow="hidden">
            <box flexDirection="row">
              <FavoriteMark favorite={picks.isFavorite(row.item)} selected={isSelected} />
              <text selectable={false} fg={isSelected ? "black" : "white"}>
                {row.item}
              </text>
            </box>
            <RecentMark section={row.section} selected={isSelected} />
          </box>
        );
      }}
      getKey={({ item: modelId }) => modelId}
      placeholder="Search models"
      emptyText="No matching models"
    />
  );
};
