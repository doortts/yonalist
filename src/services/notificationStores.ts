const viewedStorageKey = "yonalist.notifications.viewedAt.v1";
const hiddenStorageKey = "yonalist.notifications.hidden.v1";

export type ViewedAtMap = Record<string, string>;

export function loadViewedAt(): ViewedAtMap {
  try {
    const stored = window.localStorage.getItem(viewedStorageKey);
    return stored ? (JSON.parse(stored) as ViewedAtMap) : {};
  } catch {
    return {};
  }
}

/** Records when a notification target URL was opened; never moves time backwards. */
export function markViewed(url: string, at: Date = new Date()): ViewedAtMap {
  const map = loadViewedAt();
  const existing = map[url];
  if (!existing || new Date(existing).valueOf() < at.valueOf()) {
    map[url] = at.toISOString();
    try {
      window.localStorage.setItem(viewedStorageKey, JSON.stringify(map));
    } catch {
      // Viewing still works without persistence.
    }
  }
  return map;
}

export function loadHiddenIds(): Set<string> {
  try {
    const stored = window.localStorage.getItem(hiddenStorageKey);
    return stored ? new Set(JSON.parse(stored) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

export function persistHiddenIds(ids: Set<string>) {
  try {
    window.localStorage.setItem(hiddenStorageKey, JSON.stringify([...ids]));
  } catch {
    // Hiding still works for the session without persistence.
  }
}
