import { describe, expect, it } from "vitest";
import {
  groupNotificationsByDate,
  isReadAndQuiet,
  notificationsEqual,
  notificationWebUrl,
  reconcileNotifications,
  subjectNumber,
  type GitHubNotification
} from "./notifications";

function notification(
  overrides: Partial<GitHubNotification> = {}
): GitHubNotification {
  return {
    id: "1",
    unread: true,
    reason: "mention",
    updated_at: "2026-07-02T10:00:00Z",
    last_read_at: null,
    subject: {
      title: "Design offline issue reading",
      url: "https://api.github.com/repos/Yona-projects/Home/issues/42",
      type: "Issue"
    },
    repository: {
      full_name: "Yona-projects/Home",
      name: "Home",
      owner: { login: "Yona-projects" }
    },
    ...overrides
  };
}

describe("notification web URLs", () => {
  it("maps issues, pulls, and discussions to their web pages", () => {
    expect(notificationWebUrl(notification(), "https://github.com")).toBe(
      "https://github.com/Yona-projects/Home/issues/42"
    );

    const pull = notification({
      subject: {
        title: "PR",
        url: "https://api.github.com/repos/doortts/blog/pulls/17",
        type: "PullRequest"
      }
    });
    expect(notificationWebUrl(pull, "https://github.com/")).toBe(
      "https://github.com/Yona-projects/Home/pull/17"
    );

    const discussion = notification({
      subject: {
        title: "Talk",
        url: "https://api.github.com/repos/doortts/blog/discussions/5",
        type: "Discussion"
      }
    });
    expect(notificationWebUrl(discussion, "https://github.com")).toBe(
      "https://github.com/Yona-projects/Home/discussions/5"
    );
  });

  it("falls back to the releases page for release subjects", () => {
    const release = notification({
      subject: {
        title: "v1.0",
        url: "https://api.github.com/repos/Yona-projects/Home/releases/1001",
        type: "Release"
      }
    });
    expect(notificationWebUrl(release, "https://github.com")).toBe(
      "https://github.com/Yona-projects/Home/releases"
    );
  });

  it("extracts subject numbers from API URLs", () => {
    expect(subjectNumber(notification().subject)).toBe(42);
    expect(subjectNumber({ title: "t", url: null, type: "Issue" })).toBeNull();
  });
});

describe("isReadAndQuiet", () => {
  it("treats GitHub-read notifications as quiet", () => {
    expect(isReadAndQuiet(notification({ unread: false }))).toBe(true);
  });

  it("treats locally viewed notifications as quiet until new activity arrives", () => {
    const item = notification();
    expect(isReadAndQuiet(item, "2026-07-02T11:00:00Z")).toBe(true);
    expect(isReadAndQuiet(item, "2026-07-02T09:00:00Z")).toBe(false);
    expect(isReadAndQuiet(item)).toBe(false);
  });
});

describe("groupNotificationsByDate", () => {
  it("groups by local day, newest first, with relative and compact date labels", () => {
    const now = new Date("2026-07-03T12:00:00");
    const groups = groupNotificationsByDate(
      [
        notification({ id: "a", updated_at: "2026-07-03T10:00:00" }),
        notification({ id: "b", updated_at: "2026-07-02T09:00:00" }),
        notification({ id: "c", updated_at: "2026-07-01T08:00:00" }),
        notification({ id: "d", updated_at: "2025-12-31T08:00:00" })
      ],
      now
    );

    expect(groups.map((group) => group.label)).toEqual([
      "Today",
      "Yesterday",
      "07.01",
      "2025.12.31"
    ]);
    expect(groups[0].notifications.map((item) => item.id)).toEqual(["a"]);
  });
});

describe("notificationsEqual", () => {
  it("treats identical references as equal", () => {
    const item = notification();
    expect(notificationsEqual(item, item)).toBe(true);
  });

  it("treats field-wise identical notifications as equal", () => {
    expect(notificationsEqual(notification(), notification())).toBe(true);
  });

  it("detects changes in every render-affecting field", () => {
    const base = notification();
    expect(notificationsEqual(base, notification({ id: "2" }))).toBe(false);
    expect(notificationsEqual(base, notification({ unread: false }))).toBe(false);
    expect(notificationsEqual(base, notification({ reason: "comment" }))).toBe(false);
    expect(
      notificationsEqual(base, notification({ updated_at: "2026-07-03T10:00:00Z" }))
    ).toBe(false);
    expect(
      notificationsEqual(base, notification({ last_read_at: "2026-07-03T10:00:00Z" }))
    ).toBe(false);
    expect(
      notificationsEqual(
        base,
        notification({
          subject: { ...base.subject, title: "Renamed" }
        })
      )
    ).toBe(false);
    expect(
      notificationsEqual(
        base,
        notification({
          subject: { ...base.subject, url: null }
        })
      )
    ).toBe(false);
    expect(
      notificationsEqual(
        base,
        notification({
          subject: { ...base.subject, type: "PullRequest" }
        })
      )
    ).toBe(false);
    expect(
      notificationsEqual(
        base,
        notification({
          repository: { ...base.repository, full_name: "other/repo" }
        })
      )
    ).toBe(false);
    expect(
      notificationsEqual(
        base,
        notification({
          repository: { ...base.repository, name: "renamed" }
        })
      )
    ).toBe(false);
    expect(
      notificationsEqual(
        base,
        notification({
          repository: {
            ...base.repository,
            owner: { login: "someone-else" }
          }
        })
      )
    ).toBe(false);
    expect(
      notificationsEqual(
        base,
        notification({
          repository: {
            ...base.repository,
            owner: { login: base.repository.owner.login, avatar_url: "https://x/y.png" }
          }
        })
      )
    ).toBe(false);
  });
});

describe("reconcileNotifications", () => {
  it("returns next verbatim when there is no previous list", () => {
    const next = [notification({ id: "a" })];
    expect(reconcileNotifications(null, next)).toBe(next);
  });

  it("keeps the previous array reference when nothing changed", () => {
    const previous = [notification({ id: "a" }), notification({ id: "b" })];
    const next = [notification({ id: "a" }), notification({ id: "b" })];
    expect(reconcileNotifications(previous, next)).toBe(previous);
  });

  it("reuses unchanged element references while returning a new array on change", () => {
    const previous = [notification({ id: "a" }), notification({ id: "b" })];
    const next = [
      notification({ id: "a" }),
      notification({ id: "b", updated_at: "2026-07-05T10:00:00Z" })
    ];
    const reconciled = reconcileNotifications(previous, next);
    expect(reconciled).not.toBe(previous);
    // The unchanged first element keeps its previous identity.
    expect(reconciled[0]).toBe(previous[0]);
    // The changed second element takes the fresh object.
    expect(reconciled[1]).toBe(next[1]);
  });

  it("returns a new array when length changes even if shared elements match", () => {
    const previous = [notification({ id: "a" })];
    const next = [notification({ id: "a" }), notification({ id: "b" })];
    const reconciled = reconcileNotifications(previous, next);
    expect(reconciled).not.toBe(previous);
    expect(reconciled[0]).toBe(previous[0]);
    expect(reconciled).toHaveLength(2);
  });

  it("returns a new array when the order changes", () => {
    const previous = [notification({ id: "a" }), notification({ id: "b" })];
    const next = [notification({ id: "b" }), notification({ id: "a" })];
    const reconciled = reconcileNotifications(previous, next);
    expect(reconciled).not.toBe(previous);
    expect(reconciled.map((item) => item.id)).toEqual(["b", "a"]);
  });
});
