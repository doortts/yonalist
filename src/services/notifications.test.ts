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

  it("reuses the cached list when the server replies 304", async () => {
    const first = vi.fn(async () =>
      jsonResponse([notification("1")], { "Last-Modified": "Wed, 01 Jul 2026 00:00:00 GMT" })
    );
    const options = {
      token: "token",
      apiBaseUrl: "https://api.github.com"
    };
    await fetchNotifications({ ...options, fetchImpl: first as unknown as typeof fetch });

    const second = vi.fn(
      async (_url: unknown, init?: RequestInit) => {
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
