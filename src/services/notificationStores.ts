import type { GitHubNotification } from "../domain/notifications";
import type { NotificationDetailContent } from "./notificationDetail";

const viewedStorageKey = "yonalist.notifications.viewedAt.v1";
const hiddenStorageKey = "yonalist.notifications.hidden.v1";
const notificationCacheStorageKey = "yonalist.notifications.cache.v1";
const detailStorageKey = "yonalist.notifications.details.v1";

/** How many notification detail conversations we keep on disk per host. */
const MAX_PERSISTED_DETAILS = 30;

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

interface PersistedDetailEntry {
  /** Identifies the conversation independent of its version. */
  subject: string;
  /** The notification's updated_at at capture time; a bump invalidates it. */
  updatedAt: string;
  detail: NotificationDetailContent;
}

type PersistedDetailStore = Record<string, PersistedDetailEntry[]>;

/** Version-independent key for a notification's conversation. */
function detailSubjectKey(notification: GitHubNotification): string {
  return notification.subject.url ?? `${notification.repository.full_name}#${notification.id}`;
}

/**
 * Returns the persisted conversation for a notification when the stored entry
 * matches its current version (updated_at). A newer version misses so the
 * caller refetches; the version-independent latest entry is exposed separately.
 */
export function loadPersistedNotificationDetail(
  apiBaseUrl: string,
  notification: GitHubNotification
): NotificationDetailContent | null {
  const entry = readPersistedDetailEntry(apiBaseUrl, notification);
  return entry && entry.updatedAt === notification.updated_at
    ? entry.detail
    : null;
}

/**
 * Returns the persisted conversation for a notification's subject regardless of
 * which version it was captured under, so an older conversation can be shown
 * while a newer one loads (stale-while-revalidate across app restarts).
 */
export function loadLatestPersistedNotificationDetail(
  apiBaseUrl: string,
  notification: GitHubNotification
): NotificationDetailContent | null {
  return readPersistedDetailEntry(apiBaseUrl, notification)?.detail ?? null;
}

function readPersistedDetailEntry(
  apiBaseUrl: string,
  notification: GitHubNotification
): PersistedDetailEntry | null {
  const host = readJson<PersistedDetailStore>(detailStorageKey, {})[
    hostKey(apiBaseUrl)
  ];
  const subject = detailSubjectKey(notification);
  return host?.find((entry) => entry.subject === subject) ?? null;
}

/**
 * Saves a notification's conversation to localStorage, keyed by host + subject
 * + version. Re-saving the same subject replaces its entry in place and moves
 * it to the most-recent slot; the newest {@link MAX_PERSISTED_DETAILS} per host
 * are kept and older ones evicted. Storage failures are swallowed.
 */
export function persistNotificationDetail(
  apiBaseUrl: string,
  notification: GitHubNotification,
  detail: NotificationDetailContent
) {
  const store = readJson<PersistedDetailStore>(detailStorageKey, {});
  const key = hostKey(apiBaseUrl);
  const subject = detailSubjectKey(notification);
  const others = (store[key] ?? []).filter((entry) => entry.subject !== subject);
  const next = [
    ...others,
    { subject, updatedAt: notification.updated_at, detail }
  ].slice(-MAX_PERSISTED_DETAILS);
  writeJson(detailStorageKey, { ...store, [key]: next });
}

/** Removes every persisted conversation across all hosts. */
export function clearPersistedNotificationDetails() {
  try {
    window.localStorage.removeItem(detailStorageKey);
  } catch {
    // Nothing more to do if storage is unavailable.
  }
}
