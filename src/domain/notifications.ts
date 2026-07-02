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
  owner: { login: string };
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

export interface NotificationGroup {
  key: string;
  label: string;
  notifications: GitHubNotification[];
}

function dateKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) {
    return "unknown";
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}.${month}.${day}`;
}

/** Groups notifications by local calendar day, newest first, "Today" labelled. */
export function groupNotificationsByDate(
  notifications: GitHubNotification[],
  now: Date = new Date()
): NotificationGroup[] {
  const todayKey = dateKey(now.toISOString());
  const groups = new Map<string, GitHubNotification[]>();

  const sorted = [...notifications].sort(
    (left, right) => new Date(right.updated_at).valueOf() - new Date(left.updated_at).valueOf()
  );

  for (const notification of sorted) {
    const key = dateKey(notification.updated_at);
    const group = groups.get(key) ?? [];
    group.push(notification);
    groups.set(key, group);
  }

  return [...groups.entries()].map(([key, grouped]) => ({
    key,
    label: key === todayKey ? "Today" : key,
    notifications: grouped
  }));
}
