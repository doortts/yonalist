import type {
  ExternalBullet,
  ExternalBulletIcon,
  ExternalBulletKey,
  ExternalSourceProvider
} from "../domain/externalSources";
import { serializeExternalBulletKey } from "../domain/externalSources";
import type {
  GithubNotificationSnapshotInput,
  NoteId
} from "../domain/notes";
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
export const GITHUB_EXTERNAL_KEY_PROVIDER = "github";
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

const GITHUB_NOTIFICATION_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|\+00:00)$/;

function normalizedGithubNotificationTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = GITHUB_NOTIFICATION_TIMESTAMP.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = ""] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth =
    month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  return `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}${
    fraction ? `.${fraction}` : ""
  }Z`;
}

function compareGithubNotificationInstants(left: string, right: string): number {
  const leftWhole = left.slice(0, -1).split(".");
  const rightWhole = right.slice(0, -1).split(".");
  const wholeOrder = leftWhole[0].localeCompare(rightWhole[0]);
  if (wholeOrder !== 0) return wholeOrder;
  const leftFraction = leftWhole[1] ?? "";
  const rightFraction = rightWhole[1] ?? "";
  for (let index = 0; index < Math.max(leftFraction.length, rightFraction.length); index += 1) {
    const order = (leftFraction[index] ?? "0").localeCompare(
      rightFraction[index] ?? "0"
    );
    if (order !== 0) return order;
  }
  return 0;
}

function normalizedViewedAt(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => isDateString(entry[1])
    )
  );
}

export function githubNotificationIcon(
  type: string
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
  const normalizedUpdatedAt = normalizedGithubNotificationTimestamp(updatedAt);
  const normalizedLastReadAt =
    lastReadAt === null ? null : normalizedGithubNotificationTimestamp(lastReadAt);
  if (
    typeof id !== "string" ||
    typeof unread !== "boolean" ||
    typeof reason !== "string" ||
    normalizedUpdatedAt === null ||
    (lastReadAt !== null && normalizedLastReadAt === null) ||
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
    updated_at: normalizedUpdatedAt,
    last_read_at: normalizedLastReadAt,
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
    if (!current) {
      byId.set(notification.id, notification);
      continue;
    }
    const order = compareGithubNotificationInstants(
      notification.updated_at,
      current.updated_at
    );
    if (order > 0 || (order === 0 && current.unread && !notification.unread)) {
      byId.set(notification.id, notification);
    }
  }
  return [...byId.values()];
}

function reconcileMonotonicNotifications(
  previous: GitHubNotification[] | null,
  next: GitHubNotification[]
): GitHubNotification[] {
  if (!previous) return next;
  const previousById = new Map(previous.map((notification) => [notification.id, notification]));
  return reconcileNotifications(
    previous,
    next.map((notification) => {
      const prior = previousById.get(notification.id);
      if (!prior) return notification;
      const order = compareGithubNotificationInstants(
        notification.updated_at,
        prior.updated_at
      );
      return order < 0 || (order === 0 && !prior.unread && notification.unread)
        ? prior
        : notification;
    })
  );
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
      providerId: GITHUB_EXTERNAL_KEY_PROVIDER,
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
          providerId: GITHUB_EXTERNAL_KEY_PROVIDER,
          connectionId,
          remoteId: item.id
        },
        parentKey: groupKey,
        icon: githubNotificationIcon(item.subject.type),
        externalUrl: url,
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

function localDateKey(value: string): string {
  const date = new Date(value);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join(".");
}

/** Maps one raw GitHub record without applying the projection's visibility
 * filters or local viewed-at decoration. */
export function githubNotificationSnapshot(
  notification: GitHubNotification,
  connectionId: string,
  webBaseUrl: string,
  now: Date
): GithubNotificationSnapshotInput {
  const updatedAt = normalizedGithubNotificationTimestamp(notification.updated_at);
  if (updatedAt === null) {
    throw new Error("Invalid GitHub notification timestamp.");
  }
  const number = subjectNumber(notification.subject);
  return {
    dateKey: localDateKey(updatedAt),
    notificationKey: serializeExternalBulletKey({
      providerId: GITHUB_EXTERNAL_KEY_PROVIDER,
      connectionId,
      remoteId: notification.id
    }),
    title:
      notification.subject.title + (number === null ? "" : ` #${number}`),
    note: notificationSubtitle(notification, undefined, now),
    notificationType: notification.subject.type,
    url: notificationWebUrl(notification, webBaseUrl),
    updatedAt,
    unread: notification.unread
  };
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
    key.providerId === GITHUB_EXTERNAL_KEY_PROVIDER &&
    key.connectionId === connectionId &&
    (itemId === undefined || key.remoteId === itemId);

  return {
    id: GITHUB_NOTIFICATIONS_PROVIDER_ID,
    title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
    decodeItem: decodeGithubNotification,
    keyOf: (item, requestedConnectionId) => ({
      providerId: GITHUB_EXTERNAL_KEY_PROVIDER,
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
            reconcileMonotonicNotifications(
              previousItems,
              dedupeNotificationsByThreadId(decodeNotifications(partial))
            )
          );
        }
      });
      const nextItems = reconcileMonotonicNotifications(
        previousItems,
        dedupeNotificationsByThreadId(decodeNotifications(items))
      );
      previousItems = nextItems;
      return nextItems;
    },
    seed(items) {
      previousItems = dedupeNotificationsByThreadId(items);
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
      const completed = { ...item, unread: false, last_read_at: now().toISOString() };
      previousItems = previousItems
        ? previousItems.some((previous) => previous.id === item.id)
          ? previousItems.map((previous) =>
              previous.id === item.id ? completed : previous
            )
          : [...previousItems, completed]
        : [completed];
      return completed;
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
