import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    loaded: true,
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

function cssRule(selector: string): string {
  const css = readFileSync("src/styles.css", "utf8");
  const match = css.match(new RegExp(`${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

describe("NotificationsPane", () => {
  it("does not flash a false empty state while account identity is pending", () => {
    render(
      <NotificationsPane
        state={makeState({
          notifications: [],
          loaded: false,
          loading: true
        })}
        webBaseUrl="https://github.com"
        online
        selectedId={null}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByText("Loading notifications...")).toBeInTheDocument();
    expect(screen.queryByText("No notifications.")).not.toBeInTheDocument();
  });

  it("keeps the loaded empty state during a background refresh", () => {
    render(
      <NotificationsPane
        state={makeState({
          notifications: [],
          loaded: true,
          loading: true
        })}
        webBaseUrl="https://github.com"
        online
        selectedId={null}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByText("No notifications.")).toBeInTheDocument();
    expect(screen.queryByText("Loading notifications...")).not.toBeInTheDocument();
  });

  it("passes the selected notification unchanged to the detail callback", () => {
    let selected: GitHubNotification | null = null;
    const onSelect = vi.fn((notification: GitHubNotification) => {
      selected = notification;
    });
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
    expect(onSelect).toHaveBeenCalledOnce();
    expect(selected).toBe(notification);
    // Unread notifications show the unread dot.
    expect(screen.getByLabelText("Unread")).toBeTruthy();
    // The subject number is surfaced.
    expect(screen.getByText(/#42/)).toBeTruthy();
  });

  it("shows only the repository name in row metadata", () => {
    render(
      <NotificationsPane
        state={makeState()}
        webBaseUrl="https://github.com"
        online
        selectedId={null}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByText((content) => content.startsWith("widgets, "))).toBeTruthy();
    expect(screen.queryByText(/acme\/widgets/)).toBeNull();
  });

  it("styles long notification titles to wrap instead of truncating with ellipsis", () => {
    render(
      <NotificationsPane
        state={makeState({
          notifications: [
            makeNotification({
              subject: {
                title:
                  "This is a deliberately long notification title that should stay readable",
                url: "https://api.github.com/repos/acme/widgets/issues/42",
                type: "Issue"
              }
            })
          ]
        })}
        webBaseUrl="https://github.com"
        online
        selectedId={null}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByText(/deliberately long notification title/)).toBeTruthy();

    const titleRule = cssRule(".notification-title");
    expect(titleRule).toContain("white-space: normal");
    expect(titleRule).toContain("overflow-wrap: anywhere");
    expect(titleRule).not.toContain("text-overflow: ellipsis");
  });

  it("renders notification rows without per-row bottom lines", () => {
    const rowRule = cssRule(".notification-row");

    expect(rowRule).toContain("border-bottom: 0");
    expect(rowRule).not.toContain("border-bottom: 1px");
    expect(rowRule).toContain("padding: 5px 10px");
  });

  it("filters rows by title or repository", () => {
    render(
      <NotificationsPane
        state={makeState({
          notifications: [
            makeNotification({ id: "1", subject: {
              title: "Alpha issue",
              url: "https://api.github.com/repos/acme/widgets/issues/1",
              type: "Issue"
            } }),
            makeNotification({
              id: "2",
              subject: {
                title: "Beta issue",
                url: "https://api.github.com/repos/moon/rockets/issues/2",
                type: "Issue"
              },
              repository: {
                full_name: "moon/rockets",
                name: "rockets",
                owner: { login: "moon" }
              }
            })
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

    fireEvent.change(screen.getByLabelText("Search notifications"), {
      target: { value: "moon/rockets" }
    });

    expect(screen.queryByText("Alpha issue")).toBeNull();
    expect(screen.getByText("Beta issue")).toBeTruthy();
  });

  it("keeps Only new based on GitHub read state or a current local viewedAt", async () => {
    const user = userEvent.setup();
    const locallyViewed = makeNotification({ id: "viewed" });
    const stillNew = makeNotification({
      id: "new",
      subject: {
        title: "Still new",
        url: "https://api.github.com/repos/acme/widgets/issues/43",
        type: "Issue"
      }
    });
    const viewedUrl = "https://github.com/acme/widgets/issues/42";
    render(
      <NotificationsPane
        state={makeState({
          notifications: [locallyViewed, stillNew],
          viewedAt: { [viewedUrl]: "2026-07-07T10:00:00Z" }
        })}
        webBaseUrl="https://github.com"
        online
        selectedId={null}
        onSelect={vi.fn()}
      />
    );

    await user.click(
      screen.getByRole("checkbox", { name: "Only new notifications" })
    );

    expect(screen.queryByText("Fix the prefetch")).toBeNull();
    expect(screen.getByText("Still new")).toBeTruthy();
  });

  it("reports the search-filtered notifications for prefetch", () => {
    const onVisibleNotificationsChange = vi.fn();
    const alpha = makeNotification({
      id: "1",
      subject: {
        title: "Alpha issue",
        url: "https://api.github.com/repos/acme/widgets/issues/1",
        type: "Issue"
      }
    });
    const beta = makeNotification({
      id: "2",
      subject: {
        title: "Beta issue",
        url: "https://api.github.com/repos/acme/widgets/issues/2",
        type: "Issue"
      }
    });
    render(
      <NotificationsPane
        state={makeState({ notifications: [alpha, beta] })}
        webBaseUrl="https://github.com"
        online
        selectedId={null}
        onSelect={vi.fn()}
        onVisibleNotificationsChange={onVisibleNotificationsChange}
      />
    );

    fireEvent.change(screen.getByLabelText("Search notifications"), {
      target: { value: "alpha" }
    });

    expect(onVisibleNotificationsChange).toHaveBeenLastCalledWith([alpha]);
  });

  it("reports only-new filtered notifications for prefetch", async () => {
    const user = userEvent.setup();
    const onVisibleNotificationsChange = vi.fn();
    const unread = makeNotification({
      id: "1",
      unread: true,
      subject: {
        title: "Unread issue",
        url: "https://api.github.com/repos/acme/widgets/issues/1",
        type: "Issue"
      }
    });
    const read = makeNotification({
      id: "2",
      unread: false,
      subject: {
        title: "Read issue",
        url: "https://api.github.com/repos/acme/widgets/issues/2",
        type: "Issue"
      }
    });
    render(
      <NotificationsPane
        state={makeState({ notifications: [unread, read] })}
        webBaseUrl="https://github.com"
        online
        selectedId={null}
        onSelect={vi.fn()}
        onVisibleNotificationsChange={onVisibleNotificationsChange}
      />
    );

    await user.click(
      screen.getByRole("checkbox", { name: "Only new notifications" })
    );

    expect(onVisibleNotificationsChange).toHaveBeenLastCalledWith([unread]);
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

  it("exposes the Only new filter as a Base UI checkbox that keeps its accessible name and hides read items", async () => {
    const user = userEvent.setup();
    render(
      <NotificationsPane
        state={makeState({
          notifications: [
            makeNotification({
              id: "1",
              unread: true,
              subject: {
                title: "New unread thing",
                url: "https://api.github.com/repos/acme/widgets/issues/1",
                type: "Issue"
              }
            }),
            makeNotification({
              id: "2",
              unread: false,
              subject: {
                title: "Old read thing",
                url: "https://api.github.com/repos/acme/widgets/issues/2",
                type: "Issue"
              }
            })
          ]
        })}
        webBaseUrl="https://github.com"
        online
        selectedId={null}
        onSelect={vi.fn()}
      />
    );

    // Base UI Checkbox exposes the control through role=checkbox; the previous
    // native accessible name and label class hooks are preserved.
    const onlyNew = screen.getByRole("checkbox", { name: "Only new notifications" });
    expect(onlyNew).not.toBeChecked();
    const toggle = onlyNew.closest(".settings-check.notifications-toggle");
    expect(toggle).not.toBeNull();
    // Base UI renders a decorative box (native checkbox has none) and tracks
    // checked state as a data-attribute on the Root/label.
    expect(toggle?.querySelector(".ui-checkbox")).not.toBeNull();
    expect(toggle).not.toHaveAttribute("data-checked");
    // With the filter off both notifications are visible.
    expect(screen.getByText("New unread thing")).toBeTruthy();
    expect(screen.getByText("Old read thing")).toBeTruthy();

    await user.click(onlyNew);

    // Toggling the checkbox hides the read (quiet) notification.
    expect(onlyNew).toBeChecked();
    expect(onlyNew).toHaveAccessibleName("Only new notifications");
    expect(toggle).toHaveAttribute("data-checked");
    // The checked indicator mounts once the box is ticked.
    expect(toggle?.querySelector(".ui-checkbox-indicator")).not.toBeNull();
    expect(screen.getByText("New unread thing")).toBeTruthy();
    expect(screen.queryByText("Old read thing")).toBeNull();
  });

  it("places the Only new filter inside the header next to the title", () => {
    render(
      <NotificationsPane
        state={makeState()}
        webBaseUrl="https://github.com"
        online
        selectedId={null}
        onSelect={vi.fn()}
      />
    );

    const onlyNew = screen.getByRole("checkbox", {
      name: "Only new notifications"
    });
    // The toggle now shares the header container with the title rather than
    // sitting in its own filters row below the search box.
    const header = onlyNew.closest(".notifications-header");
    expect(header).not.toBeNull();
    expect(header?.querySelector("h2")?.textContent).toBe("Notifications");
    // The dedicated filters row is gone.
    expect(document.querySelector(".notifications-filters")).toBeNull();
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
    // The description remains mounted so aria-describedby resolves at rest.
    expect(openAll).not.toHaveAttribute("title");
    const popup = document.getElementById(
      openAll.getAttribute("aria-describedby")!
    );
    expect(popup).toHaveClass("tooltip-popup");
    expect(popup).toHaveAttribute("data-closed");
    expect(popup).toHaveTextContent("Open all in browser");

    openAll.focus();

    await waitFor(() => expect(popup).toHaveAttribute("data-open"));
  });
});
