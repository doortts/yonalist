const favoritesStorageKey = "yonalist.favorites.v1";

export type FavoritesMap = Record<string, boolean>;

export function loadFavorites(): FavoritesMap {
  try {
    const stored = window.localStorage.getItem(favoritesStorageKey);
    return stored ? (JSON.parse(stored) as FavoritesMap) : {};
  } catch {
    return {};
  }
}

export function persistFavorites(favorites: FavoritesMap) {
  try {
    window.localStorage.setItem(favoritesStorageKey, JSON.stringify(favorites));
  } catch {
    // Favorites still work for the session without persistence.
  }
}
