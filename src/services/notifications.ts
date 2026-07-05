import type { GitHubNotification } from "../domain/notifications";
import { GitHubRequestError } from "./github";
import { tracePerf } from "./perfTrace";

export interface FetchNotificationsOptions {
  token: string;
  apiBaseUrl: string;
  all?: boolean;
  participating?: boolean;
  fetchImpl?: typeof fetch;
  onPartialResult?: (notifications: GitHubNotification[]) => void;
}

interface CacheEntry {
  lastModified: string | null;
  etag: string | null;
  notifications: GitHubNotification[];
}

// The notifications endpoint caps per_page at 50 (unlike most list APIs'
// 100), so pagination must follow the Link header instead of assuming a
// short page means the end.
const MAX_PAGES = 20;
const PER_PAGE = 50;

// Conditional-request cache so a 304 skips re-downloading every page.
const cache = new Map<string, CacheEntry>();

function cacheKey(options: FetchNotificationsOptions): string {
  return [
    options.apiBaseUrl,
    options.all !== false ? "all" : "unread",
    options.participating ? "participating" : "any"
  ].join("|");
}

// In-flight coalescing: concurrent fetches for the same feed share one
// request instead of hitting the API twice.
const inflight = new Map<string, Promise<GitHubNotification[]>>();

export function clearNotificationCache() {
  cache.clear();
  inflight.clear();
}

export function fetchNotifications(
  options: FetchNotificationsOptions
): Promise<GitHubNotification[]> {
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

  // Conditional requests on this endpoint return only the notifications
  // updated since the given time — replacing the list with that delta would
  // wipe everything older. So the conditional check (If-Modified-Since and/or
  // If-None-Match — some GHE setups only send ETags) runs as a cheap one-item
  // probe, and any change triggers an unconditional full refetch.
  if (cached && (cached.lastModified || cached.etag)) {
    params.set("per_page", "1");
    params.set("page", "1");
    const conditionalHeaders: Record<string, string> = { ...baseHeaders };
    if (cached.lastModified) {
      conditionalHeaders["If-Modified-Since"] = cached.lastModified;
    }
    if (cached.etag) {
      conditionalHeaders["If-None-Match"] = cached.etag;
    }
    const probeStartedAt = performance.now();
    tracePerf("notifications_probe_start", {});
    const probe = await fetcher(`${base}/notifications?${params.toString()}`, {
      headers: conditionalHeaders
    });
    tracePerf("notifications_probe_done", {
      status: probe.status,
      durationMs: performance.now() - probeStartedAt
    });
    if (probe.status === 304) {
      options.onPartialResult?.(cached.notifications);
      return cached.notifications;
    }
    if (!probe.ok) {
      throw new GitHubRequestError(probe.status, "");
    }
  }

  params.set("per_page", String(PER_PAGE));

  const notifications: GitHubNotification[] = [];
  let lastModified: string | null = null;
  let etag: string | null = null;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    params.set("page", String(page));

    const pageStartedAt = performance.now();
    tracePerf("notifications_page_start", { page });
    const response = await fetcher(`${base}/notifications?${params.toString()}`, {
      headers: baseHeaders
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
      durationMs: performance.now() - pageStartedAt
    });
    notifications.push(...pageItems);
    options.onPartialResult?.([...notifications]);

    const link = response.headers.get("Link");
    const hasNext = link
      ? link.includes('rel="next"')
      : pageItems.length === PER_PAGE;
    if (!hasNext) {
      break;
    }
  }

  cache.set(key, { lastModified, etag, notifications });
  return notifications;
}

export async function markNotificationRead(options: {
  token: string;
  apiBaseUrl: string;
  threadId: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetcher = options.fetchImpl ?? fetch;
  const base = options.apiBaseUrl.replace(/\/+$/, "");
  const response = await fetcher(
    `${base}/notifications/threads/${encodeURIComponent(options.threadId)}`,
    {
      method: "PATCH",
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
