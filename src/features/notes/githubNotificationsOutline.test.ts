import { describe, expect, it } from "vitest";
import type {
  ExternalBullet,
  ExternalSourcePageSnapshot,
  GithubNotificationsPluginMeta
} from "../../domain/externalSources";
import type { NoteNode } from "../../domain/notes";
import { GITHUB_NOTIFICATIONS_ROOT_ID } from "../../services/githubNotificationsProvider";
import {
  projectGithubNotificationsOutline,
  type GithubOutlineRow
} from "./githubNotificationsOutline";
import type { NormalizedNotesWorkspace } from "./notesWorkspaceReducer";

const connectionId = '["https://api.github.com","account-7"]';

function node(
  id: string,
  parentId: string | null,
  sortKey: number,
  overrides: Partial<NoteNode> = {}
): NoteNode {
  return {
    id,
    nodeKind: "text",
    parentId,
    sortKey,
    title: id,
    note: "",
    imageOffsetUtf16: 0,
    layoutMode: "bullets",
    isCollapsed: false,
    isStarred: false,
    completedAt: null,
    createdAt: "2026-07-21T00:00:00Z",
    updatedAt: "2026-07-21T00:00:00Z",
    deletedAt: null,
    archivedAt: null,
    archiveRootId: null,
    isReadonly: false,
    ...overrides
  };
}

function notificationMeta(
  remoteId: string,
  unread = true,
  updatedAt = "2026-07-21T10:00:00Z"
): GithubNotificationsPluginMeta {
  return {
    kind: "notification",
    notificationKey: JSON.stringify(["github", connectionId, remoteId]),
    notificationType: "Issue",
    url: `https://github.com/acme/yonalist/issues/${remoteId}`,
    updatedAt,
    unread
  };
}

function bullet(
  remoteId: string,
  dateKey: string,
  updatedAt: string,
  completed = false
): ExternalBullet {
  return {
    key: { providerId: "github", connectionId, remoteId },
    parentKey: {
      providerId: "github",
      connectionId,
      remoteId: `date:${dateKey}`
    },
    title: `Projected ${remoteId}`,
    note: `note ${remoteId}`,
    updatedAt,
    completed,
    capabilities: {
      expand: false,
      openDetails: true,
      complete: !completed,
      uncomplete: false,
      edit: false,
      move: false,
      delete: false,
      createChild: false
    }
  };
}

function dateBullet(dateKey: string, title: string): ExternalBullet {
  return {
    key: {
      providerId: "github",
      connectionId,
      remoteId: `date:${dateKey}`
    },
    parentKey: null,
    title,
    note: "",
    updatedAt: `${dateKey}T00:00:00Z`,
    completed: false,
    capabilities: {
      expand: false,
      openDetails: false,
      complete: false,
      uncomplete: false,
      edit: false,
      move: false,
      delete: false,
      createChild: false
    }
  };
}

function page(items: readonly ExternalBullet[]): ExternalSourcePageSnapshot {
  return {
    providerId: "github-notifications",
    connectionId,
    title: "Github Notifications",
    availability: "online",
    items,
    loaded: true,
    loading: false,
    error: null,
    syncedAt: "2026-07-22T00:00:00Z",
    completingKeys: new Set(),
    completionErrors: {}
  };
}

function workspace(nodes: readonly NoteNode[]): NormalizedNotesWorkspace {
  const nodesById = Object.fromEntries(nodes.map((item) => [item.id, item]));
  const childIdsByParent: Record<string, string[]> = {};
  const rootIds: string[] = [];
  for (const item of nodes) {
    if (item.parentId === null) {
      rootIds.push(item.id);
    } else {
      (childIdsByParent[item.parentId] ??= []).push(item.id);
    }
  }
  const bySort = (left: string, right: string) =>
    nodesById[left]!.sortKey - nodesById[right]!.sortKey ||
    left.localeCompare(right);
  rootIds.sort(bySort);
  Object.values(childIdsByParent).forEach((ids) => ids.sort(bySort));
  return {
    nodesById,
    childIdsByParent,
    rootIds,
    attachmentsByNodeId: {},
    selectedId: null,
    zoomRootId: null,
    editingNoteId: null,
    pendingFocusId: null,
    pendingFocusField: null,
    status: "ready",
    error: null
  };
}

function rowIdentity(row: GithubOutlineRow): string {
  return row.kind === "stored"
    ? row.nodeId
    : row.kind === "date"
      ? `date:${row.dateKey}`
      : row.kind === "projected"
        ? `projected:${row.bullet.key.remoteId}`
        : `status:${row.status}`;
}

describe("projectGithubNotificationsOutline", () => {
  it("keeps stored order, sorts dates, and appends projected rows after the saved block", () => {
    const root = node(
      GITHUB_NOTIFICATIONS_ROOT_ID,
      null,
      2,
      { title: "Github Notifications", isReadonly: undefined, pluginState: { collapsedGroups: [] } }
    );
    const date21 = node("date-21", root.id, 1, {
      title: "2026.07.21",
      isReadonly: undefined,
      pluginMeta: { kind: "date", dateKey: "2026.07.21" }
    });
    const date22 = node("date-22", root.id, 2, {
      title: "2026.07.22",
      isReadonly: undefined,
      pluginMeta: { kind: "date", dateKey: "2026.07.22" }
    });
    const userA = node("user-a", date22.id, 1);
    const saved = node("saved", date22.id, 2, {
      isReadonly: undefined,
      pluginMeta: notificationMeta("42")
    });
    const userB = node("user-b", date22.id, 3);
    const state = workspace([
      node("ordinary-a", null, 1),
      root,
      node("ordinary-b", null, 3),
      date21,
      date22,
      userA,
      saved,
      userB
    ]);
    const snapshot = page([
      dateBullet("2026-07-21", "Yesterday"),
      bullet("43", "2026-07-21", "2026-07-21T12:00:00Z"),
      dateBullet("2026-07-22", "Today"),
      bullet("42", "2026-07-22", "2026-07-22T08:00:00Z"),
      bullet("45", "2026-07-22", "2026-07-22T10:00:00Z"),
      bullet("44", "2026-07-22", "2026-07-22T10:00:00Z")
    ]);

    const projection = projectGithubNotificationsOutline({
      workspace: state,
      page: snapshot,
      showCompleted: true,
      now: new Date("2026-07-22T12:00:00Z")
    });

    expect(state.rootIds).toEqual([
      "ordinary-a",
      GITHUB_NOTIFICATIONS_ROOT_ID,
      "ordinary-b"
    ]);
    expect(projection.rows.map(rowIdentity)).toEqual([
      "date:2026.07.22",
      "user-a",
      "saved",
      "user-b",
      "projected:44",
      "projected:45",
      "date:2026.07.21",
      "projected:43"
    ]);
    expect(projection.sortableIds).toEqual(["user-a", "user-b"]);
    expect(projection.selectableUserNodeIds).toEqual(["user-a", "user-b"]);
  });

  it("keeps disappeared stored snapshots and filters read/completed subtrees without using viewedAt", () => {
    const root = node(GITHUB_NOTIFICATIONS_ROOT_ID, null, 1, {
      title: "Github Notifications",
      isReadonly: undefined,
      pluginState: { collapsedGroups: [] }
    });
    const date = node("date", root.id, 1, {
      isReadonly: undefined,
      pluginMeta: { kind: "date", dateKey: "2026.07.22" }
    });
    const unread = node("saved-unread", date.id, 1, {
      isReadonly: undefined,
      pluginMeta: notificationMeta("41", true)
    });
    const read = node("saved-read", date.id, 2, {
      isReadonly: undefined,
      pluginMeta: notificationMeta("42", false)
    });
    const readChild = node("read-child", read.id, 1);
    const completeUser = node("complete-user", date.id, 3, {
      completedAt: "2026-07-22T00:00:00Z"
    });
    const snapshot = page([
      dateBullet("2026-07-22", "Today"),
      bullet("43", "2026-07-22", "2026-07-22T11:00:00Z", false),
      bullet("44", "2026-07-22", "2026-07-22T10:00:00Z", true)
    ]);

    const projection = projectGithubNotificationsOutline({
      workspace: workspace([
        root,
        date,
        unread,
        read,
        readChild,
        completeUser
      ]),
      page: snapshot,
      showCompleted: false,
      now: new Date("2026-07-22T12:00:00Z")
    });

    expect(projection.rows.map(rowIdentity)).toEqual([
      "date:2026.07.22",
      "saved-unread",
      "projected:43"
    ]);
    expect(projection.editorFocusKeys).toContainEqual({
      kind: "provider",
      key: JSON.stringify(["github", connectionId, "43"]),
      field: "title"
    });
  });

  it("emits stable non-node status rows and never makes them selectable", () => {
    const root = node(GITHUB_NOTIFICATIONS_ROOT_ID, null, 1, {
      title: "Github Notifications",
      isReadonly: undefined,
      pluginState: { collapsedGroups: [] }
    });
    const loading = page([]);

    const projection = projectGithubNotificationsOutline({
      workspace: workspace([root]),
      page: { ...loading, loaded: false, loading: true },
      showCompleted: true,
      now: new Date("2026-07-22T12:00:00Z")
    });

    expect(projection.rows.map(rowIdentity)).toEqual(["status:loading"]);
    expect(projection.sortableIds).toEqual([]);
    expect(projection.selectableUserNodeIds).toEqual([]);
    expect(projection.editorFocusKeys).toEqual([]);

    const filteredEmpty = projectGithubNotificationsOutline({
      workspace: workspace([root]),
      page: page([
        dateBullet("2026-07-22", "Today"),
        bullet("read", "2026-07-22", "2026-07-22T10:00:00Z", true)
      ]),
      showCompleted: false,
      now: new Date("2026-07-22T12:00:00Z")
    });
    expect(filteredEmpty.rows.map(rowIdentity)).toEqual(["status:empty"]);
  });

  it("honors ordinary collapse while retaining stored groups when the provider is empty", () => {
    const root = node(GITHUB_NOTIFICATIONS_ROOT_ID, null, 1, {
      title: "Github Notifications",
      isReadonly: undefined,
      pluginState: { collapsedGroups: [] }
    });
    const date = node("date", root.id, 1, {
      isReadonly: undefined,
      pluginMeta: { kind: "date", dateKey: "2026.07.20" }
    });
    const parent = node("parent", date.id, 1, { isCollapsed: true });
    const child = node("child", parent.id, 1);
    const emptyPage = page([]);

    const collapsed = projectGithubNotificationsOutline({
      workspace: workspace([root, date, parent, child]),
      page: emptyPage,
      showCompleted: true,
      now: new Date("2026-07-22T12:00:00Z")
    });
    expect(collapsed.rows.map(rowIdentity)).toEqual([
      "date:2026.07.20",
      "parent"
    ]);
    expect(collapsed.rows.some(
      (row) => row.kind === "source-status" && row.status === "empty"
    )).toBe(false);

    const expanded = projectGithubNotificationsOutline({
      workspace: workspace([root, date, parent, child]),
      page: emptyPage,
      showCompleted: true,
      now: new Date("2026-07-22T12:00:00Z"),
      locallyExpandedNodeIds: new Set(["parent"])
    });
    expect(expanded.rows.map(rowIdentity)).toEqual([
      "date:2026.07.20",
      "parent",
      "child"
    ]);

    const collapsedRoot = {
      ...root,
      pluginState: { collapsedGroups: ["2026.07.22"] }
    };
    const projectedCollapsed = projectGithubNotificationsOutline({
      workspace: workspace([collapsedRoot]),
      page: page([
        dateBullet("2026-07-22", "Today"),
        bullet("42", "2026-07-22", "2026-07-22T10:00:00Z")
      ]),
      showCompleted: true,
      now: new Date("2026-07-22T12:00:00Z")
    });
    expect(projectedCollapsed.rows.map(rowIdentity)).toEqual([
      "date:2026.07.22"
    ]);
    expect(projectedCollapsed.rows[0]).toMatchObject({
      kind: "date",
      collapsed: true
    });

    const hiddenStored = projectGithubNotificationsOutline({
      workspace: workspace([
        root,
        date,
        node("read-only-notification", date.id, 1, {
          isReadonly: undefined,
          pluginMeta: notificationMeta("hidden", false)
        })
      ]),
      page: emptyPage,
      showCompleted: false,
      now: new Date("2026-07-22T12:00:00Z")
    });
    expect(hiddenStored.rows.map(rowIdentity)).toEqual(["status:empty"]);
  });
});
