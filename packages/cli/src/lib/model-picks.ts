/** How many recently used models are kept per engine. */
export const MAX_RECENT_MODELS = 5;

/** `favorites` with `model` added at the end, or removed when it is already there. */
export function toggleFavorite(favorites: readonly string[], model: string): string[] {
  return favorites.includes(model) ? favorites.filter((favorite) => favorite !== model) : [...favorites, model];
}

/** `recents` (newest first) with `model` put first, once, keeping the last {@link MAX_RECENT_MODELS}. */
export function pushRecent(recents: readonly string[], model: string, max = MAX_RECENT_MODELS): string[] {
  return [model, ...recents.filter((recent) => recent !== model)].slice(0, max);
}

/** The recent model F2 switches to: the one after `current` (the first when `current` is not in the list), wrapping; none when it would be `current` again. */
export function nextRecent(recents: readonly string[], current: string): string | undefined {
  if (recents.length === 0) return undefined;
  const next = recents[(recents.indexOf(current) + 1) % recents.length];
  return next === current ? undefined : next;
}

export type ModelSection = "favorite" | "recent" | "other";

/** The model list as the dialogs show it: favorites, then recents, then the rest, each model once. A favorite or recent that is not in `items` is left out. */
export function orderModels<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  favorites: readonly string[],
  recents: readonly string[],
): { item: T; section: ModelSection }[] {
  const byKey = new Map(items.map((item) => [keyOf(item), item]));
  const listed = new Set<string>();
  const take = (keys: readonly string[], section: ModelSection) =>
    keys.flatMap((key) => {
      const item = byKey.get(key);
      if (item === undefined || listed.has(key)) return [];
      listed.add(key);
      return [{ item, section }];
    });
  const favorite = take(favorites, "favorite");
  const recent = take(recents, "recent");
  const other = items.filter((item) => !listed.has(keyOf(item))).map((item) => ({ item, section: "other" as const }));
  return [...favorite, ...recent, ...other];
}
