import { describe, expect, it } from "vitest";
import type { NoteNode } from "../../domain/notes";
import { GITHUB_NOTIFICATIONS_ROOT_ID } from "../../services/githubNotificationsProvider";
import { githubProjectionLeaseRequested } from "./githubProjectionLease";

const root: NoteNode = {
  id: GITHUB_NOTIFICATIONS_ROOT_ID,
  nodeKind: "text",
  markerKind: "bullet",
  parentId: null,
  sortKey: 1,
  title: "Github Notifications",
  note: "",
  imageOffsetUtf16: 0,
  markdownImageWidth: null,
  layoutMode: "bullets",
  isCollapsed: false,
  isStarred: false,
  completedAt: null,
  createdAt: "2026-07-22T00:00:00Z",
  updatedAt: "2026-07-22T00:00:00Z",
  deletedAt: null,
  archivedAt: null,
  archiveRootId: null,
  pluginState: { collapsedGroups: [] },
};

describe("GitHub Notes projection lease", () => {
  it("is active only for All with an expanded root or GN zoom", () => {
    expect(
      githubProjectionLeaseRequested({
        githubRootId: GITHUB_NOTIFICATIONS_ROOT_ID,
        libraryView: "all",
        zoomRootId: null,
        githubRoot: root,
      }),
    ).toBe(true);
    expect(
      githubProjectionLeaseRequested({
        githubRootId: GITHUB_NOTIFICATIONS_ROOT_ID,
        libraryView: "all",
        zoomRootId: null,
        githubRoot: { ...root, isCollapsed: true },
      }),
    ).toBe(false);
    expect(
      githubProjectionLeaseRequested({
        githubRootId: GITHUB_NOTIFICATIONS_ROOT_ID,
        libraryView: "starred",
        zoomRootId: null,
        githubRoot: root,
      }),
    ).toBe(false);
    expect(
      githubProjectionLeaseRequested({
        githubRootId: GITHUB_NOTIFICATIONS_ROOT_ID,
        libraryView: "archive",
        zoomRootId: GITHUB_NOTIFICATIONS_ROOT_ID,
        githubRoot: { ...root, isCollapsed: true },
      }),
    ).toBe(true);
  });
});
