import type { GitHubNotification } from "../domain/notifications";

const viewedStorageKey = "yonalist.notifications.viewedAt.v1";
const hiddenStorageKey = "yonalist.notifications.hidden.v1";
const notificationCacheStorageKey = "yonalist.notifications.cache.v1";

export type ViewedAtMap = Record<string, string>;

interface NotificationCacheEntry {
  notifications: GitHubNotification[];
  cachedAt: string;
}

type NotificationCache = Record<string, NotificationCacheEntry>;

function hostKey(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/+$/g, "");
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const stored = window.localStorage.getItem(key);
    if (!stored) {
      return fallback;
    }
    const parsed = JSON.parse(stored) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The app still works with an in-memory result.
  }
}

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

export function loadCachedNotifications(
  apiBaseUrl: string
): GitHubNotification[] | null {
  return (
    readJson<NotificationCache>(notificationCacheStorageKey, {})[
      hostKey(apiBaseUrl)
    ]?.notifications ?? null
  );
}

export function persistCachedNotifications(
  apiBaseUrl: string,
  notifications: GitHubNotification[]
) {
  const cache = readJson<NotificationCache>(notificationCacheStorageKey, {});
  writeJson(notificationCacheStorageKey, {
    ...cache,
    [hostKey(apiBaseUrl)]: {
      notifications,
      cachedAt: new Date().toISOString()
    }
  });
}
