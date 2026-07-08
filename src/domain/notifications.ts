import { dateGroupLabel, localDateKey } from "./dateGroups";

export type NotificationSubjectType =
  | "Issue"
  | "PullRequest"
  | "Discussion"
  | "Release"
  | string;

export type NotificationReason =
  | "assign"
  | "author"
  | "comment"
  | "mention"
  | "review_requested"
  | "subscribed"
  | "team_mention"
  | string;

export interface NotificationSubject {
  title: string;
  url: string | null;
  type: NotificationSubjectType;
}

export interface NotificationRepository {
  full_name: string;
  name: string;
  owner: { login: string; avatar_url?: string };
}

export interface GitHubNotification {
  id: string;
  unread: boolean;
  reason: NotificationReason;
  updated_at: string;
  last_read_at: string | null;
  subject: NotificationSubject;
  repository: NotificationRepository;
}

/** Extracts the trailing issue/PR/discussion number from a subject API URL. */
export function subjectNumber(subject: NotificationSubject): number | null {
  const match = subject.url?.match(/\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

/**
 * Maps a notification subject to the page a browser should open, mirroring
 * the Flutter client's parseUrl behaviour per subject type.
 */
export function notificationWebUrl(
  notification: GitHubNotification,
  webBaseUrl: string
): string {
  const base = `${webBaseUrl.replace(/\/+$/, "")}/${notification.repository.full_name}`;
  const number = subjectNumber(notification.subject);

  switch (notification.subject.type) {
    case "Issue":
      return number ? `${base}/issues/${number}` : `${base}/issues`;
    case "PullRequest":
      return number ? `${base}/pull/${number}` : `${base}/pulls`;
    case "Discussion":
      return number ? `${base}/discussions/${number}` : `${base}/discussions`;
    case "Release":
      return `${base}/releases`;
    default:
      return base;
  }
}

/**
 * A notification is "read and quiet" when GitHub marks it read, or when the
 * user locally viewed it after its latest activity (optimistic echo that
 * converges with GitHub on the next poll).
 */
export function isReadAndQuiet(
  notification: GitHubNotification,
  viewedAt?: string
): boolean {
  if (!notification.unread) {
    return true;
  }
  if (!notification.updated_at) {
    return false;
  }
  if (!viewedAt) {
    return false;
  }
  return new Date(viewedAt).valueOf() >= new Date(notification.updated_at).valueOf();
}

/**
 * Compares two notifications on every field the list rows, grouping, unread
 * dot, subtitle, and reason icon depend on. When this returns true the objects
 * are interchangeable, so the caller may keep the existing reference to
 * preserve object identity (which lets `React.memo` rows skip re-rendering).
 * Superset of `sameNotificationSnapshot` in services/notifications.ts: it adds
 * the render-affecting fields (reason, repository name/owner, subject url).
 */
export function notificationsEqual(
  left: GitHubNotification,
  right: GitHubNotification
): boolean {
  if (left === right) {
    return true;
  }
  return (
    left.id === right.id &&
    left.unread === right.unread &&
    left.reason === right.reason &&
    left.updated_at === right.updated_at &&
    left.last_read_at === right.last_read_at &&
    left.subject.title === right.subject.title &&
    left.subject.url === right.subject.url &&
    left.subject.type === right.subject.type &&
    left.repository.full_name === right.repository.full_name &&
    left.repository.name === right.repository.name &&
    left.repository.owner.login === right.repository.owner.login &&
    left.repository.owner.avatar_url === right.repository.owner.avatar_url
  );
}

/**
 * Returns `next` unless it is element-wise equal to `previous` (same order,
 * same render-affecting fields), in which case the `previous` array reference
 * is returned so downstream `useState`/memo consumers can bail out. For
 * notifications present in both, the previous object reference is reused when
 * unchanged. Matched by notification id, mirroring `reconcileItems`.
 */
export function reconcileNotifications(
  previous: GitHubNotification[] | null | undefined,
  next: GitHubNotification[]
): GitHubNotification[] {
  if (!previous) {
    return next;
  }
  const previousById = new Map<string, GitHubNotification>();
  for (const notification of previous) {
    previousById.set(notification.id, notification);
  }

  let changed = false;
  const reconciled = next.map((notification) => {
    const prior = previousById.get(notification.id);
    if (prior && notificationsEqual(prior, notification)) {
      return prior;
    }
    changed = true;
    return notification;
  });

  if (changed || reconciled.length !== previous.length) {
    return reconciled;
  }
  for (let index = 0; index < reconciled.length; index += 1) {
    if (reconciled[index] !== previous[index]) {
      return reconciled;
    }
  }
  return previous;
}

export interface NotificationGroup {
  key: string;
  label: string;
  notifications: GitHubNotification[];
}

/** Groups notifications by local calendar day, newest first. */
export function groupNotificationsByDate(
  notifications: GitHubNotification[],
  now: Date = new Date()
): NotificationGroup[] {
  const groups = new Map<string, GitHubNotification[]>();

  const sorted = [...notifications].sort(
    (left, right) => new Date(right.updated_at).valueOf() - new Date(left.updated_at).valueOf()
  );

  for (const notification of sorted) {
    const key = localDateKey(notification.updated_at);
    const group = groups.get(key) ?? [];
    group.push(notification);
    groups.set(key, group);
  }

  return [...groups.entries()].map(([key, grouped]) => ({
    key,
    label: dateGroupLabel(key, now),
    notifications: grouped
  }));
}
