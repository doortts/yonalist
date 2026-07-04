import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubNotification } from "../domain/notifications";
import { useDesktopNotifications } from "./useDesktopNotifications";

const sent: Array<{ title: string; body: string }> = [];

vi.mock("../services/desktopNotifications", () => ({
  ensureNotificationPermission: vi.fn(async () => true),
  sendDesktopNotification: vi.fn(async (n: { title: string; body: string }) => {
    sent.push(n);
  })
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
  notifications,
  enabled = true,
  demoMode = false
}: {
  notifications: GitHubNotification[];
  enabled?: boolean;
  demoMode?: boolean;
}) {
  useDesktopNotifications({
    notifications,
    viewedAt: {},
    webBaseUrl: "https://github.com",
    enabled,
    demoMode
  });
  return null;
}

afterEach(() => {
  sent.length = 0;
});

describe("useDesktopNotifications", () => {
  it("seeds silently on first load, then notifies for new unread items", () => {
    const { rerender } = render(
      <Harness notifications={[notification("1"), notification("2")]} />
    );
    expect(sent).toHaveLength(0);

    rerender(
      <Harness
        notifications={[notification("3"), notification("1"), notification("2")]}
      />
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ title: "acme/app", body: "n3" });
  });

  it("sends a single summary when more than five arrive at once", () => {
    const { rerender } = render(<Harness notifications={[notification("seed")]} />);
    const many = Array.from({ length: 6 }, (_, index) =>
      notification(`new-${index}`)
    );
    rerender(<Harness notifications={[...many, notification("seed")]} />);

    expect(sent).toHaveLength(1);
    expect(sent[0].body).toBe("6 new GitHub notifications");
  });

  it("does not notify in demo mode", () => {
    const { rerender } = render(
      <Harness notifications={[notification("1")]} demoMode />
    );
    rerender(<Harness notifications={[notification("2"), notification("1")]} demoMode />);
    expect(sent).toHaveLength(0);
  });
});
