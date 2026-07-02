import { describe, expect, it } from "vitest";
import {
  groupNotificationsByDate,
  isReadAndQuiet,
  notificationWebUrl,
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
  it("groups by local day, newest first, labelling today", () => {
    const now = new Date("2026-07-02T12:00:00");
    const groups = groupNotificationsByDate(
      [
        notification({ id: "a", updated_at: "2026-07-02T10:00:00" }),
        notification({ id: "b", updated_at: "2026-07-01T09:00:00" }),
        notification({ id: "c", updated_at: "2026-07-02T08:00:00" })
      ],
      now
    );

    expect(groups.map((group) => group.label)).toEqual(["Today", "2026.07.01"]);
    expect(groups[0].notifications.map((item) => item.id)).toEqual(["a", "c"]);
  });
});
