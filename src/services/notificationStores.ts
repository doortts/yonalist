import type { GitHubNotification } from "../domain/notifications";
import { scheduleIdleTask } from "./idleQueue";
import type { NotificationDetailContent } from "./notificationDetail";

const viewedStorageKey = "yonalist.notifications.viewedAt.v1";
const hiddenStorageKey = "yonalist.notifications.hidden.v1";
const detailStorageKey = "yonalist.notifications.details.v1";

/** How many notification detail conversations we keep on disk per host. */
const MAX_PERSISTED_DETAILS = 30;

export type ViewedAtMap = Record<string, string>;

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

/** Records the first time a notification target URL was opened. */
export function markViewed(url: string, at: Date = new Date()): ViewedAtMap {
  const map = loadViewedAt();
  const existing = map[url];
  if (!existing) {
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

interface PersistedDetailEntry {
  /** Identifies the conversation independent of its version. */
  subject: string;
  /** The notification's updated_at at capture time; a bump invalidates it. */
  updatedAt: string;
  detail: NotificationDetailContent;
}

type PersistedDetailStore = Record<string, PersistedDetailEntry[]>;

/**
 * In-memory copy of the persisted detail store, used as the read/write source
 * of truth. Parsing this blob (up to {@link MAX_PERSISTED_DETAILS} large
 * conversations per host) on every prefetch peek/completion is a P1 main-thread
 * cost, so we parse localStorage once and then serve reads from memory and
 * coalesce writes onto the idle queue. null means "not yet parsed this session".
 */
let detailStoreCache: PersistedDetailStore | null = null;
/** Cancels the pending idle flush; null when no flush is scheduled. */
let cancelScheduledDetailFlush: (() => void) | null = null;

/**
 * Returns the memoized detail store, parsing localStorage on first use. Callers
 * mutate the returned object in place and schedule a flush; the memo stays the
 * source of truth so external localStorage mutation is invisible until a reset.
 */
function persistedDetailStore(): PersistedDetailStore {
  detailStoreCache ??= readJson<PersistedDetailStore>(detailStorageKey, {});
  return detailStoreCache;
}

/**
 * Schedules a single coalesced flush of the memoized store to localStorage at
 * idle time. A 12-wide prefetch burst thus produces one stringify+setItem
 * instead of one per completion. Tradeoff: quitting inside the idle window
 * (<=1.5s) loses only freshly cached conversations, which merely refetch later.
 */
function scheduleDetailStoreFlush(): void {
  if (cancelScheduledDetailFlush) {
    // A flush is already pending; folding this write into it keeps the burst
    // down to a single physical write (single-handle guard).
    return;
  }
  cancelScheduledDetailFlush = scheduleIdleTask(() => {
    cancelScheduledDetailFlush = null;
    if (detailStoreCache) {
      writeJson(detailStorageKey, detailStoreCache);
    }
  });
}

/**
 * Flushes any pending idle write to localStorage immediately and cancels the
 * scheduled idle task so it cannot fire a redundant second write. Exposed for
 * tests and for the app-restart seam that must persist before dropping memory.
 */
export function flushPersistedNotificationDetailWrites(): void {
  if (!cancelScheduledDetailFlush) {
    return;
  }
  cancelScheduledDetailFlush();
  cancelScheduledDetailFlush = null;
  if (detailStoreCache) {
    writeJson(detailStorageKey, detailStoreCache);
  }
}

/**
 * Drops the memoized store and cancels any pending idle write WITHOUT flushing.
 * Test seam mirroring resetNotificationDetailMemoryCache so a restart genuinely
 * reparses localStorage; also prevents a stale memo leaking across tests.
 */
export function resetPersistedNotificationDetailMemory(): void {
  cancelScheduledDetailFlush?.();
  cancelScheduledDetailFlush = null;
  detailStoreCache = null;
}

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
  const host = persistedDetailStore()[hostKey(apiBaseUrl)];
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
  const store = persistedDetailStore();
  const key = hostKey(apiBaseUrl);
  const subject = detailSubjectKey(notification);
  const others = (store[key] ?? []).filter((entry) => entry.subject !== subject);
  store[key] = [
    ...others,
    { subject, updatedAt: notification.updated_at, detail }
  ].slice(-MAX_PERSISTED_DETAILS);
  scheduleDetailStoreFlush();
}

export function deletePersistedNotificationDetail(
  apiBaseUrl: string,
  notification: GitHubNotification
) {
  const store = persistedDetailStore();
  const key = hostKey(apiBaseUrl);
  const subject = detailSubjectKey(notification);
  store[key] = (store[key] ?? []).filter((entry) => entry.subject !== subject);
  scheduleDetailStoreFlush();
}

/** Removes every persisted conversation across all hosts. */
export function clearPersistedNotificationDetails() {
  // Order matters: cancel the pending flush and drop the memo BEFORE removing
  // the item, otherwise a flush firing after removeItem would resurrect the
  // just-deleted data from the in-memory copy.
  cancelScheduledDetailFlush?.();
  cancelScheduledDetailFlush = null;
  detailStoreCache = null;
  try {
    window.localStorage.removeItem(detailStorageKey);
  } catch {
    // Nothing more to do if storage is unavailable.
  }
}
