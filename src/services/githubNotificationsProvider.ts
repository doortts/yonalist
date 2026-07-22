import type {
  ExternalBullet,
  ExternalBulletKey,
  ExternalSourceProvider
} from "../domain/externalSources";
import {
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

export interface GithubNotificationsProviderSettings {
  readonly readRetentionDays: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDateString(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
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
  now: Date
): readonly ExternalBullet[] {
  const cutoff =
    now.valueOf() -
    normalizeGithubNotificationsReadRetentionDays(readRetentionDays) *
      24 *
      60 *
      60 *
      1000;
  return items
    .filter(
      (notification) =>
        notification.unread || Date.parse(notification.updated_at) >= cutoff
    )
    .sort(
      (left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at)
    )
    .map((notification) => {
      const number = subjectNumber(notification.subject);
      return {
        key: {
          providerId: GITHUB_NOTIFICATIONS_PROVIDER_ID,
          connectionId,
          remoteId: notification.id
        },
        parentKey: null,
        title: `${notification.subject.title}${number === null ? "" : ` #${number}`}`,
        note: [
          `Repository: ${notification.repository.full_name}`,
          `Reason: ${notification.reason}`,
          `Updated: ${notification.updated_at}`,
          `Type: ${notification.subject.type}`
        ].join("\n"),
        updatedAt: notification.updated_at,
        completed: !notification.unread,
        capabilities: {
          expand: true,
          openDetails: true,
          complete: notification.unread,
          uncomplete: false,
          edit: false,
          move: false,
          delete: false,
          createChild: false
        }
      };
    });
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
    title: "Notifications",
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
          normalizeGithubNotificationsReadRetentionDays(readRetentionDays)
      };
    },
    project: ({ items, connectionId: requestedConnectionId, settings, now }) =>
      projectGithubNotifications(
        items,
        requestedConnectionId,
        settings.readRetentionDays,
        now
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
