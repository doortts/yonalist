import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GitHubNotification } from "../domain/notifications";
import type { UseNotificationsResult } from "../hooks/useNotifications";
import { NotificationsPane } from "./NotificationsPane";

function makeNotification(
  overrides: Partial<GitHubNotification> = {}
): GitHubNotification {
  return {
    id: "1",
    unread: true,
    reason: "mention",
    updated_at: "2026-07-07T10:00:00Z",
    last_read_at: null,
    subject: {
      title: "Fix the prefetch",
      url: "https://api.github.com/repos/acme/widgets/issues/42",
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

function makeState(
  overrides: Partial<UseNotificationsResult> = {}
): UseNotificationsResult {
  return {
    notifications: [makeNotification()],
    unreadCount: 1,
    loading: false,
    error: null,
    demoMode: false,
    viewedAt: {},
    refresh: vi.fn(),
    markNotificationViewed: vi.fn(),
    openNotification: vi.fn(),
    ...overrides
  };
}

describe("NotificationsPane", () => {
  it("renders notification rows grouped and selects on click", () => {
    const onSelect = vi.fn();
    const notification = makeNotification();
    render(
      <NotificationsPane
        state={makeState({ notifications: [notification] })}
        webBaseUrl="https://github.com"
        online
        selectedId={null}
        onSelect={onSelect}
      />
    );

    const button = screen.getByRole("button", { name: /Fix the prefetch/ });
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith(notification);
    // Unread notifications show the unread dot.
    expect(screen.getByLabelText("Unread")).toBeTruthy();
    // The subject number is surfaced.
    expect(screen.getByText(/#42/)).toBeTruthy();
  });

  it("filters rows by the search query", () => {
    render(
      <NotificationsPane
        state={makeState({
          notifications: [
            makeNotification({ id: "1", subject: {
              title: "Alpha issue",
              url: "https://api.github.com/repos/acme/widgets/issues/1",
              type: "Issue"
            } }),
            makeNotification({ id: "2", subject: {
              title: "Beta issue",
              url: "https://api.github.com/repos/acme/widgets/issues/2",
              type: "Issue"
            } })
          ]
        })}
        webBaseUrl="https://github.com"
        online
        selectedId={null}
        onSelect={vi.fn()}
      />
    );

    fireEvent.change(screen.getByLabelText("Search notifications"), {
      target: { value: "alpha" }
    });

    expect(screen.getByText("Alpha issue")).toBeTruthy();
    expect(screen.queryByText("Beta issue")).toBeNull();
  });

  it("marks a read notification as quiet (no unread dot)", () => {
    render(
      <NotificationsPane
        state={makeState({
          notifications: [makeNotification({ unread: false })],
          unreadCount: 0
        })}
        webBaseUrl="https://github.com"
        online
        selectedId={null}
        onSelect={vi.fn()}
      />
    );
    expect(screen.queryByLabelText("Unread")).toBeNull();
  });

  it("shows the demo-mode note in demo mode", () => {
    render(
      <NotificationsPane
        state={makeState({ demoMode: true })}
        webBaseUrl="https://github.com"
        online
        selectedId={null}
        onSelect={vi.fn()}
      />
    );
    expect(screen.getByText(/sample notifications/i)).toBeTruthy();
  });

  it("exposes the open-all action as a tooltip trigger without a native title", async () => {
    render(
      <NotificationsPane
        state={makeState()}
        webBaseUrl="https://github.com"
        online
        selectedId={null}
        onSelect={vi.fn()}
      />
    );

    const openAll = screen.getByRole("button", {
      name: /Open all notifications/
    });
    // The explanatory text moved from a native `title` to a Base UI Tooltip
    // whose label is portalled into a `.tooltip-popup` on focus. The accessible
    // name stays on `aria-label`.
    expect(openAll).not.toHaveAttribute("title");
    expect(screen.queryByText("Open all in browser")).toBeNull();

    openAll.focus();

    expect(await screen.findByText("Open all in browser")).toHaveClass(
      "tooltip-popup"
    );
  });
});
