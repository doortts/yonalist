import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubNotification } from "../domain/notifications";
import {
  clearNotificationCache,
  getNotificationCacheStats,
  fetchUnreadNotificationUpdates,
  fetchNotifications,
  markNotificationRead
} from "./notifications";

function notification(id: string): GitHubNotification {
  return {
    id,
    unread: true,
    reason: "mention",
    updated_at: "2026-07-02T10:00:00Z",
    last_read_at: null,
    subject: { title: `n${id}`, url: null, type: "Issue" },
    repository: { full_name: "acme/app", name: "app", owner: { login: "acme" } }
  };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers }
  });
}

describe("fetchNotifications", () => {
  beforeEach(() => {
    clearNotificationCache();
  });

  it("requests all notifications with pagination parameters", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request) =>
      jsonResponse([notification("1")], { "Last-Modified": "Wed, 01 Jul 2026 00:00:00 GMT" })
    );

    const result = await fetchNotifications({
      token: "token",
      apiBaseUrl: "https://api.github.com",
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    expect(result).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/notifications?");
    expect(url).toContain("all=true");
    // The notifications endpoint caps per_page at 50.
    expect(url).toContain("per_page=50");
  });

  it("bypasses the HTTP cache with cache: no-store on every page fetch", async () => {
    const fullPage = Array.from({ length: 50 }, (_, index) =>
      notification(String(index))
    );
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(fullPage, {
        Link: '<https://api.github.com/notifications?page=2>; rel="next"'
      })
    );
    fetchMock.mockResolvedValueOnce(jsonResponse([notification("last")]));

    await fetchNotifications({
      token: "token",
      apiBaseUrl: "https://api.github.com",
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).cache).toBe("no-store");
    }
  });

  it("reuses the cached full list when the first page snapshot is unchanged", async () => {
    const options = {
      token: "token",
      apiBaseUrl: "https://api.github.com"
    };
    const first = vi.fn(async () =>
      jsonResponse([notification("old-1"), notification("old-2")], {
        "Last-Modified": "Wed, 01 Jul 2026 00:00:00 GMT"
      })
    );
    await fetchNotifications({ ...options, fetchImpl: first as unknown as typeof fetch });

    const second = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers["If-Modified-Since"]).toBeUndefined();
      expect(headers["If-None-Match"]).toBeUndefined();
      return jsonResponse([notification("old-1"), notification("old-2")]);
    });
    const cached = await fetchNotifications({
      ...options,
      fetchImpl: second as unknown as typeof fetch
    });

    expect(cached.map((entry) => entry.id)).toEqual(["old-1", "old-2"]);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does not use ETag or If-Modified-Since for the app-list first page check", async () => {
    const first = vi.fn(async () =>
      jsonResponse([notification("1")], {
        ETag: 'W/"etag-1"',
        "Last-Modified": "Wed, 01 Jul 2026 00:00:00 GMT"
      })
    );
    const options = { token: "token", apiBaseUrl: "https://api.github.com" };
    await fetchNotifications({ ...options, fetchImpl: first as unknown as typeof fetch });

    const second = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers["If-None-Match"]).toBeUndefined();
      expect(headers["If-Modified-Since"]).toBeUndefined();
      return jsonResponse([notification("1")]);
    });
    const cached = await fetchNotifications({
      ...options,
      fetchImpl: second as unknown as typeof fetch
    });

    expect(cached).toHaveLength(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does not miss a new first-page notification because app-list refresh does not trust 304", async () => {
    const options = { token: "token", apiBaseUrl: "https://api.github.com" };
    const first = vi.fn(async () =>
      jsonResponse([notification("old")], {
        "Last-Modified": "Wed, 01 Jul 2026 00:00:00 GMT"
      })
    );
    await fetchNotifications({ ...options, fetchImpl: first as unknown as typeof fetch });

    const second = vi.fn(async () => {
      return jsonResponse([notification("new"), notification("old")]);
    });

    const result = await fetchNotifications({
      ...options,
      fetchImpl: second as unknown as typeof fetch
    });

    expect(result.map((entry) => entry.id)).toEqual(["new", "old"]);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does not reuse the cached list when the refreshed first page is shorter", async () => {
    const options = { token: "token", apiBaseUrl: "https://api.github.com" };
    const first = vi.fn(async () =>
      jsonResponse([notification("old-1"), notification("old-2")])
    );
    await fetchNotifications({
      ...options,
      fetchImpl: first as unknown as typeof fetch
    });

    const second = vi.fn(async () => jsonResponse([notification("old-1")]));

    const result = await fetchNotifications({
      ...options,
      fetchImpl: second as unknown as typeof fetch
    });

    expect(result.map((entry) => entry.id)).toEqual(["old-1"]);
  });

  it("keeps paginating when the first page differs from the cached list", async () => {
    const options = {
      token: "token",
      apiBaseUrl: "https://api.github.com"
    };
    const first = vi.fn(async () =>
      jsonResponse([notification("old-1"), notification("old-2")], {
        "Last-Modified": "Wed, 01 Jul 2026 00:00:00 GMT"
      })
    );
    await fetchNotifications({ ...options, fetchImpl: first as unknown as typeof fetch });

    const second = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      const headers = init?.headers as Record<string, string>;
      expect(headers["If-Modified-Since"]).toBeUndefined();
      if (target.includes("page=1")) {
        return jsonResponse([notification("new")], {
          Link: '<https://api.github.com/notifications?page=2>; rel="next"',
          "Last-Modified": "Thu, 02 Jul 2026 00:00:00 GMT"
        });
      }
      return jsonResponse([notification("old-1"), notification("old-2")]);
    });

    const result = await fetchNotifications({
      ...options,
      fetchImpl: second as unknown as typeof fetch
    });

    expect(result.map((entry) => entry.id)).toEqual(["new", "old-1", "old-2"]);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("refreshes later pages when a cached multi-page feed has an unchanged first page", async () => {
    const options = {
      token: "token",
      apiBaseUrl: "https://api.github.com"
    };
    const firstPage = Array.from({ length: 50 }, (_, index) =>
      notification(`first-${index}`)
    );
    const first = vi.fn(async (url: unknown) =>
      String(url).includes("page=1")
        ? jsonResponse(firstPage, {
            Link: '<https://api.github.com/notifications?page=2>; rel="next"'
          })
        : jsonResponse([notification("old-tail")])
    );
    await fetchNotifications({ ...options, fetchImpl: first as unknown as typeof fetch });

    const second = vi.fn(async (url: unknown) =>
      String(url).includes("page=1")
        ? jsonResponse(firstPage, {
            Link: '<https://api.github.com/notifications?page=2>; rel="next"'
          })
        : jsonResponse([notification("fresh-tail")])
    );
    const result = await fetchNotifications({
      ...options,
      fetchImpl: second as unknown as typeof fetch
    });

    expect(second).toHaveBeenCalledTimes(2);
    expect(result.at(-1)?.id).toBe("fresh-tail");
  });

  it("reports the number and size of cached notification rows", async () => {
    await fetchNotifications({
      token: "token",
      apiBaseUrl: "https://api.github.com",
      fetchImpl: vi.fn(async () =>
        jsonResponse([notification("one"), notification("two")])
      ) as unknown as typeof fetch
    });

    const stats = getNotificationCacheStats();

    expect(stats.entries).toBe(2);
    expect(stats.bytes).toBeGreaterThan(0);
  });

  it("seeds unread notification updates without emitting desktop items", async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(String(url)).toContain("all=false");
      expect(String(url)).toContain("per_page=50");
      expect(headers["If-Modified-Since"]).toBeUndefined();
      expect(headers["If-None-Match"]).toBeUndefined();
      return jsonResponse([notification("seed")], {
        "Last-Modified": "Tue, 07 Jul 2026 08:30:44 GMT",
        ETag: 'W/"ignored"'
      });
    });

    const result = await fetchUnreadNotificationUpdates({
      token: "token",
      apiBaseUrl: "https://api.github.com",
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    expect(result).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses only If-Modified-Since for unread notification 304 probes", async () => {
    const options = { token: "token", apiBaseUrl: "https://api.github.com" };
    const first = vi.fn(async () =>
      jsonResponse([notification("seed")], {
        "Last-Modified": "Tue, 07 Jul 2026 08:30:44 GMT",
        ETag: 'W/"ignored"'
      })
    );
    await fetchUnreadNotificationUpdates({
      ...options,
      fetchImpl: first as unknown as typeof fetch
    });

    const second = vi.fn(async (url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(String(url)).toContain("all=false");
      expect(String(url)).toContain("per_page=1");
      expect(headers["If-Modified-Since"]).toBe("Tue, 07 Jul 2026 08:30:44 GMT");
      expect(headers["If-None-Match"]).toBeUndefined();
      return new Response(null, { status: 304 });
    });

    const result = await fetchUnreadNotificationUpdates({
      ...options,
      fetchImpl: second as unknown as typeof fetch
    });

    expect(result).toEqual([]);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("bypasses the HTTP cache with cache: no-store on the unread probe and first page", async () => {
    const options = { token: "token", apiBaseUrl: "https://api.github.com" };
    const first = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonResponse([notification("seed")], {
        "Last-Modified": "Tue, 07 Jul 2026 08:30:44 GMT"
      })
    );
    await fetchUnreadNotificationUpdates({
      ...options,
      fetchImpl: first as unknown as typeof fetch
    });
    expect((first.mock.calls[0][1] as RequestInit).cache).toBe("no-store");

    const second = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect((init as RequestInit).cache).toBe("no-store");
      if (String(url).includes("per_page=1")) {
        return new Response(null, { status: 304 });
      }
      return jsonResponse([notification("seed")]);
    });
    await fetchUnreadNotificationUpdates({
      ...options,
      fetchImpl: second as unknown as typeof fetch
    });
    expect((second.mock.calls[0][1] as RequestInit).cache).toBe("no-store");
  });

  it("skips the probe and forces a full unread page after too many consecutive 304s", async () => {
    const options = { token: "token", apiBaseUrl: "https://api.github.com" };
    const seed = vi.fn(async () =>
      jsonResponse([notification("seed")], {
        "Last-Modified": "Tue, 07 Jul 2026 08:30:44 GMT"
      })
    );
    await fetchUnreadNotificationUpdates({
      ...options,
      fetchImpl: seed as unknown as typeof fetch
    });

    // A broken proxy answers the conditional probe with 304 forever.
    const alwaysNotModified = vi.fn(async (url: unknown) => {
      if (String(url).includes("per_page=1")) {
        return new Response(null, { status: 304 });
      }
      return jsonResponse([notification("seed")], {
        "Last-Modified": "Tue, 07 Jul 2026 08:30:44 GMT"
      });
    });

    // Five consecutive probes all return 304 and emit nothing; each performs a
    // single probe request and no full-page fetch.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await fetchUnreadNotificationUpdates({
        ...options,
        fetchImpl: alwaysNotModified as unknown as typeof fetch
      });
      expect(result).toEqual([]);
    }
    expect(alwaysNotModified).toHaveBeenCalledTimes(5);
    for (const call of alwaysNotModified.mock.calls) {
      expect(String(call[0])).toContain("per_page=1");
    }

    // The sixth call skips the conditional probe entirely and fetches the full
    // unread first page unconditionally, resynchronizing after the stale-proxy
    // failure.
    const resync = vi.fn(async (url: unknown) => {
      return jsonResponse([notification("resync"), notification("seed")], {
        "Last-Modified": "Tue, 07 Jul 2026 09:30:00 GMT"
      });
    });
    const fresh = await fetchUnreadNotificationUpdates({
      ...options,
      fetchImpl: resync as unknown as typeof fetch
    });

    expect(resync).toHaveBeenCalledTimes(1);
    expect(String(resync.mock.calls[0][0])).toContain("per_page=50");
    expect(String(resync.mock.calls[0][0])).not.toContain("per_page=1");
    expect(fresh.map((entry) => entry.id)).toEqual(["resync"]);
  });

  it("fetches the unread first page after a changed probe and returns new or updated notification items", async () => {
    const options = { token: "token", apiBaseUrl: "https://api.github.com" };
    const old = notification("old");
    const first = vi.fn(async () =>
      jsonResponse([old], {
        "Last-Modified": "Tue, 07 Jul 2026 08:30:44 GMT"
      })
    );
    await fetchUnreadNotificationUpdates({
      ...options,
      fetchImpl: first as unknown as typeof fetch
    });

    const updatedOld = {
      ...old,
      updated_at: "2026-07-07T09:00:00Z"
    };
    const second = vi.fn(async (url: unknown) => {
      if (String(url).includes("per_page=1")) {
        return jsonResponse([notification("new")], {
          "Last-Modified": "Tue, 07 Jul 2026 09:00:00 GMT"
        });
      }
      return jsonResponse([notification("new"), updatedOld], {
        "Last-Modified": "Tue, 07 Jul 2026 09:00:00 GMT"
      });
    });

    const result = await fetchUnreadNotificationUpdates({
      ...options,
      fetchImpl: second as unknown as typeof fetch
    });

    expect(result.map((entry) => entry.id)).toEqual(["new", "old"]);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("follows the Link header across pages", async () => {
    const page = (count: number, start: number) =>
      Array.from({ length: count }, (_, index) => notification(String(start + index)));
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(page(50, 0), {
        Link: '<https://api.github.com/notifications?page=2>; rel="next"'
      })
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse(page(50, 50), {
        Link: '<https://api.github.com/notifications?page=3>; rel="next"'
      })
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse(page(10, 100), {
        Link: '<https://api.github.com/notifications?page=1>; rel="first"'
      })
    );

    const result = await fetchNotifications({
      token: "token",
      apiBaseUrl: "https://api.github.com",
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    expect(result).toHaveLength(110);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2][0])).toContain("page=3");
  });

  it("emits the first page before later notification pages finish", async () => {
    const partials: string[][] = [];
    let resolveSecondPage: (response: Response) => void = () => {};
    const secondPage = new Promise<Response>((resolve) => {
      resolveSecondPage = resolve;
    });
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
    fetchMock.mockResolvedValueOnce(
      jsonResponse([notification("first")], {
        Link: '<https://api.github.com/notifications?page=2>; rel="next"'
      })
    );
    fetchMock.mockReturnValueOnce(secondPage);

    const resultPromise = fetchNotifications({
      token: "token",
      apiBaseUrl: "https://api.github.com",
      fetchImpl: fetchMock as unknown as typeof fetch,
      onPartialResult: (items) =>
        partials.push(items.map((notification) => notification.id))
    });

    await vi.waitFor(() => expect(partials).toEqual([["first"]]));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveSecondPage(jsonResponse([notification("second")]));

    await expect(resultPromise).resolves.toHaveLength(2);
    expect(partials).toEqual([["first"], ["first", "second"]]);
  });

  it("coalesces concurrent fetches for the same feed into one request", async () => {
    let resolveResponse: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchMock = vi.fn(() => pending);

    const options = {
      token: "token",
      apiBaseUrl: "https://api.github.com",
      fetchImpl: fetchMock as unknown as typeof fetch
    };
    const first = fetchNotifications(options);
    const second = fetchNotifications(options);

    resolveResponse(jsonResponse([notification("1")]));
    const [a, b] = await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toHaveLength(1);
    expect(b).toBe(a);
  });

  it("keeps paginating on full pages when no Link header exists", async () => {
    const fullPage = Array.from({ length: 50 }, (_, index) =>
      notification(String(index))
    );
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
    fetchMock.mockResolvedValueOnce(jsonResponse(fullPage));
    fetchMock.mockResolvedValueOnce(jsonResponse([notification("last")]));

    const result = await fetchNotifications({
      token: "token",
      apiBaseUrl: "https://api.github.com",
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    expect(result).toHaveLength(51);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("page=2");
  });
});

describe("markNotificationRead", () => {
  it("PATCHes the notification thread", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 205 }));

    await markNotificationRead({
      token: "token",
      apiBaseUrl: "https://api.github.com",
      threadId: "123",
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/notifications/threads/123",
      expect.objectContaining({ method: "PATCH", cache: "no-store" })
    );
  });
});
