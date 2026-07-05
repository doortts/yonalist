import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubNotification } from "../domain/notifications";
import { sampleNotifications } from "../fixtures/sampleNotifications";
import { clearNotificationCache } from "../services/notifications";
import type { GithubConnection } from "./useGithubAuth";
import { useNotifications } from "./useNotifications";

const connection: GithubConnection = {
  apiBaseUrl: "https://api.github.com",
  webBaseUrl: "https://github.com",
  token: "ghp_test"
};

function makeNotification(id: string): GitHubNotification {
  return {
    id,
    unread: true,
    reason: "mention",
    updated_at: "2026-07-01T00:00:00Z",
    last_read_at: null,
    subject: {
      title: `Notification ${id}`,
      url: `https://api.github.com/repos/acme/widgets/issues/1`,
      type: "Issue"
    },
    repository: {
      full_name: "acme/widgets",
      name: "widgets",
      owner: { login: "acme" }
    }
  };
}

function jsonResponse(items: GitHubNotification[]): Response {
  return new Response(JSON.stringify(items), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

describe("useNotifications", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearNotificationCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loads notifications on mount when online with a token", async () => {
    const fetchMock = vi.fn(async () => jsonResponse([makeNotification("n-1")]));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useNotifications(connection, true, true));

    expect(result.current.demoMode).toBe(false);
    await waitFor(() => expect(result.current.notifications).toHaveLength(1));
    expect(result.current.notifications[0].id).toBe("n-1");
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("https://api.github.com/notifications");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer ghp_test"
    );
  });

  it("serves sample data without fetching when the token is empty (demo mode)", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useNotifications({ ...connection, token: "" }, true, true)
    );

    expect(result.current.demoMode).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    // Demo mode surfaces the bundled sample feed, not fetched data.
    const sampleIds = sampleNotifications().map((notification) => notification.id);
    expect(result.current.notifications.map((n) => n.id)).toEqual(sampleIds);
    expect(sampleIds.length).toBeGreaterThan(0);
  });

  it("does not fetch when offline", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useNotifications(connection, false, true));

    // Give any stray effect a chance to run before asserting.
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.demoMode).toBe(false);
    expect(result.current.notifications).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it("polls every 60s and stops after unmount", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse([makeNotification("n-1")]));
    vi.stubGlobal("fetch", fetchMock);

    const { result, unmount } = renderHook(() =>
      useNotifications(connection, true, true)
    );

    // Let the initial load settle (flush microtasks under fake timers).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.notifications).toHaveLength(1);

    // Just before the interval nothing new fires...
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // ...and crossing 60s triggers exactly one more fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps previously loaded notifications when a refresh fails", async () => {
    let fail = false;
    const fetchMock = vi.fn(async () =>
      fail
        ? new Response("{}", { status: 500 })
        : jsonResponse([makeNotification("n-1")])
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useNotifications(connection, true, true));

    await waitFor(() => expect(result.current.notifications).toHaveLength(1));
    expect(result.current.error).toBeNull();

    fail = true;
    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.error).toContain("500"));
    // The failed refresh must not wipe the data already on screen.
    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.notifications[0].id).toBe("n-1");
    expect(result.current.loading).toBe(false);
  });
});
