import { render } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { warmMarkdownBodies } from "../components/MarkdownBody";
import type { GitHubNotification } from "../domain/notifications";
import {
  fetchNotificationDetail,
  type NotificationDetailContent
} from "../services/notificationDetail";
import { useVisibleNotificationPrefetch } from "./useVisibleNotificationPrefetch";
import type { VisibleNotificationPrefetchStats } from "./useVisibleNotificationPrefetch";

vi.mock("../services/notificationDetail", () => ({
  fetchNotificationDetail: vi.fn()
}));

vi.mock("../components/MarkdownBody", () => ({
  warmMarkdownBodies: vi.fn().mockResolvedValue(undefined)
}));

const connection = {
  apiBaseUrl: "https://api.github.com",
  webBaseUrl: "https://github.com",
  token: "ghp_test"
};

function makeNotification(id: string): GitHubNotification {
  return {
    id,
    unread: true,
    reason: "mention",
    updated_at: `2026-07-0${id}T00:00:00Z`,
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
    }
  };
}

const detail: NotificationDetailContent = {
  title: "Notification 1",
  state: "open",
  author: "mona",
  body: "Prefetched body",
  labels: [],
  comments: [
    {
      id: "1001",
      author: "mona",
      created_at: "2026-07-03T00:00:00Z",
      body: "Prefetched comment",
      replies: [
        {
          id: "1002",
          author: "hubot",
          created_at: "2026-07-03T01:00:00Z",
          body: "Nested reply"
        }
      ]
    }
  ]
};

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

interface HarnessProps {
  visibleNotifications: GitHubNotification[];
  selectedId?: string | null;
  enabled?: boolean;
  online?: boolean;
  token?: string;
  maxConcurrentPrefetches?: number;
  onStats?: (stats: VisibleNotificationPrefetchStats) => void;
}

function Harness({
  visibleNotifications,
  selectedId = null,
  enabled = true,
  online = true,
  token = connection.token,
  maxConcurrentPrefetches,
  onStats
}: HarnessProps) {
  const stats = useVisibleNotificationPrefetch({
    visibleNotifications,
    selectedId,
    connection: { ...connection, token },
    online,
    enabled,
    maxConcurrentPrefetches
  });
  useEffect(() => {
    onStats?.(stats);
  }, [onStats, stats]);
  return null;
}

describe("useVisibleNotificationPrefetch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(fetchNotificationDetail).mockResolvedValue(detail);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("prefetches detail and warms markdown only after a one-second dwell", async () => {
    render(<Harness visibleNotifications={[makeNotification("1")]} />);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchNotificationDetail).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();

    expect(fetchNotificationDetail).toHaveBeenCalledTimes(1);
    expect(fetchNotificationDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "ghp_test",
        apiBaseUrl: "https://api.github.com",
        webBaseUrl: "https://github.com",
        notification: expect.objectContaining({ id: "1" })
      })
    );
    // Body plus every comment body, including nested replies, is pre-rendered.
    expect(warmMarkdownBodies).toHaveBeenCalledWith([
      "Prefetched body",
      "Prefetched comment",
      "Nested reply"
    ]);
  });

  it("cancels the dwell timer when a notification scrolls out before one second", async () => {
    const { rerender } = render(
      <Harness visibleNotifications={[makeNotification("1")]} />
    );
    await vi.advanceTimersByTimeAsync(500);
    rerender(<Harness visibleNotifications={[]} />);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(fetchNotificationDetail).not.toHaveBeenCalled();
  });

  it("does not prefetch again for the same notification snapshot", async () => {
    const { rerender } = render(
      <Harness visibleNotifications={[makeNotification("1")]} />
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(fetchNotificationDetail).toHaveBeenCalledTimes(1);

    // Re-render with the same visible notification: no re-fetch.
    rerender(<Harness visibleNotifications={[makeNotification("1")]} />);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(fetchNotificationDetail).toHaveBeenCalledTimes(1);
  });

  it("re-prefetches when a notification's updated_at bumps (cache key changes)", async () => {
    const { rerender } = render(
      <Harness visibleNotifications={[makeNotification("1")]} />
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(fetchNotificationDetail).toHaveBeenCalledTimes(1);

    const bumped = {
      ...makeNotification("1"),
      updated_at: "2026-07-09T00:00:00Z"
    };
    rerender(<Harness visibleNotifications={[bumped]} />);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(fetchNotificationDetail).toHaveBeenCalledTimes(2);
  });

  it("limits concurrent prefetch work and drains the queue as requests finish", async () => {
    const notifications = Array.from({ length: 5 }, (_, index) =>
      makeNotification(String(index + 1))
    );
    const resolvers: Array<(value: NotificationDetailContent) => void> = [];
    vi.mocked(fetchNotificationDetail).mockImplementation(
      () =>
        new Promise<NotificationDetailContent>((resolve) => {
          resolvers.push(resolve);
        })
    );

    render(
      <Harness
        visibleNotifications={notifications}
        maxConcurrentPrefetches={3}
      />
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(fetchNotificationDetail).toHaveBeenCalledTimes(3);

    resolvers.shift()?.(detail);
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();
    await flushPromises();

    expect(fetchNotificationDetail).toHaveBeenCalledTimes(4);
  });

  it("stops re-warming an evicted notification until it becomes visible again", async () => {
    const { rerender } = render(
      <Harness visibleNotifications={[makeNotification("1")]} />
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(fetchNotificationDetail).toHaveBeenCalledTimes(1);

    // Leaves view: eviction timer starts but has not fired yet.
    rerender(<Harness visibleNotifications={[]} />);
    await vi.advanceTimersByTimeAsync(599_999);
    // Comes back into view before eviction: still cached, no re-fetch.
    rerender(<Harness visibleNotifications={[makeNotification("1")]} />);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(fetchNotificationDetail).toHaveBeenCalledTimes(1);

    // Now leave view long enough to evict, then return: a fresh warm happens.
    rerender(<Harness visibleNotifications={[]} />);
    await vi.advanceTimersByTimeAsync(600_000);
    rerender(<Harness visibleNotifications={[makeNotification("1")]} />);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(fetchNotificationDetail).toHaveBeenCalledTimes(2);
  });

  it("keeps the cache for the selected notification after it leaves view", async () => {
    const { rerender } = render(
      <Harness
        visibleNotifications={[makeNotification("1")]}
        selectedId="1"
      />
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(fetchNotificationDetail).toHaveBeenCalledTimes(1);

    rerender(<Harness visibleNotifications={[]} selectedId="1" />);
    await vi.advanceTimersByTimeAsync(120_000);
    rerender(
      <Harness visibleNotifications={[makeNotification("1")]} selectedId="1" />
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    // Still cached because it stayed selected: no re-fetch.
    expect(fetchNotificationDetail).toHaveBeenCalledTimes(1);
  });

  it("skips all network work in demo mode (no token)", async () => {
    render(
      <Harness visibleNotifications={[makeNotification("1")]} token="" />
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();

    expect(fetchNotificationDetail).not.toHaveBeenCalled();
    expect(warmMarkdownBodies).not.toHaveBeenCalled();
  });

  it("skips prefetch when disabled", async () => {
    render(
      <Harness
        visibleNotifications={[makeNotification("1")]}
        enabled={false}
      />
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();

    expect(fetchNotificationDetail).not.toHaveBeenCalled();
  });

  it("skips prefetch when offline", async () => {
    render(
      <Harness
        visibleNotifications={[makeNotification("1")]}
        online={false}
      />
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();

    expect(fetchNotificationDetail).not.toHaveBeenCalled();
  });

  it("publishes stats and survives React StrictMode double-invoked effects", async () => {
    const onStats = vi.fn();
    render(
      <StrictMode>
        <Harness
          visibleNotifications={[makeNotification("1")]}
          onStats={onStats}
        />
      </StrictMode>
    );

    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();

    expect(onStats).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        visible: 1,
        completed: 1,
        cached: 1
      })
    );
  });
});
