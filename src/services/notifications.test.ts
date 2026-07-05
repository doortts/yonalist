import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubNotification } from "../domain/notifications";
import {
  clearNotificationCache,
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

  it("reuses the cached list when the probe replies 304", async () => {
    const first = vi.fn(async () =>
      jsonResponse([notification("1")], { "Last-Modified": "Wed, 01 Jul 2026 00:00:00 GMT" })
    );
    const options = {
      token: "token",
      apiBaseUrl: "https://api.github.com"
    };
    await fetchNotifications({ ...options, fetchImpl: first as unknown as typeof fetch });

    const second = vi.fn(
      async (url: unknown, init?: RequestInit) => {
        // The conditional check is a cheap one-item probe.
        expect(String(url)).toContain("per_page=1");
        expect(
          (init?.headers as Record<string, string>)["If-Modified-Since"]
        ).toBe("Wed, 01 Jul 2026 00:00:00 GMT");
        return new Response(null, { status: 304 });
      }
    );
    const cached = await fetchNotifications({
      ...options,
      fetchImpl: second as unknown as typeof fetch
    });

    expect(cached).toHaveLength(1);
    expect(cached[0].id).toBe("1");
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("sends the stored ETag on the probe and honors its 304", async () => {
    // First response carries only an ETag (some GHE setups omit
    // Last-Modified), so the probe must be conditional on If-None-Match.
    const first = vi.fn(async () =>
      jsonResponse([notification("1")], { ETag: 'W/"etag-1"' })
    );
    const options = { token: "token", apiBaseUrl: "https://api.github.com" };
    await fetchNotifications({ ...options, fetchImpl: first as unknown as typeof fetch });

    const second = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toContain("per_page=1");
      const headers = init?.headers as Record<string, string>;
      expect(headers["If-None-Match"]).toBe('W/"etag-1"');
      return new Response(null, { status: 304 });
    });
    const cached = await fetchNotifications({
      ...options,
      fetchImpl: second as unknown as typeof fetch
    });

    expect(cached).toHaveLength(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("refetches the full list unconditionally when the probe sees changes", async () => {
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

    // The feed changed: the probe answers 200, and the follow-up full fetch
    // must NOT carry If-Modified-Since (a conditional response would only
    // contain the delta and wipe the older notifications).
    const second = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      const headers = init?.headers as Record<string, string>;
      if (target.includes("per_page=1")) {
        expect(headers["If-Modified-Since"]).toBeDefined();
        return jsonResponse([notification("new")]);
      }
      expect(headers["If-Modified-Since"]).toBeUndefined();
      return jsonResponse(
        [notification("new"), notification("old-1"), notification("old-2")],
        { "Last-Modified": "Thu, 02 Jul 2026 00:00:00 GMT" }
      );
    });

    const result = await fetchNotifications({
      ...options,
      fetchImpl: second as unknown as typeof fetch
    });

    expect(result.map((entry) => entry.id)).toEqual(["new", "old-1", "old-2"]);
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
      expect.objectContaining({ method: "PATCH" })
    );
  });
});
