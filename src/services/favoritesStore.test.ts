import { beforeEach, describe, expect, it } from "vitest";
import { loadFavorites, persistFavorites } from "./favoritesStore";

const favoritesStorageKey = "yonalist.favorites.v1";

describe("favorites store", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to an empty map when nothing is stored", () => {
    expect(loadFavorites()).toEqual({});
  });

  it("round-trips the favorites map", () => {
    persistFavorites({ "/vault/a.md": true, "/vault/b.md": false });

    expect(loadFavorites()).toEqual({
      "/vault/a.md": true,
      "/vault/b.md": false
    });
    expect(window.localStorage.getItem(favoritesStorageKey)).toBe(
      JSON.stringify({ "/vault/a.md": true, "/vault/b.md": false })
    );
  });

  it("overwrites the previous map on persist", () => {
    persistFavorites({ "/vault/a.md": true });
    persistFavorites({ "/vault/b.md": true });

    expect(loadFavorites()).toEqual({ "/vault/b.md": true });
  });

  it("falls back to an empty map on corrupt storage", () => {
    window.localStorage.setItem(favoritesStorageKey, "{broken json");
    expect(loadFavorites()).toEqual({});
  });
});
