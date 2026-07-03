import type { GitHubNotification } from "../domain/notifications";
import { GitHubRequestError } from "./github";

export interface FetchNotificationsOptions {
  token: string;
  apiBaseUrl: string;
  all?: boolean;
  participating?: boolean;
  fetchImpl?: typeof fetch;
}

interface CacheEntry {
  lastModified: string | null;
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

export function clearNotificationCache() {
  cache.clear();
}

export async function fetchNotifications(
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
  params.set("per_page", String(PER_PAGE));

  const notifications: GitHubNotification[] = [];
  let lastModified: string | null = null;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    params.set("page", String(page));
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${options.token}`,
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (page === 1 && cached?.lastModified) {
      headers["If-Modified-Since"] = cached.lastModified;
    }

    const response = await fetcher(`${base}/notifications?${params.toString()}`, {
      headers
    });

    if (page === 1 && response.status === 304 && cached) {
      return cached.notifications;
    }
    if (!response.ok) {
      throw new GitHubRequestError(response.status, "");
    }

    if (page === 1) {
      lastModified = response.headers.get("Last-Modified");
    }

    const pageItems = (await response.json()) as GitHubNotification[];
    notifications.push(...pageItems);

    const link = response.headers.get("Link");
    const hasNext = link
      ? link.includes('rel="next"')
      : pageItems.length === PER_PAGE;
    if (!hasNext) {
      break;
    }
  }

  cache.set(key, { lastModified, notifications });
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
