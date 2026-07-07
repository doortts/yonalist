import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubNotification } from "../domain/notifications";
import { useDesktopNotifications } from "./useDesktopNotifications";

const sent: Array<{ title: string; body: string }> = [];

vi.mock("../services/desktopNotifications", () => ({
  ensureNotificationPermission: vi.fn(async () => true),
  sendDesktopNotification: vi.fn(async (n: { title: string; body: string }) => {
    sent.push(n);
  })
}));

const fetchUnreadNotificationUpdates = vi.fn();

vi.mock("../services/notifications", () => ({
  fetchUnreadNotificationUpdates: (...args: unknown[]) =>
    fetchUnreadNotificationUpdates(...args)
}));

function notification(id: string, title = `n${id}`): GitHubNotification {
  return {
    id,
    unread: true,
    reason: "mention",
    updated_at: "2026-07-02T10:00:00Z",
    last_read_at: null,
    subject: { title, url: null, type: "Issue" },
    repository: { full_name: "acme/app", name: "app", owner: { login: "acme" } }
  };
}

function Harness({
  enabled = true,
  demoMode = false,
  online = true,
  isRepoVisible
}: {
  enabled?: boolean;
  demoMode?: boolean;
  online?: boolean;
  isRepoVisible?: (repositoryFullName: string) => boolean;
}) {
  useDesktopNotifications({
    connection: {
      apiBaseUrl: "https://api.github.com",
      webBaseUrl: "https://github.com",
      token: "ghp_test"
    },
    viewedAt: {},
    online,
    enabled,
    demoMode,
    isRepoVisible
  });
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchUnreadNotificationUpdates.mockResolvedValue([]);
});

afterEach(() => {
  sent.length = 0;
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useDesktopNotifications", () => {
  it("sends OS notifications from the unread Notifications feed", async () => {
    fetchUnreadNotificationUpdates.mockResolvedValueOnce([
      notification("1", "Fresh notification")
    ]);

    render(<Harness />);

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ title: "acme/app", body: "Fresh notification" });
    expect(fetchUnreadNotificationUpdates).toHaveBeenCalledWith({
      token: "ghp_test",
      apiBaseUrl: "https://api.github.com"
    });
  });

  it("filters desktop notifications by the Notifications repository visibility", async () => {
    fetchUnreadNotificationUpdates.mockResolvedValueOnce([notification("1")]);

    render(<Harness isRepoVisible={() => false} />);

    await vi.waitFor(() => expect(fetchUnreadNotificationUpdates).toHaveBeenCalled());
    expect(sent).toHaveLength(0);
  });

  it("polls unread notification updates every minute", async () => {
    fetchUnreadNotificationUpdates
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([notification("2")]);

    render(<Harness />);

    await vi.waitFor(() => expect(fetchUnreadNotificationUpdates).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(60_000);

    await vi.waitFor(() => expect(fetchUnreadNotificationUpdates).toHaveBeenCalledTimes(2));
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toBe("n2");
  });

  it("does not poll or notify in demo mode", async () => {
    render(<Harness demoMode />);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchUnreadNotificationUpdates).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("ignores unread polling failures because native notifications are best effort", async () => {
    fetchUnreadNotificationUpdates.mockRejectedValueOnce(new Error("offline"));

    render(<Harness />);

    await vi.waitFor(() => expect(fetchUnreadNotificationUpdates).toHaveBeenCalled());
    expect(sent).toHaveLength(0);
  });
});
