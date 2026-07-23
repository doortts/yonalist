import {
  parseGithubNotificationKey,
  serializeExternalBulletKey,
  type ExternalBullet,
  type ExternalSourcePageSnapshot
} from "../../domain/externalSources";
import { dateGroupLabel } from "../../domain/dateGroups";
import type { NoteId, NoteNode } from "../../domain/notes";
import { GITHUB_NOTIFICATIONS_ROOT_ID } from "../../services/githubNotificationsProvider";
import { githubNotificationIcon } from "../../services/githubNotificationsProvider";
import type { NormalizedNotesWorkspace } from "./notesWorkspaceReducer";

export type GithubEditorFocusKey =
  | {
      readonly kind: "stored";
      readonly nodeId: NoteId;
      readonly field: "title" | "note";
    }
  | {
      readonly kind: "provider";
      readonly key: string;
      readonly field: "title" | "note";
    };

function githubEditorFocusIdentity(key: GithubEditorFocusKey): string {
  return key.kind === "stored"
    ? `stored:${key.nodeId}:${key.field}`
    : `provider:${key.key}:${key.field}`;
}

export function resolveGithubEditorFocusFallback(
  previous: readonly GithubEditorFocusKey[],
  current: readonly GithubEditorFocusKey[],
  removed: GithubEditorFocusKey
): GithubEditorFocusKey | null {
  const previousTitles = previous.filter(({ field }) => field === "title");
  const currentTitles = new Map(
    current
      .filter(({ field }) => field === "title")
      .map((key) => [githubEditorFocusIdentity(key), key])
  );
  const removedRowIdentity =
    removed.kind === "stored"
      ? `stored:${removed.nodeId}`
      : `provider:${removed.key}`;
  const removedIndex = previousTitles.findIndex((key) =>
    githubEditorFocusIdentity(key).startsWith(`${removedRowIdentity}:`)
  );
  if (removedIndex < 0) {
    return null;
  }
  for (let index = removedIndex - 1; index >= 0; index -= 1) {
    const candidate = currentTitles.get(
      githubEditorFocusIdentity(previousTitles[index]!)
    );
    if (candidate) {
      return candidate;
    }
  }
  for (
    let index = removedIndex + 1;
    index < previousTitles.length;
    index += 1
  ) {
    const candidate = currentTitles.get(
      githubEditorFocusIdentity(previousTitles[index]!)
    );
    if (candidate) {
      return candidate;
    }
  }
  return currentTitles.values().next().value ?? null;
}

export type GithubOutlineSourceStatus =
  | "disconnected"
  | "authentication-required"
  | "loading"
  | "offline"
  | "error"
  | "empty";

export type GithubOutlineRow =
  | {
      readonly kind: "date";
      readonly key: string;
      readonly dateKey: string;
      readonly title: string;
      readonly collapsed: boolean;
      readonly storedNodeId: NoteId | null;
    }
  | {
      readonly kind: "stored";
      readonly key: string;
      readonly nodeId: NoteId;
      readonly dateKey: string;
      readonly depth: number;
    }
  | {
      readonly kind: "projected";
      readonly key: string;
      readonly dateKey: string;
      readonly depth: number;
      readonly bullet: ExternalBullet;
    }
  | {
      readonly kind: "source-status";
      readonly key: string;
      readonly status: GithubOutlineSourceStatus;
      readonly message: string;
    };

export interface GithubOutlineProjection {
  readonly rows: readonly GithubOutlineRow[];
  readonly sortableIds: readonly NoteId[];
  readonly selectableUserNodeIds: readonly NoteId[];
  readonly editorFocusKeys: readonly GithubEditorFocusKey[];
}

export interface GithubOutlineProjectionInput {
  readonly workspace: Pick<
    NormalizedNotesWorkspace,
    "nodesById" | "childIdsByParent"
  >;
  readonly page: ExternalSourcePageSnapshot | null;
  readonly showCompleted: boolean;
  readonly now: Date;
  readonly locallyExpandedNodeIds?: ReadonlySet<NoteId>;
  readonly collapsedGroups?: ReadonlySet<string>;
}

interface DateBucket {
  readonly dateKey: string;
  storedDate: NoteNode | null;
  projectedDate: ExternalBullet | null;
  projectedNotifications: ExternalBullet[];
}

function notificationTypeFromIcon(
  icon: ExternalBullet["icon"]
): string {
  switch (icon) {
    case "issue":
      return "Issue";
    case "pull-request":
      return "PullRequest";
    case "discussion":
      return "Discussion";
    case "release":
      return "Release";
    default:
      return "Notification";
  }
}

export function githubNotificationSnapshotFromBullet(
  bullet: ExternalBullet
) {
  const dateKey = projectedDateKey(bullet);
  if (dateKey === null || bullet.externalUrl === undefined) {
    return null;
  }
  return {
    dateKey,
    notificationKey: serializeExternalBulletKey(bullet.key),
    title: bullet.title,
    note: bullet.note,
    notificationType: notificationTypeFromIcon(bullet.icon),
    url: bullet.externalUrl,
    updatedAt: bullet.updatedAt,
    unread: !bullet.completed
  };
}

export function storedGithubNotificationBullet(
  node: NoteNode,
  dateKey: string
): ExternalBullet | null {
  const metadata = node.pluginMeta;
  if (metadata?.kind !== "notification") {
    return null;
  }
  const key = parseGithubNotificationKey(metadata.notificationKey);
  if (key === null) {
    return null;
  }
  return {
    key,
    parentKey: {
      providerId: key.providerId,
      connectionId: key.connectionId,
      remoteId: `date:${dateKey}`
    },
    icon: githubNotificationIcon(metadata.notificationType),
    externalUrl: metadata.url,
    title: node.title,
    note: node.note,
    updatedAt: metadata.updatedAt,
    completed: !metadata.unread,
    capabilities: {
      expand: false,
      openDetails: true,
      complete: metadata.unread,
      uncomplete: false,
      edit: false,
      move: false,
      delete: false,
      createChild: false
    }
  };
}

function canonicalDateKey(value: string): string | null {
  const normalized = value.replaceAll("-", ".");
  return /^\d{4}\.\d{2}\.\d{2}$/.test(normalized) ? normalized : null;
}

function projectedDateKey(bullet: ExternalBullet): string | null {
  if (bullet.parentKey === null) {
    return bullet.key.remoteId.startsWith("date:")
      ? canonicalDateKey(bullet.key.remoteId.slice("date:".length))
      : null;
  }
  return bullet.parentKey.remoteId.startsWith("date:")
    ? canonicalDateKey(bullet.parentKey.remoteId.slice("date:".length))
    : null;
}

function sourceStatusRows(
  page: ExternalSourcePageSnapshot | null
): GithubOutlineRow[] {
  if (page === null || page.availability === "disconnected") {
    return [{
      kind: "source-status",
      key: "github-status:disconnected",
      status: "disconnected",
      message: "Connect GitHub to view notifications."
    }];
  }
  if (page.availability === "authentication-required") {
    return [{
      kind: "source-status",
      key: "github-status:authentication-required",
      status: "authentication-required",
      message: "GitHub authentication is required."
    }];
  }
  if (page.availability === "connecting" || (!page.loaded && page.loading)) {
    return [{
      kind: "source-status",
      key: "github-status:loading",
      status: "loading",
      message: "Loading notifications..."
    }];
  }
  if (page.error !== null) {
    return [{
      kind: "source-status",
      key: "github-status:error",
      status: "error",
      message: page.error
    }];
  }
  if (page.availability === "offline") {
    return [{
      kind: "source-status",
      key: "github-status:offline",
      status: "offline",
      message: page.loaded
        ? "Offline. Showing cached notifications."
        : "Offline. No cached notifications."
    }];
  }
  if (page.loaded && page.items.length === 0) {
    return [{
      kind: "source-status",
      key: "github-status:empty",
      status: "empty",
      message: "No notifications."
    }];
  }
  return [];
}

function hiddenStoredSubtree(node: NoteNode, showCompleted: boolean): boolean {
  if (showCompleted) {
    return false;
  }
  if (node.pluginMeta?.kind === "notification") {
    return !node.pluginMeta.unread;
  }
  return node.completedAt !== null;
}

export function projectGithubNotificationsOutline({
  workspace,
  page,
  showCompleted,
  now,
  locallyExpandedNodeIds = new Set(),
  collapsedGroups: collapsedGroupOverride
}: GithubOutlineProjectionInput): GithubOutlineProjection {
  const root = workspace.nodesById[GITHUB_NOTIFICATIONS_ROOT_ID];
  if (root === undefined) {
    return {
      rows: sourceStatusRows(page),
      sortableIds: [],
      selectableUserNodeIds: [],
      editorFocusKeys: []
    };
  }

  const buckets = new Map<string, DateBucket>();
  const bucket = (dateKey: string) => {
    const existing = buckets.get(dateKey);
    if (existing !== undefined) {
      return existing;
    }
    const created: DateBucket = {
      dateKey,
      storedDate: null,
      projectedDate: null,
      projectedNotifications: []
    };
    buckets.set(dateKey, created);
    return created;
  };

  for (const nodeId of workspace.childIdsByParent[root.id] ?? []) {
    const node = workspace.nodesById[nodeId];
    if (node?.pluginMeta?.kind !== "date") {
      continue;
    }
    bucket(node.pluginMeta.dateKey).storedDate = node;
  }

  for (const bullet of page?.items ?? []) {
    const dateKey = projectedDateKey(bullet);
    if (dateKey === null) {
      continue;
    }
    if (bullet.parentKey === null) {
      bucket(dateKey).projectedDate = bullet;
    } else {
      bucket(dateKey).projectedNotifications.push(bullet);
    }
  }

  const savedNotificationKeys = new Set<string>();
  for (const node of Object.values(workspace.nodesById)) {
    if (node.pluginMeta?.kind === "notification") {
      savedNotificationKeys.add(node.pluginMeta.notificationKey);
    }
  }

  const rows: GithubOutlineRow[] = [];
  const sortableIds: NoteId[] = [];
  const selectableUserNodeIds: NoteId[] = [];
  const editorFocusKeys: GithubEditorFocusKey[] = [];
  const collapsedGroups =
    collapsedGroupOverride ?? new Set(root.pluginState?.collapsedGroups ?? []);

  const appendStored = (
    nodeId: NoteId,
    dateKey: string,
    depth: number
  ) => {
    const node = workspace.nodesById[nodeId];
    if (node === undefined || hiddenStoredSubtree(node, showCompleted)) {
      return;
    }
    rows.push({
      kind: "stored",
      key: `github-stored:${nodeId}`,
      nodeId,
      dateKey,
      depth
    });
    editorFocusKeys.push(
      { kind: "stored", nodeId, field: "title" },
      { kind: "stored", nodeId, field: "note" }
    );
    if (node.pluginMeta === undefined) {
      sortableIds.push(nodeId);
      selectableUserNodeIds.push(nodeId);
    }
    if (node.isCollapsed && !locallyExpandedNodeIds.has(nodeId)) {
      return;
    }
    for (const childId of workspace.childIdsByParent[nodeId] ?? []) {
      appendStored(childId, dateKey, depth + 1);
    }
  };

  const orderedBuckets = [...buckets.values()].sort((left, right) =>
    right.dateKey.localeCompare(left.dateKey)
  );
  for (const date of orderedBuckets) {
    const collapsed = collapsedGroups.has(date.dateKey);
    const storedChildIds =
      date.storedDate === null
        ? []
        : workspace.childIdsByParent[date.storedDate.id] ?? [];
    const hasVisibleStoredChildren = storedChildIds.some((nodeId) => {
      const node = workspace.nodesById[nodeId];
      return node !== undefined && !hiddenStoredSubtree(node, showCompleted);
    });
    const projected = date.projectedNotifications
      .filter(
        (bullet) =>
          !savedNotificationKeys.has(serializeExternalBulletKey(bullet.key)) &&
          (showCompleted || !bullet.completed)
      )
      .sort(
        (left, right) =>
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
          serializeExternalBulletKey(left.key).localeCompare(
            serializeExternalBulletKey(right.key)
          )
      );
    if (!hasVisibleStoredChildren && projected.length === 0) {
      continue;
    }
    const dateRow: GithubOutlineRow = {
      kind: "date",
      key: `github-date:${date.dateKey}`,
      dateKey: date.dateKey,
      title:
        dateGroupLabel(date.dateKey, now),
      collapsed,
      storedNodeId: date.storedDate?.id ?? null
    };
    rows.push(dateRow);
    if (!collapsed) {
      for (const childId of storedChildIds) {
        appendStored(childId, date.dateKey, 1);
      }
      for (const bullet of projected) {
        const key = serializeExternalBulletKey(bullet.key);
        rows.push({
          kind: "projected",
          key: `github-provider:${key}`,
          dateKey: date.dateKey,
          depth: 1,
          bullet
        });
        editorFocusKeys.push(
          { kind: "provider", key, field: "title" },
          { kind: "provider", key, field: "note" }
        );
      }
    }
  }

  const statusRows = sourceStatusRows(page).filter(
    (row) => row.kind !== "source-status" ||
      row.status !== "empty" ||
      rows.length === 0
  );
  if (
    rows.length === 0 &&
    page?.loaded &&
    !statusRows.some(
      (row) => row.kind === "source-status" && row.status === "empty"
    )
  ) {
    statusRows.push({
      kind: "source-status",
      key: "github-status:empty",
      status: "empty",
      message: "No notifications."
    });
  }
  return {
    rows: rows.length === 0 ? statusRows : [...statusRows, ...rows],
    sortableIds,
    selectableUserNodeIds,
    editorFocusKeys
  };
}
