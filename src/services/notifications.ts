import {
  notificationsEqual,
  type GitHubNotification
} from "../domain/notifications";
import {
  estimateJsonBytes,
  estimateTextBytes,
  type CacheSizeStats
} from "./cacheStats";
import { GitHubRequestError } from "./github";
import { tracePerf } from "./perfTrace";

export interface FetchNotificationsOptions {
  token: string;
  apiBaseUrl: string;
  accountId?: string;
  signal?: AbortSignal;
  all?: boolean;
  participating?: boolean;
  fetchImpl?: typeof fetch;
  onPartialResult?: (notifications: GitHubNotification[]) => void;
  coalesce?: boolean;
}

interface CacheEntry {
  lastModified: string | null;
  etag: string | null;
  notifications: GitHubNotification[];
}

interface UnreadUpdateCacheEntry {
  lastModified: string | null;
  seenUpdatedAtById: Map<string, string>;
}

// The notifications endpoint caps per_page at 50 (unlike most list APIs'
// 100), so pagination must follow the Link header instead of assuming a
// short page means the end.
const MAX_PAGES = 20;
const PER_PAGE = 50;

// Full-list cache for the Notifications pane. Refreshes always read the first
// page unconditionally; if it matches the cached first page, pagination can be
// skipped without trusting a potentially stale 304.
const cache = new Map<string, CacheEntry>();
// Native OS toasts use a separate unread-only conditional probe so their
// low-cost polling cannot affect the full app list.
const unreadUpdateCache = new Map<string, UnreadUpdateCacheEntry>();

// Number of consecutive 304 probe responses tolerated before the next probe is
// skipped and a full unread first page is fetched unconditionally. A broken
// proxy fingerprint can keep returning 304 forever off a stale Last-Modified,
// which would silently suppress toasts; this bounds that failure.
const MAX_CONSECUTIVE_PROBE_NOT_MODIFIED = 5;
// Consecutive-304 counters per unread-probe cache key. Reset in
// clearNotificationCache alongside the caches they guard.
const consecutiveProbeNotModified = new Map<string, number>();

function cacheKey(options: FetchNotificationsOptions): string {
  return [
    options.apiBaseUrl,
    options.accountId ?? "legacy-unscoped",
    options.all !== false ? "all" : "unread",
    options.participating ? "participating" : "any"
  ].join("|");
}

// In-flight coalescing: concurrent fetches for the same feed share one
// request instead of hitting the API twice.
const inflight = new Map<string, Promise<GitHubNotification[]>>();

// The notifications list is a plain Map (not an LruCache), so its byte total
// cannot be tracked incrementally per write. Instead the reduce result is
// memoized behind a dirty flag: every `cache` mutation clears it so the next
// stats read (e.g. a status-bar render) rebuilds it once, and repeated reads
// between mutations return the same object.
let cacheStatsMemo: CacheSizeStats | null = null;

function invalidateCacheStats(): void {
  cacheStatsMemo = null;
}

export function clearNotificationCache() {
  cache.clear();
  invalidateCacheStats();
  unreadUpdateCache.clear();
  inflight.clear();
  consecutiveProbeNotModified.clear();
}

export function getNotificationCacheStats(): CacheSizeStats {
  return (cacheStatsMemo ??= [...cache.entries()].reduce<CacheSizeStats>(
    (stats, [key, entry]) => ({
      entries: stats.entries + entry.notifications.length,
      bytes:
        stats.bytes +
        estimateTextBytes(key) +
        estimateJsonBytes(entry.notifications)
    }),
    { entries: 0, bytes: 0 }
  ));
}

export function fetchNotifications(
  options: FetchNotificationsOptions
): Promise<GitHubNotification[]> {
  if (options.coalesce === false) {
    return doFetchNotifications(options);
  }
  const key = cacheKey(options);
  const running = inflight.get(key);
  if (running) {
    return running;
  }
  const request = doFetchNotifications(options).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, request);
  return request;
}

function firstPageMatchesCached(
  pageItems: GitHubNotification[],
  cached: GitHubNotification[]
): boolean {
  if (cached.length === 0) {
    return pageItems.length === 0;
  }
  if (pageItems.length === 0) {
    return false;
  }
  const cachedFirstPageLength = Math.min(PER_PAGE, cached.length);
  if (pageItems.length !== cachedFirstPageLength) {
    return false;
  }
  return pageItems.every((item, index) =>
    notificationsEqual(item, cached[index])
  );
}

async function doFetchNotifications(
  options: FetchNotificationsOptions
): Promise<GitHubNotification[]> {
  const fetcher = options.fetchImpl ?? fetch;
  const base = options.apiBaseUrl.replace(/\/+$/, "");
  const key = cacheKey(options);
  const cached = cache.get(key);

  const params = new URLSearchParams();
  params.set("all", options.all === false ? "false" : "true");
  if (options.participating) {
    params.set("participating", "true");
  }

  const baseHeaders: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${options.token}`,
    "X-GitHub-Api-Version": "2022-11-28"
  };

  params.set("per_page", String(PER_PAGE));

  const notifications: GitHubNotification[] = [];
  let lastModified: string | null = null;
  let etag: string | null = null;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    params.set("page", String(page));

    const pageStartedAt = performance.now();
    tracePerf("notifications_page_start", { page });
    const response = await fetcher(`${base}/notifications?${params.toString()}`, {
      // The app maintains its own snapshot/localStorage cache, so an
      // additional WebView HTTP cache adds no benefit and risks a stale proxy
      // 304 being surfaced as a fresh 200 body. Bypass it entirely.
      cache: "no-store",
      headers: baseHeaders,
      signal: options.signal
    });

    if (!response.ok) {
      tracePerf("notifications_page_error", {
        page,
        status: response.status,
        durationMs: performance.now() - pageStartedAt
      });
      throw new GitHubRequestError(response.status, "");
    }

    if (page === 1) {
      lastModified = response.headers.get("Last-Modified");
      etag = response.headers.get("ETag");
    }

    const pageItems = (await response.json()) as GitHubNotification[];
    tracePerf("notifications_page_done", {
      page,
      items: pageItems.length,
      durationMs: performance.now() - pageStartedAt,
      // Surfacing the first-page validators lets a perf trace compare the
      // "last 304 fingerprint" against the current one when diagnosing
      // stale-proxy staleness.
      ...(page === 1 ? { lastModified, etag } : {})
    });
    const link = response.headers.get("Link");
    const hasNext = link
      ? link.includes('rel="next"')
      : pageItems.length === PER_PAGE;
    notifications.push(...pageItems);
    options.onPartialResult?.([...notifications]);
    if (
      page === 1 &&
      cached &&
      cached.notifications.length === pageItems.length &&
      !hasNext &&
      firstPageMatchesCached(pageItems, cached.notifications)
    ) {
      options.onPartialResult?.(cached.notifications);
      cache.set(key, {
        lastModified: lastModified ?? cached.lastModified,
        etag: etag ?? cached.etag,
        notifications: cached.notifications
      });
      invalidateCacheStats();
      return cached.notifications;
    }

    if (!hasNext) {
      break;
    }
  }

  cache.set(key, { lastModified, etag, notifications });
  invalidateCacheStats();
  return notifications;
}

function seenMapFor(notifications: GitHubNotification[]): Map<string, string> {
  return new Map(
    notifications.map((notification) => [
      notification.id,
      notification.updated_at
    ])
  );
}

function isNewOrUpdated(
  notification: GitHubNotification,
  seenUpdatedAtById: Map<string, string>
): boolean {
  const seenUpdatedAt = seenUpdatedAtById.get(notification.id);
  if (!seenUpdatedAt) {
    return true;
  }
  return Date.parse(notification.updated_at) > Date.parse(seenUpdatedAt);
}

function unreadUpdatesCacheKey(options: FetchNotificationsOptions): string {
  return [
    cacheKey({ ...options, all: false }),
    options.token
  ].join("|");
}

async function fetchUnreadFirstPage(
  options: FetchNotificationsOptions,
  headers: Record<string, string>
): Promise<Response> {
  const fetcher = options.fetchImpl ?? fetch;
  const base = options.apiBaseUrl.replace(/\/+$/, "");
  const params = new URLSearchParams();
  params.set("all", "false");
  if (options.participating) {
    params.set("participating", "true");
  }
  params.set("per_page", String(PER_PAGE));
  params.set("page", "1");
  return fetcher(`${base}/notifications?${params.toString()}`, {
    cache: "no-store",
    headers,
    signal: options.signal
  });
}

export async function fetchUnreadNotificationUpdates(
  options: FetchNotificationsOptions
): Promise<GitHubNotification[]> {
  const fetcher = options.fetchImpl ?? fetch;
  const base = options.apiBaseUrl.replace(/\/+$/, "");
  const key = unreadUpdatesCacheKey(options);
  const cached = unreadUpdateCache.get(key);
  const baseHeaders: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${options.token}`,
    "X-GitHub-Api-Version": "2022-11-28"
  };

  const skipProbe =
    (consecutiveProbeNotModified.get(key) ?? 0) >=
    MAX_CONSECUTIVE_PROBE_NOT_MODIFIED;
  if (skipProbe) {
    // A broken proxy fingerprint can keep answering 304 off a stale
    // Last-Modified indefinitely, which would suppress toasts forever. After
    // enough consecutive 304s, drop the conditional probe and force a full
    // unread first page so we resynchronize.
    tracePerf("notifications_unread_probe_skipped", {
      consecutiveNotModified: consecutiveProbeNotModified.get(key) ?? 0
    });
    consecutiveProbeNotModified.set(key, 0);
  }

  if (cached?.lastModified && !skipProbe) {
    const params = new URLSearchParams();
    params.set("all", "false");
    if (options.participating) {
      params.set("participating", "true");
    }
    params.set("per_page", "1");
    params.set("page", "1");
    const probeStartedAt = performance.now();
    tracePerf("notifications_unread_probe_start", {});
    const probe = await fetcher(`${base}/notifications?${params.toString()}`, {
      cache: "no-store",
      headers: {
        ...baseHeaders,
        "If-Modified-Since": cached.lastModified
      },
      signal: options.signal
    });
    tracePerf("notifications_unread_probe_done", {
      status: probe.status,
      durationMs: performance.now() - probeStartedAt
    });
    if (probe.status === 304) {
      consecutiveProbeNotModified.set(
        key,
        (consecutiveProbeNotModified.get(key) ?? 0) + 1
      );
      return [];
    }
    if (!probe.ok) {
      throw new GitHubRequestError(probe.status, "");
    }
    consecutiveProbeNotModified.set(key, 0);
  }

  const pageStartedAt = performance.now();
  tracePerf("notifications_unread_page_start", {});
  const response = await fetchUnreadFirstPage(options, baseHeaders);
  tracePerf("notifications_unread_page_done", {
    status: response.status,
    durationMs: performance.now() - pageStartedAt
  });
  if (!response.ok) {
    throw new GitHubRequestError(response.status, "");
  }

  const pageItems = (await response.json()) as GitHubNotification[];
  const fresh = cached
    ? pageItems.filter((notification) =>
        isNewOrUpdated(notification, cached.seenUpdatedAtById)
      )
    : [];
  unreadUpdateCache.set(key, {
    lastModified: response.headers.get("Last-Modified") ?? cached?.lastModified ?? null,
    seenUpdatedAtById: seenMapFor(pageItems)
  });
  return fresh;
}

export async function markNotificationRead(options: {
  token: string;
  apiBaseUrl: string;
  accountId?: string;
  threadId: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetcher = options.fetchImpl ?? fetch;
  const base = options.apiBaseUrl.replace(/\/+$/, "");
  const response = await fetcher(
    `${base}/notifications/threads/${encodeURIComponent(options.threadId)}`,
    {
      method: "PATCH",
      cache: "no-store",
      signal: options.signal,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "X-GitHub-Api-Version": "2022-11-28"
      }
    }
  );

  if (!response.ok && response.status !== 205) {
    throw new GitHubRequestError(response.status, "");
  }
}
