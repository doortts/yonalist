import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubNotification } from "../domain/notifications";
import { sampleNotifications } from "../fixtures/sampleNotifications";
import type { ExternalSourceState } from "../services/externalSourceHost";
import type { GithubConnection } from "./useGithubAuth";
import { useNotifications, type NotificationsSourceInput } from "./useNotifications";

const connection: GithubConnection = {
  apiBaseUrl: "https://api.github.com",
  webBaseUrl: "https://github.com",
  token: "ghp_test"
};

function makeNotification(
  id: string,
  overrides: Partial<GitHubNotification> = {}
): GitHubNotification {
  return {
    id,
    unread: true,
    reason: "mention",
    updated_at: "2026-07-01T00:00:00Z",
    last_read_at: null,
    subject: {
      title: `Notification ${id}`,
      url: `https://api.github.com/repos/acme/widgets/issues/${id}`,
      type: "Issue"
    },
    repository: {
      full_name: "acme/widgets",
      name: "widgets",
      owner: { login: "acme" }
    },
    ...overrides
  };
}

function sourceState(
  items: readonly GitHubNotification[],
  overrides: Partial<ExternalSourceState<GitHubNotification>> = {}
): ExternalSourceState<GitHubNotification> {
  return {
    items,
    loaded: true,
    loading: false,
    error: null,
    syncedAt: "2026-07-01T00:00:00Z",
    completingKeys: new Set(),
    completionErrors: {},
    ...overrides
  };
}

describe("useNotifications", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("adapts shared state updates and keeps selection local-only", () => {
    const first = makeNotification("1");
    const second = makeNotification("2");
    let state = sourceState([first]);
    const refresh = vi.fn(async () => undefined);
    const complete = vi.fn(async () => undefined);
    const source = () =>
      ({ state, refresh, complete }) as NotificationsSourceInput & {
        complete: typeof complete;
      };
    const { result, rerender } = renderHook(() =>
      useNotifications(connection, source())
    );

    expect(result.current.notifications).toEqual([first]);

    state = sourceState([second]);
    rerender();

    expect(result.current.notifications).toEqual([second]);
    act(() => result.current.markNotificationViewed(second));
    expect(result.current.viewedAt).toHaveProperty(
      "https://github.com/acme/widgets/issues/2"
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it("delegates refresh to the shared source", () => {
    const refresh = vi.fn(async () => undefined);
    const { result } = renderHook(() =>
      useNotifications(connection, { state: sourceState([]), refresh })
    );

    act(() => result.current.refresh());

    expect(refresh).toHaveBeenCalledOnce();
  });

  it("serves sample data when the token is empty", () => {
    const { result } = renderHook(() =>
      useNotifications({ ...connection, token: "" }, null)
    );

    expect(result.current.demoMode).toBe(true);
    expect(result.current.loaded).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.notifications.map(({ id }) => id)).toEqual(
      sampleNotifications().map(({ id }) => id)
    );
  });

  it("stays loading without demo data while account identity is pending", () => {
    const { result } = renderHook(() => useNotifications(connection, null));

    expect(result.current).toMatchObject({
      notifications: [],
      loaded: false,
      loading: true,
      demoMode: false
    });
  });

  it("stays loading before a newly created source starts its first load", () => {
    const { result } = renderHook(() =>
      useNotifications(connection, {
        state: sourceState([], { loaded: false, loading: false }),
        refresh: vi.fn(async () => undefined)
      })
    );

    expect(result.current).toMatchObject({ loaded: false, loading: true });
  });

  it("preserves source loading, errors, repository filtering, and unread count", () => {
    const visible = makeNotification("visible");
    const hidden = makeNotification("hidden", {
      repository: {
        full_name: "acme/hidden",
        name: "hidden",
        owner: { login: "acme" }
      }
    });
    const source = {
      state: sourceState([visible, hidden], {
        loading: true,
        error: "Unable to refresh external source."
      }),
      refresh: vi.fn(async () => undefined)
    };
    const { result } = renderHook(() =>
      useNotifications(
        connection,
        source,
        (repositoryFullName) => repositoryFullName !== "acme/hidden"
      )
    );

    expect(result.current.notifications).toEqual([visible]);
    expect(result.current.unreadCount).toBe(1);
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBe("Unable to refresh external source.");
  });
});
