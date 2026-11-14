import { describe, expect, test } from "bun:test";
import { MAX_RECENT_MODELS, nextRecent, orderModels, pushRecent, toggleFavorite } from "./model-picks";

describe("toggleFavorite", () => {
  test("adds a model that is not a favorite, after the others", () => {
    expect(toggleFavorite(["a"], "b")).toEqual(["a", "b"]);
  });

  test("removes a model that is a favorite", () => {
    expect(toggleFavorite(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  test("does not change the list it is given", () => {
    const favorites = ["a"];
    toggleFavorite(favorites, "b");
    expect(favorites).toEqual(["a"]);
  });
});

describe("pushRecent", () => {
  test("puts the model first", () => {
    expect(pushRecent(["a", "b"], "c")).toEqual(["c", "a", "b"]);
  });

  test("moves a model already there to the front without repeating it", () => {
    expect(pushRecent(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
  });

  test("keeps the last 5, newest first", () => {
    let recents: string[] = [];
    for (const model of ["a", "b", "c", "d", "e", "f", "g"]) recents = pushRecent(recents, model);
    expect(MAX_RECENT_MODELS).toBe(5);
    expect(recents).toEqual(["g", "f", "e", "d", "c"]);
  });
});

describe("nextRecent", () => {
  test("is the recent model after the current one, wrapping around", () => {
    expect(nextRecent(["a", "b", "c"], "a")).toBe("b");
    expect(nextRecent(["a", "b", "c"], "c")).toBe("a");
  });

  test("is the first recent model when the current one is not in the list", () => {
    expect(nextRecent(["a", "b"], "z")).toBe("a");
  });

  test("is nothing when there is no other recent model", () => {
    expect(nextRecent([], "a")).toBeUndefined();
    expect(nextRecent(["a"], "a")).toBeUndefined();
  });
});

describe("orderModels", () => {
  const key = (model: string) => model;

  test("lists favorites, then recents, then the rest, without repeating a model", () => {
    const ordered = orderModels(["a", "b", "c", "d", "e"], key, ["d", "b"], ["c", "d", "a"]);
    expect(ordered).toEqual([
      { item: "d", section: "favorite" },
      { item: "b", section: "favorite" },
      { item: "c", section: "recent" },
      { item: "a", section: "recent" },
      { item: "e", section: "other" },
    ]);
  });

  test("skips favorites and recents that are not available", () => {
    expect(orderModels(["a", "b"], key, ["gone"], ["gone", "b"]).map((entry) => entry.item)).toEqual(["b", "a"]);
  });

  test("keeps the order of the rest", () => {
    expect(orderModels(["x", "y", "z"], key, [], []).map((entry) => entry.item)).toEqual(["x", "y", "z"]);
  });
});
