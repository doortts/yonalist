import { readFileSync } from "node:fs";
import { fireEvent, render, screen } from "@testing-library/react";
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
