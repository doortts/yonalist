import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubNotification } from "../domain/notifications";
import {
  clearNotificationDetailCache,
  deleteCachedNotificationDetail,
  fetchNotificationDetail,
  getCachedNotificationDetail,
  getNotificationDetailCacheStats,
  getLatestCachedNotificationDetail,
  revalidateNotificationDetail,
  resetNotificationDetailMemoryCache
} from "./notificationDetail";
import { persistNotificationDetail } from "./notificationStores";

function notification(
  type: string,
  url: string
): GitHubNotification {
  return {
    id: "1",
    unread: true,
    reason: "mention",
    updated_at: "2026-07-02T10:00:00Z",
    last_read_at: null,
    subject: { title: "Subject", url, type },
    repository: { full_name: "acme/app", name: "app", owner: { login: "acme" } }
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function jsonResponseWithValidators(
  body: unknown,
  validators: Record<string, string>
) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...validators
    }
  });
}

const baseOptions = {
  token: "token",
  apiBaseUrl: "https://api.github.com",
  webBaseUrl: "https://github.com"
};

describe("fetchNotificationDetail", () => {
  beforeEach(() => {
    clearNotificationDetailCache();
  });

  it("serves the same notification version from the cache", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/comments")) {
        return jsonResponse([]);
      }
      return jsonResponse({ title: "Cached", state: "open", user: { login: "mona" } });
    });

    const options = {
      ...baseOptions,
      notification: notification("Issue", "https://api.github.com/repos/acme/app/issues/7"),
      fetchImpl: fetchMock as unknown as typeof fetch
    };
    await fetchNotificationDetail(options);
    const callsAfterFirst = fetchMock.mock.calls.length;
    const cached = await fetchNotificationDetail(options);

    expect(cached.title).toBe("Cached");
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("can delete one cached notification detail without clearing every subject", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/comments")) {
        return jsonResponse([]);
      }
      return jsonResponse({ title: "Cached", state: "open", user: { login: "mona" } });
    });

    const first = notification("Issue", "https://api.github.com/repos/acme/app/issues/7");
    const second = notification("Issue", "https://api.github.com/repos/acme/app/issues/8");
    await fetchNotificationDetail({
      ...baseOptions,
      notification: first,
      fetchImpl: fetchMock as unknown as typeof fetch
    });
    await fetchNotificationDetail({
      ...baseOptions,
      notification: second,
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    deleteCachedNotificationDetail({
      apiBaseUrl: baseOptions.apiBaseUrl,
      notification: first
    });

    expect(
      getCachedNotificationDetail({
        apiBaseUrl: baseOptions.apiBaseUrl,
        notification: first
      })
    ).toBeNull();
    expect(
      getCachedNotificationDetail({
        apiBaseUrl: baseOptions.apiBaseUrl,
        notification: second
      })
    ).not.toBeNull();
  });

  it("uses conditional HEAD validators to report an unchanged prefetched issue detail", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (init?.method === "HEAD") {
        const headers = new Headers(init.headers);
        expect(headers.get("If-None-Match")).toBeTruthy();
        expect(headers.get("If-Modified-Since")).toBeTruthy();
        return new Response(null, { status: 304 });
      }
      if (target.includes("/comments")) {
        return jsonResponseWithValidators([], {
          ETag: 'W/"notification-comments-v1"',
          "Last-Modified": "Thu, 09 Jul 2026 01:05:00 GMT"
        });
      }
      return jsonResponseWithValidators({
        title: "Cached",
        state: "open",
        user: { login: "mona" }
      }, {
        ETag: 'W/"notification-issue-v1"',
        "Last-Modified": "Thu, 09 Jul 2026 01:00:00 GMT"
      });
    });

    const options = {
      ...baseOptions,
      notification: notification("Issue", "https://api.github.com/repos/acme/app/issues/7"),
      fetchImpl: fetchMock as unknown as typeof fetch
    };
    await fetchNotificationDetail(options);

    const result = await revalidateNotificationDetail(options);

    expect(result.changed).toBe(false);
    expect(
      fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "HEAD")
    ).toHaveLength(2);
  });

  it("reports changed when a prefetched notification HEAD probe returns 200", async () => {
    let headCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (init?.method === "HEAD") {
        headCalls += 1;
        return new Response(null, {
          status: headCalls === 1 ? 304 : 200,
          headers: {
            ETag: 'W/"notification-comments-v2"',
            "Last-Modified": "Thu, 09 Jul 2026 02:00:00 GMT"
          }
        });
      }
      if (target.includes("/comments")) {
        return jsonResponseWithValidators([], {
          ETag: 'W/"notification-comments-v1"',
          "Last-Modified": "Thu, 09 Jul 2026 01:05:00 GMT"
        });
      }
      return jsonResponseWithValidators({
        title: "Cached",
        state: "open",
        user: { login: "mona" }
      }, {
        ETag: 'W/"notification-issue-v1"',
        "Last-Modified": "Thu, 09 Jul 2026 01:00:00 GMT"
      });
    });

    const options = {
      ...baseOptions,
      notification: notification("Issue", "https://api.github.com/repos/acme/app/issues/7"),
      fetchImpl: fetchMock as unknown as typeof fetch
    };
    await fetchNotificationDetail(options);

    const result = await revalidateNotificationDetail(options);

    expect(result.changed).toBe(true);
  });

  it("reports the number and size of cached notification details", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/comments")) {
        return jsonResponse([]);
      }
      return jsonResponse({ title: "Cached", state: "open", user: { login: "mona" } });
    });

    await fetchNotificationDetail({
      ...baseOptions,
      notification: notification("Issue", "https://api.github.com/repos/acme/app/issues/7"),
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    const stats = getNotificationDetailCacheStats();

    expect(stats.entries).toBe(1);
    expect(stats.bytes).toBeGreaterThan(0);
  });

  it("refetches when the notification's updated_at changes", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/comments")) {
        return jsonResponse([]);
      }
      return jsonResponse({ title: "Fresh", state: "open", user: { login: "mona" } });
    });

    const base = notification("Issue", "https://api.github.com/repos/acme/app/issues/7");
    await fetchNotificationDetail({
      ...baseOptions,
      notification: base,
      fetchImpl: fetchMock as unknown as typeof fetch
    });
    const callsAfterFirst = fetchMock.mock.calls.length;
    await fetchNotificationDetail({
      ...baseOptions,
      notification: { ...base, updated_at: "2026-07-03T00:00:00Z" },
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("flags and does not cache details whose comments failed", async () => {
    let commentCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/comments")) {
        commentCalls += 1;
        return commentCalls === 1
          ? new Response("{}", { status: 500 })
          : jsonResponse([]);
      }
      return jsonResponse({ title: "T", state: "open", user: { login: "mona" } });
    });

    const options = {
      ...baseOptions,
      notification: notification("Issue", "https://api.github.com/repos/acme/app/issues/7"),
      fetchImpl: fetchMock as unknown as typeof fetch
    };
    const first = await fetchNotificationDetail(options);
    const second = await fetchNotificationDetail(options);

    expect(first.commentsError).toBe(true);
    expect(second.commentsError).toBe(false);
  });

  it("loads an issue with its comment thread", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/issues/42/comments")) {
        return jsonResponse([
          { id: 9, body: "First!", user: { login: "mona" }, created_at: "2026-07-02T11:00:00Z" }
        ]);
      }
      if (target.includes("/users/doortts")) {
        return jsonResponse({ login: "doortts", name: "Doortts Kim" });
      }
      if (target.includes("/users/mona")) {
        return jsonResponse({ login: "mona", name: "Mona Lisa" });
      }
      return jsonResponse({
        title: "Fix login",
        state: "open",
        body: "Issue body",
        user: { login: "doortts", avatar_url: "https://avatars/doortts.png" },
        labels: [{ name: "bug", color: "d73a4a" }],
        author_association: "OWNER",
        created_at: "2026-07-01T00:00:00Z"
      });
    });

    const detail = await fetchNotificationDetail({
      ...baseOptions,
      notification: notification("Issue", "https://api.github.com/repos/acme/app/issues/42"),
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    expect(detail.title).toBe("Fix login");
    expect(detail.state).toBe("open");
    expect(detail.authorName).toBe("Doortts Kim");
    expect(detail.authorAvatarUrl).toBe("https://avatars/doortts.png");
    expect(detail.authorAssociation).toBe("OWNER");
    expect(detail.labels).toEqual([{ name: "bug", color: "d73a4a" }]);
    expect(detail.comments).toEqual([
      {
        id: "9",
        author: "mona",
        authorName: "Mona Lisa",
        avatarUrl: undefined,
        authorAssociation: undefined,
        created_at: "2026-07-02T11:00:00Z",
        body: "First!",
        reactions: []
      }
    ]);
  });

  it("marks merged pull requests as merged", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/comments")) {
        return jsonResponse([]);
      }
      if (target.includes("/users/mona")) {
        return jsonResponse({ login: "mona", name: "Mona Lisa" });
      }
      expect(target).toContain("/pulls/17");
      return jsonResponse({
        title: "Ship it",
        state: "closed",
        merged_at: "2026-07-01T00:00:00Z",
        body: "PR body",
        user: { login: "mona" }
      });
    });

    const detail = await fetchNotificationDetail({
      ...baseOptions,
      notification: notification(
        "PullRequest",
        "https://api.github.com/repos/acme/app/pulls/17"
      ),
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    expect(detail.state).toBe("merged");
  });

  it("loads discussions with their comments", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      expect(target).toContain("/graphql");
      return jsonResponse({
        data: {
          repository: {
            discussion: {
              title: "Roadmap",
              closed: false,
              body: "Talk",
              author: { login: "doortts", name: "Doortts Kim" },
              createdAt: "2026-07-01T00:00:00Z",
              labels: { nodes: [{ name: "planning" }] },
              comments: {
                nodes: [
                  {
                    databaseId: 1,
                    body: "Reply",
                    author: { login: "mona", name: "Mona Lisa" },
                    createdAt: "2026-07-02T00:00:00Z"
                  }
                ]
              }
            }
          }
        }
      });
    });

    const detail = await fetchNotificationDetail({
      ...baseOptions,
      notification: notification(
        "Discussion",
        "https://api.github.com/repos/acme/app/discussions/5"
      ),
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    expect(detail.title).toBe("Roadmap");
    expect(detail.authorName).toBe("Doortts Kim");
    expect(detail.labels).toEqual([{ name: "planning", color: "" }]);
    expect(detail.comments[0].authorName).toBe("Mona Lisa");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("loads release notes using the release id from the subject", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain("/releases/1001");
      return jsonResponse({
        name: "v0.1.0",
        tag_name: "v0.1.0",
        body: "Notes",
        author: { login: "doortts" },
        published_at: "2026-07-01T00:00:00Z"
      });
    });

    const detail = await fetchNotificationDetail({
      ...baseOptions,
      notification: notification(
        "Release",
        "https://api.github.com/repos/acme/app/releases/1001"
      ),
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    expect(detail.title).toBe("v0.1.0");
    expect(detail.state).toBe("v0.1.0");
    expect(detail.body).toBe("Notes");
  });
});

describe("synchronous notification detail cache peek", () => {
  beforeEach(() => {
    clearNotificationDetailCache();
    window.localStorage.clear();
  });

  const issue = notification(
    "Issue",
    "https://api.github.com/repos/acme/app/issues/7"
  );

  function issueFetch(title: string) {
    return vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/comments")) {
        return jsonResponse([]);
      }
      return jsonResponse({ title, state: "open", user: { login: "mona" } });
    });
  }

  it("returns null before anything is cached", () => {
    expect(
      getCachedNotificationDetail({ ...baseOptions, notification: issue })
    ).toBeNull();
  });

  it("returns the cached detail synchronously for the same version", async () => {
    const fetchMock = issueFetch("Peeked");
    await fetchNotificationDetail({
      ...baseOptions,
      notification: issue,
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    const peeked = getCachedNotificationDetail({ ...baseOptions, notification: issue });

    expect(peeked?.title).toBe("Peeked");
  });

  it("does not return a synchronous hit for a different version", async () => {
    const fetchMock = issueFetch("V1");
    await fetchNotificationDetail({
      ...baseOptions,
      notification: issue,
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    const newer = { ...issue, updated_at: "2026-07-03T00:00:00Z" };
    expect(
      getCachedNotificationDetail({ ...baseOptions, notification: newer })
    ).toBeNull();
  });

  it("exposes the latest cached detail regardless of version", async () => {
    const fetchMock = issueFetch("Latest");
    await fetchNotificationDetail({
      ...baseOptions,
      notification: issue,
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    const newer = { ...issue, updated_at: "2026-07-03T00:00:00Z" };
    // Versioned peek misses, but the version-independent latest pointer hits.
    expect(
      getCachedNotificationDetail({ ...baseOptions, notification: newer })
    ).toBeNull();
    expect(
      getLatestCachedNotificationDetail({ ...baseOptions, notification: newer })
        ?.title
    ).toBe("Latest");
  });

  it("clears the latest pointer when the cache is cleared", async () => {
    const fetchMock = issueFetch("Gone");
    await fetchNotificationDetail({
      ...baseOptions,
      notification: issue,
      fetchImpl: fetchMock as unknown as typeof fetch
    });
    clearNotificationDetailCache();

    expect(
      getLatestCachedNotificationDetail({ ...baseOptions, notification: issue })
    ).toBeNull();
  });

  it("persists a fetched detail so a fresh memory cache can restore it", async () => {
    const fetchMock = issueFetch("Persisted");
    await fetchNotificationDetail({
      ...baseOptions,
      notification: issue,
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    // Simulate an app restart: the in-memory cache is empty but localStorage
    // still holds the detail. A synchronous peek restores it from storage.
    resetNotificationDetailMemoryCache();

    const restored = getCachedNotificationDetail({ ...baseOptions, notification: issue });
    expect(restored?.title).toBe("Persisted");
  });

  it("restores a persisted detail as the latest pointer after a restart", async () => {
    const fetchMock = issueFetch("StoredLatest");
    await fetchNotificationDetail({
      ...baseOptions,
      notification: issue,
      fetchImpl: fetchMock as unknown as typeof fetch
    });
    resetNotificationDetailMemoryCache();

    const newer = { ...issue, updated_at: "2026-07-09T00:00:00Z" };
    expect(
      getLatestCachedNotificationDetail({ ...baseOptions, notification: newer })
        ?.title
    ).toBe("StoredLatest");
  });

  it("does not persist details whose comments failed to load", async () => {
    let commentCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/comments")) {
        commentCalls += 1;
        return new Response("{}", { status: 500 });
      }
      return jsonResponse({ title: "Broken", state: "open", user: { login: "mona" } });
    });

    await fetchNotificationDetail({
      ...baseOptions,
      notification: issue,
      fetchImpl: fetchMock as unknown as typeof fetch
    });
    resetNotificationDetailMemoryCache();

    expect(commentCalls).toBe(1);
    expect(
      getCachedNotificationDetail({ ...baseOptions, notification: issue })
    ).toBeNull();
  });

  it("prunes the latest pointer once every version of a subject is evicted", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/comments")) {
        return jsonResponse([]);
      }
      return jsonResponse({ title: "T", state: "open", user: { login: "mona" } });
    });

    const subjects = Array.from({ length: 51 }, (_, i) =>
      notification("Issue", `https://api.github.com/repos/acme/app/issues/${i}`)
    );
    for (const subject of subjects) {
      await fetchNotificationDetail({
        ...baseOptions,
        notification: subject,
        fetchImpl: fetchMock as unknown as typeof fetch
      });
    }

    // Subject #0's LRU entry was evicted at the 50-entry cap and its
    // persisted-store entry at the 30-entry cap, so nothing should keep its
    // latest pointer alive once the unbounded map is gone.
    expect(
      getLatestCachedNotificationDetail({
        apiBaseUrl: baseOptions.apiBaseUrl,
        notification: subjects[0]
      })
    ).toBeNull();
  });

  it("peeks a directly persisted detail even without a prior fetch", () => {
    persistNotificationDetail(baseOptions.apiBaseUrl, issue, {
      title: "Direct",
      state: "open",
      author: "mona",
      body: "hi",
      labels: [],
      comments: []
    });

    expect(
      getCachedNotificationDetail({ ...baseOptions, notification: issue })?.title
    ).toBe("Direct");
  });
});
