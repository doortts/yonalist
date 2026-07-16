import { Checkbox } from "@base-ui/react/checkbox";
import {
  AlertCircle,
  AtSign,
  Bot,
  Check,
  ExternalLink,
  GitPullRequest,
  Mail,
  MessageCircle,
  MessagesSquare,
  RefreshCw,
  Search,
  Users
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import "./ui/form-controls.css";
import "./NotificationsPane.css";
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
import { IconTooltip } from "./ui/Tooltip";

interface NotificationsPaneProps {
  state: UseNotificationsResult;
  webBaseUrl: string;
  online: boolean;
  selectedId: string | null;
  onSelect: (notification: GitHubNotification) => void;
  onVisibleNotificationsChange?: (notifications: GitHubNotification[]) => void;
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
  const parts = [notification.repository.name];
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

interface NotificationRowProps {
  notification: GitHubNotification;
  selected: boolean;
  quiet: boolean;
  /** Locally viewed timestamp (or undefined) used only for the subtitle. */
  viewedAtValue: string | undefined;
  onSelect: (notification: GitHubNotification) => void;
}

/**
 * A single notification row. Extracted and memoized so that a poll returning
 * identical data (see reconcileNotifications) leaves every prop reference
 * stable and React can skip re-rendering the row. Props are intentionally
 * primitives plus a stable `onSelect` callback.
 */
const NotificationRow = memo(function NotificationRow({
  notification,
  selected,
  quiet,
  viewedAtValue,
  onSelect
}: NotificationRowProps) {
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
  const rowClasses = ["notification-row", quiet ? "quiet" : "", selected ? "selected" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={rowClasses}>
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
          {subtitle(notification, viewedAtValue)}
        </span>
      </button>
      {!quiet && <span className="notification-unread-dot" aria-label="Unread" />}
    </div>
  );
});

// Memoized so App commits that don't touch notification props (comment
// drafts, outbox churn, metrics) skip re-rendering the whole non-virtualized
// list. Requires every prop — including `state` and the callbacks — to be
// referentially stable in App.
export const NotificationsPane = memo(function NotificationsPane({
  state,
  webBaseUrl,
  online,
  selectedId,
  onSelect,
  onVisibleNotificationsChange
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

  useEffect(() => {
    onVisibleNotificationsChange?.(visible);
  }, [onVisibleNotificationsChange, visible]);

  // Stable identity so memoized rows only re-render when their own data or
  // selection changes, not because the pane re-created the handler.
  const handleSelect = useCallback(
    (notification: GitHubNotification) => onSelect(notification),
    [onSelect]
  );

  function openAll(notifications: GitHubNotification[]) {
    for (const notification of notifications) {
      state.openNotification(notification);
    }
  }

  return (
    <section
      className="notifications-pane"
      aria-label="Notifications"
      aria-busy={state.loading}
    >
      <div className="pane-titlebar-spacer" />
      <div className="notifications-header">
        <div className="notifications-header-lead">
          <h2>Notifications</h2>
          <Checkbox.Root
            className="settings-check notifications-toggle"
            render={<label />}
            aria-label="Only new notifications"
            checked={onlyNew}
            onCheckedChange={(next) => setOnlyNew(next)}
          >
            <span className="ui-checkbox" aria-hidden="true">
              <Checkbox.Indicator className="ui-checkbox-indicator">
                <Check size={12} strokeWidth={3} />
              </Checkbox.Indicator>
            </span>
            <span>Only new</span>
          </Checkbox.Root>
        </div>
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

      {state.demoMode && (
        <p className="notifications-note">
          Showing sample notifications. Sign in from Settings to load your
          GitHub inbox.
        </p>
      )}
      {state.error && (
        <p
          className="surface-state surface-state-error notifications-error"
          role="alert"
        >
          {state.error}
        </p>
      )}

      <div className="notifications-list">
        {groups.length === 0 && state.loading && !state.error && (
          <p className="surface-state list-empty" role="status">
            Loading notifications...
          </p>
        )}
        {groups.length === 0 && !state.loading && !state.error && (
          <p className="surface-state list-empty" role="status">
            No notifications.
          </p>
        )}
        {groups.map((group) => (
          <section key={group.key} aria-label={`Notifications for ${group.label}`}>
            <div className="notifications-date-row">
              <h3>{group.label}</h3>
              <IconTooltip label="Open all in browser">
                <button
                  type="button"
                  className="notifications-open-all"
                  aria-label={`Open all notifications for ${group.label}`}
                  onClick={() => openAll(group.notifications)}
                >
                  <ExternalLink size={15} />
                </button>
              </IconTooltip>
            </div>
            {group.notifications.map((notification) => {
              const url = notificationWebUrl(notification, webBaseUrl);
              return (
                <NotificationRow
                  key={notification.id}
                  notification={notification}
                  selected={notification.id === selectedId}
                  quiet={isReadAndQuiet(notification, state.viewedAt[url])}
                  viewedAtValue={state.viewedAt[url]}
                  onSelect={handleSelect}
                />
              );
            })}
          </section>
        ))}
      </div>
    </section>
  );
});
