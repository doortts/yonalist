import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubNotification } from "../domain/notifications";
import { sampleNotifications } from "../fixtures/sampleNotifications";
import { clearNotificationCache } from "../services/notifications";
import {
  loadCachedNotifications,
  persistCachedNotifications
} from "../services/notificationStores";
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

  it("shows persisted notifications immediately while the refresh is still running", async () => {
    persistCachedNotifications(connection.apiBaseUrl, [makeNotification("cached")]);
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useNotifications(connection, true, true));

    expect(result.current.notifications.map((notification) => notification.id)).toEqual([
      "cached"
    ]);
    expect(result.current.loading).toBe(true);
  });

  it("renders the first notification page before later pages finish", async () => {
    let resolveSecondPage: (response: Response) => void = () => {};
    const secondPage = new Promise<Response>((resolve) => {
      resolveSecondPage = resolve;
    });
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([makeNotification("first")]), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          Link: '<https://api.github.com/notifications?page=2>; rel="next"'
        }
      })
    );
    fetchMock.mockReturnValueOnce(secondPage);
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useNotifications(connection, true, true));

    await waitFor(() =>
      expect(result.current.notifications.map((notification) => notification.id)).toEqual([
        "first"
      ])
    );
    expect(result.current.loading).toBe(true);

    resolveSecondPage(jsonResponse([makeNotification("second")]));

    await waitFor(() =>
      expect(result.current.notifications.map((notification) => notification.id)).toEqual([
        "first",
        "second"
      ])
    );
    expect(result.current.loading).toBe(false);
  });

  it("starts a fresh request when immediately re-enabled before the aborted request settles", async () => {
    let resolveSecondPage: (response: Response) => void = () => {};
    const secondPage = new Promise<Response>((resolve) => {
      resolveSecondPage = resolve;
    });
    let secondRequestInit: RequestInit | undefined;
    let callCount = 0;
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        callCount += 1;
        if (callCount === 1) {
          return new Response(JSON.stringify([makeNotification("first")]), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              Link: '<https://api.github.com/notifications?page=2>; rel="next"'
            }
          });
        }
        if (callCount === 2) {
          secondRequestInit = init;
          return secondPage;
        }
        return jsonResponse([makeNotification("fresh")]);
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ enabled }) => useNotifications(connection, true, enabled),
      { initialProps: { enabled: true } }
    );

    await waitFor(() =>
      expect(result.current.notifications.map((notification) => notification.id)).toEqual([
        "first"
      ])
    );
    expect(loadCachedNotifications(connection.apiBaseUrl)?.map(({ id }) => id)).toEqual([
      "first"
    ]);

    rerender({ enabled: false });

    expect(secondRequestInit?.signal).toBeInstanceOf(AbortSignal);
    expect(secondRequestInit?.signal?.aborted).toBe(true);
    expect(result.current.loading).toBe(false);

    rerender({ enabled: true });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(result.current.notifications.map((notification) => notification.id)).toEqual([
        "fresh"
      ])
    );

    await act(async () => {
      resolveSecondPage(jsonResponse([makeNotification("late")]));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.notifications.map((notification) => notification.id)).toEqual([
      "fresh"
    ]);
    expect(loadCachedNotifications(connection.apiBaseUrl)?.map(({ id }) => id)).toEqual([
      "fresh"
    ]);
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

  it("ignores previously hidden notification ids after hiding support is removed", () => {
    const hiddenId = sampleNotifications()[0].id;
    window.localStorage.setItem(
      "yonalist.notifications.hidden.v1",
      JSON.stringify([hiddenId])
    );

    const { result } = renderHook(() =>
      useNotifications({ ...connection, token: "" }, true, true)
    );

    expect(result.current.notifications.map((notification) => notification.id)).toContain(
      hiddenId
    );
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

  it("preserves the notifications array reference when a poll returns identical data", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse([makeNotification("n-1")]));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useNotifications(connection, true, true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.notifications).toHaveLength(1);
    const firstArray = result.current.notifications;
    const firstItem = firstArray[0];

    // A poll returning the exact same payload must not create a new array or
    // new element objects, so React.memo rows can bail out of re-rendering.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.notifications).toBe(firstArray);
    expect(result.current.notifications[0]).toBe(firstItem);
  });

  it("reuses unchanged element references when only one notification changes", async () => {
    vi.useFakeTimers();
    let bumped = false;
    const fetchMock = vi.fn(async () =>
      jsonResponse([
        makeNotification("n-1"),
        {
          ...makeNotification("n-2"),
          updated_at: bumped ? "2026-07-02T00:00:00Z" : "2026-07-01T00:00:00Z"
        }
      ])
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useNotifications(connection, true, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const firstArray = result.current.notifications;
    const stable = firstArray.find((n) => n.id === "n-1");
    const changing = firstArray.find((n) => n.id === "n-2");

    bumped = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(result.current.notifications).not.toBe(firstArray);
    expect(result.current.notifications.find((n) => n.id === "n-1")).toBe(stable);
    expect(result.current.notifications.find((n) => n.id === "n-2")).not.toBe(
      changing
    );
    expect(
      result.current.notifications.find((n) => n.id === "n-2")?.updated_at
    ).toBe("2026-07-02T00:00:00Z");
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
