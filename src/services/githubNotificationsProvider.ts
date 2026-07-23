import type {
  ExternalBullet,
  ExternalBulletIcon,
  ExternalBulletKey,
  ExternalSourceProvider
} from "../domain/externalSources";
import type { NoteId } from "../domain/notes";
import {
  groupNotificationsByDate,
  notificationSubtitle,
  notificationWebUrl,
  reconcileNotifications,
  subjectNumber,
  type GitHubNotification
} from "../domain/notifications";
import type { GithubConnection } from "../hooks/useGithubAuth";
import { normalizeGithubNotificationsReadRetentionDays } from "../appSettings";
import {
  githubSourceConnectionId,
  type GithubAccountIdentity
} from "./githubAccountIdentity";
import { fetchNotifications, markNotificationRead } from "./notifications";

export const GITHUB_NOTIFICATIONS_PROVIDER_ID = "github-notifications";
export const GITHUB_NOTIFICATIONS_PROVIDER_TITLE = "Github Notifications";
export const GITHUB_NOTIFICATIONS_ROOT_ID =
  "6983f947-c134-44fc-bf46-db19f68125bf" as NoteId;

export interface GithubNotificationsProviderSettings {
  readonly readRetentionDays: number;
  readonly viewedAt: Readonly<Record<string, string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDateString(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function normalizedViewedAt(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => isDateString(entry[1])
    )
  );
}

function notificationIcon(
  type: GitHubNotification["subject"]["type"]
): ExternalBulletIcon {
  switch (type) {
    case "Issue":
      return "issue";
    case "PullRequest":
      return "pull-request";
    case "Discussion":
      return "discussion";
    case "Release":
      return "release";
    default:
      return "notification";
  }
}

function decodeGithubNotification(value: unknown): GitHubNotification | null {
  if (!isRecord(value)) {
    return null;
  }
  const { id, unread, reason, updated_at: updatedAt, last_read_at: lastReadAt } =
    value;
  const subject = value.subject;
  const repository = value.repository;
  if (
    typeof id !== "string" ||
    typeof unread !== "boolean" ||
    typeof reason !== "string" ||
    !isDateString(updatedAt) ||
    (lastReadAt !== null && !isDateString(lastReadAt)) ||
    !isRecord(subject) ||
    typeof subject.title !== "string" ||
    (subject.url !== null && typeof subject.url !== "string") ||
    typeof subject.type !== "string" ||
    !isRecord(repository) ||
    typeof repository.full_name !== "string" ||
    typeof repository.name !== "string" ||
    !isRecord(repository.owner) ||
    typeof repository.owner.login !== "string"
  ) {
    return null;
  }

  const avatarUrl = repository.owner.avatar_url;
  return {
    id,
    unread,
    reason,
    updated_at: updatedAt,
    last_read_at: lastReadAt,
    subject: {
      title: subject.title,
      url: subject.url,
      type: subject.type
    },
    repository: {
      full_name: repository.full_name,
      name: repository.name,
      owner: {
        login: repository.owner.login,
        ...(typeof avatarUrl === "string" ? { avatar_url: avatarUrl } : {})
      }
    }
  };
}

function decodeNotifications(values: readonly unknown[]): GitHubNotification[] {
  const decoded: GitHubNotification[] = [];
  for (const value of values) {
    const item = decodeGithubNotification(value);
    if (item === null) {
      throw new Error("Invalid GitHub notifications payload.");
    }
    decoded.push(item);
  }
  return decoded;
}

function dedupeNotificationsByThreadId(
  notifications: readonly GitHubNotification[]
): GitHubNotification[] {
  const byId = new Map<string, GitHubNotification>();
  for (const notification of notifications) {
    const current = byId.get(notification.id);
    if (
      !current ||
      Date.parse(notification.updated_at) > Date.parse(current.updated_at)
    ) {
      byId.set(notification.id, notification);
    }
  }
  return [...byId.values()];
}

export function projectGithubNotifications(
  items: readonly GitHubNotification[],
  connectionId: string,
  readRetentionDays: number,
  now: Date,
  webBaseUrl = "https://github.com",
  viewedAt: Readonly<Record<string, string>> = {}
): readonly ExternalBullet[] {
  const cutoff =
    now.valueOf() -
    normalizeGithubNotificationsReadRetentionDays(readRetentionDays) *
      24 *
      60 *
      60 *
      1000;
  const visible = items.filter(
    (item) => item.unread || Date.parse(item.updated_at) >= cutoff
  );
  const projected: ExternalBullet[] = [];

  for (const group of groupNotificationsByDate([...visible], now)) {
    const groupKey: ExternalBulletKey = {
      providerId: GITHUB_NOTIFICATIONS_PROVIDER_ID,
      connectionId,
      remoteId: "date:" + group.key
    };
    projected.push({
      key: groupKey,
      parentKey: null,
      title: group.label,
      note: "",
      updatedAt: group.notifications[0]?.updated_at ?? now.toISOString(),
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
    });

    for (const item of group.notifications) {
      const number = subjectNumber(item.subject);
      const url = notificationWebUrl(item, webBaseUrl);
      projected.push({
        key: {
          providerId: GITHUB_NOTIFICATIONS_PROVIDER_ID,
          connectionId,
          remoteId: item.id
        },
        parentKey: groupKey,
        icon: notificationIcon(item.subject.type),
        title:
          item.subject.title + (number === null ? "" : " #" + number),
        note: notificationSubtitle(item, viewedAt[url], now),
        updatedAt: item.updated_at,
        completed: !item.unread,
        capabilities: {
          expand: false,
          openDetails: true,
          complete: item.unread,
          uncomplete: false,
          edit: false,
          move: false,
          delete: false,
          createChild: false
        }
      });
    }
  }
  return projected;
}

export function createGithubNotificationsProvider(input: {
  connection: GithubConnection;
  account: GithubAccountIdentity;
  now?: () => Date;
  openDetails?: (remoteId: string) => void;
}): ExternalSourceProvider<
  GitHubNotification,
  GithubNotificationsProviderSettings
> {
  const now = input.now ?? (() => new Date());
  const connectionId = githubSourceConnectionId(
    input.connection.apiBaseUrl,
    input.account.id
  );
  let previousItems: GitHubNotification[] | null = null;
  const matchesKey = (key: ExternalBulletKey, itemId?: string) =>
    key.providerId === GITHUB_NOTIFICATIONS_PROVIDER_ID &&
    key.connectionId === connectionId &&
    (itemId === undefined || key.remoteId === itemId);

  return {
    id: GITHUB_NOTIFICATIONS_PROVIDER_ID,
    title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
    decodeItem: decodeGithubNotification,
    keyOf: (item, requestedConnectionId) => ({
      providerId: GITHUB_NOTIFICATIONS_PROVIDER_ID,
      connectionId: requestedConnectionId,
      remoteId: item.id
    }),
    canComplete: (item) => item.unread,
    normalizeSettings(value) {
      const readRetentionDays = isRecord(value)
        ? value.readRetentionDays
        : undefined;
      return {
        readRetentionDays:
          normalizeGithubNotificationsReadRetentionDays(readRetentionDays),
        viewedAt: normalizedViewedAt(
          isRecord(value) ? value.viewedAt : undefined
        )
      };
    },
    project: ({ items, connectionId: requestedConnectionId, settings, now }) =>
      projectGithubNotifications(
        items,
        requestedConnectionId,
        settings.readRetentionDays,
        now,
        input.connection.webBaseUrl,
        settings.viewedAt
      ),
    async load({ signal, publishPartial }) {
      const items = await fetchNotifications({
        token: input.connection.token,
        apiBaseUrl: input.connection.apiBaseUrl,
        accountId: input.account.id,
        signal,
        onPartialResult(partial) {
          publishPartial(
            reconcileNotifications(
              previousItems,
              dedupeNotificationsByThreadId(decodeNotifications(partial))
            )
          );
        }
      });
      const nextItems = reconcileNotifications(
        previousItems,
        dedupeNotificationsByThreadId(decodeNotifications(items))
      );
      previousItems = nextItems;
      return nextItems;
    },
    async markComplete({ key, item, signal }) {
      if (!matchesKey(key, item.id)) {
        throw new Error("Invalid GitHub notification key.");
      }
      await markNotificationRead({
        token: input.connection.token,
        apiBaseUrl: input.connection.apiBaseUrl,
        accountId: input.account.id,
        threadId: item.id,
        signal
      });
      return { ...item, unread: false, last_read_at: now().toISOString() };
    },
    ...(input.openDetails
      ? {
          openDetails(key: ExternalBulletKey) {
            if (matchesKey(key)) {
              input.openDetails?.(key.remoteId);
            }
          }
        }
      : {})
  };
}
