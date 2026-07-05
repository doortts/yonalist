import {
  AlertCircle,
  AtSign,
  Bot,
  ExternalLink,
  GitPullRequest,
  Mail,
  MessageCircle,
  MessagesSquare,
  RefreshCw,
  Search,
  Users
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  groupNotificationsByDate,
  isReadAndQuiet,
  notificationWebUrl,
  subjectNumber,
  type GitHubNotification,
  type NotificationReason
} from "../domain/notifications";
import type { UseNotificationsResult } from "../hooks/useNotifications";
import { timeAgo } from "../timeFormat";

interface NotificationsPaneProps {
  state: UseNotificationsResult;
  webBaseUrl: string;
  online: boolean;
  selectedId: string | null;
  onSelect: (notification: GitHubNotification) => void;
}

const reasonIcons: Record<
  string,
  { icon: typeof Mail; className: string; label: string }
> = {
  mention: { icon: AtSign, className: "reason-mention", label: "Mentioned" },
  team_mention: { icon: Users, className: "reason-team", label: "Team mentioned" },
  comment: { icon: MessageCircle, className: "reason-comment", label: "Commented" },
  author: { icon: Bot, className: "reason-author", label: "Author activity" },
  review_requested: {
    icon: GitPullRequest,
    className: "reason-review",
    label: "Review requested"
  },
  subscribed: { icon: Mail, className: "reason-subscribed", label: "Subscribed" },
  assign: { icon: AlertCircle, className: "reason-assign", label: "Assigned" }
};

function reasonPresentation(reason: NotificationReason) {
  return (
    reasonIcons[reason] ?? {
      icon: AlertCircle,
      className: "reason-default",
      label: reason.replace(/_/g, " ")
    }
  );
}

function subtitle(
  notification: GitHubNotification,
  viewedAt: string | undefined
): string {
  const parts = [notification.repository.full_name];
  const updated = timeAgo(notification.updated_at);
  if (updated) {
    parts.push(updated);
  }
  const seen = viewedAt ?? notification.last_read_at;
  if (seen) {
    parts.push(`seen ${timeAgo(seen)}`);
  }
  return parts.join(", ");
}

export function NotificationsPane({
  state,
  webBaseUrl,
  online,
  selectedId,
  onSelect
}: NotificationsPaneProps) {
  const [query, setQuery] = useState("");
  const [onlyNew, setOnlyNew] = useState(false);

  const visible = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return state.notifications.filter((notification) => {
      if (
        onlyNew &&
        isReadAndQuiet(
          notification,
          state.viewedAt[notificationWebUrl(notification, webBaseUrl)]
        )
      ) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      const haystack =
        `${notification.subject.title} ${notification.repository.full_name}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [state.notifications, query, onlyNew, state.viewedAt, webBaseUrl]);

  const groups = useMemo(() => groupNotificationsByDate(visible), [visible]);

  function openAll(notifications: GitHubNotification[]) {
    for (const notification of notifications) {
      state.openNotification(notification);
    }
  }

  return (
    <section className="notifications-pane" aria-label="Notifications">
      <div className="pane-titlebar-spacer" />
      <div className="notifications-header">
        <h2>Notifications</h2>
        <button
          className="icon-button"
          type="button"
          aria-label="Refresh notifications"
          disabled={state.demoMode || !online}
          onClick={state.refresh}
        >
          <RefreshCw size={16} className={state.loading ? "spinning" : undefined} />
        </button>
      </div>

      <div className="notifications-search">
        <Search size={16} />
        <input
          aria-label="Search notifications"
          placeholder="Search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className="notifications-filters">
        <label className="settings-check notifications-toggle">
          <input
            type="checkbox"
            aria-label="Only new notifications"
            checked={onlyNew}
            onChange={(event) => setOnlyNew(event.target.checked)}
          />
          <span>Only new</span>
        </label>
      </div>

      {state.demoMode && (
        <p className="notifications-note">
          Showing sample notifications. Sign in from Settings to load your
          GitHub inbox.
        </p>
      )}
      {state.error && <p className="notifications-error">{state.error}</p>}

      <div className="notifications-list">
        {groups.length === 0 && (
          <p className="empty-copy list-empty">
            No notifications.
          </p>
        )}
        {groups.map((group) => (
          <section key={group.key} aria-label={`Notifications for ${group.label}`}>
            <div className="notifications-date-row">
              <h3>{group.label}</h3>
              <button
                type="button"
                className="notifications-open-all"
                aria-label={`Open all notifications for ${group.label}`}
                title="Open all in browser"
                onClick={() => openAll(group.notifications)}
              >
                <ExternalLink size={15} />
              </button>
            </div>
            {group.notifications.map((notification) => {
              const url = notificationWebUrl(notification, webBaseUrl);
              const quiet = isReadAndQuiet(notification, state.viewedAt[url]);
              const number =
                notification.subject.type === "Release"
                  ? null
                  : subjectNumber(notification.subject);
              const reason = reasonPresentation(notification.reason);
              const ReasonIcon = reason.icon;
              const SubjectIcon =
                notification.subject.type === "PullRequest"
                  ? GitPullRequest
                  : notification.subject.type === "Discussion"
                    ? MessagesSquare
                    : null;
              const rowClasses = [
                "notification-row",
                quiet ? "quiet" : "",
                notification.id === selectedId ? "selected" : ""
              ]
                .filter(Boolean)
                .join(" ");

              return (
                <div className={rowClasses} key={notification.id}>
                  <span className="notification-lead">
                    <span
                      className={`notification-reason ${reason.className}`}
                      aria-label={reason.label}
                      title={reason.label}
                    >
                      {SubjectIcon ? <SubjectIcon size={17} /> : <ReasonIcon size={17} />}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="notification-main"
                    onClick={() => onSelect(notification)}
                  >
                    <span className="notification-title">
                      {notification.subject.title}
                      {number !== null && (
                        <span className="notification-number"> #{number}</span>
                      )}
                    </span>
                    <span className="notification-subtitle">
                      {subtitle(notification, state.viewedAt[url])}
                    </span>
                  </button>
                  {!quiet && <span className="notification-unread-dot" aria-label="Unread" />}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </section>
  );
}
