import { Bell, Globe, Loader2 } from "lucide-react";
import { subjectNumber, type GitHubNotification } from "../domain/notifications";
import type { ItemKind } from "../domain/types";
import type { UseNotificationDetailResult } from "../hooks/useNotificationDetail";
import { timeAgo } from "../timeFormat";
import { CommentThread, OpeningPost } from "./CommentThread";
import { LabelChip } from "./LabelChip";
import { StateBadge } from "./StateBadge";

interface NotificationDetailProps {
  notification: GitHubNotification | null;
  state: UseNotificationDetailResult;
  onOpenInBrowser: (notification: GitHubNotification) => void;
}

function subjectTypeLabel(type: string): string {
  switch (type) {
    case "PullRequest":
      return "PR";
    case "Discussion":
      return "Discussion";
    case "Release":
      return "Release";
    default:
      return "Issue";
  }
}

function subjectKind(type: string): ItemKind {
  if (type === "PullRequest") {
    return "pull";
  }
  if (type === "Discussion") {
    return "discussion";
  }
  return "issue";
}

export function NotificationDetail({
  notification,
  state,
  onOpenInBrowser
}: NotificationDetailProps) {
  if (!notification) {
    return (
      <div className="detail-empty" aria-label="Empty notification detail">
        <Bell size={32} />
        <h2>Nothing selected</h2>
        <p className="empty-copy">
          Select a notification to read its conversation here.
        </p>
      </div>
    );
  }

  const number =
    notification.subject.type === "Release"
      ? null
      : subjectNumber(notification.subject);
  const { detail, loading, error } = state;

  return (
    <>
      <header className="detail-header">
        <div className="detail-title-row">
          <div>
            <p className="eyebrow">
              {notification.repository.full_name} ·{" "}
              {subjectTypeLabel(notification.subject.type)}
              {number !== null && ` #${number}`}
            </p>
            <h2>{detail?.title ?? notification.subject.title}</h2>
          </div>
          <div className="detail-header-actions">
            <button
              className="icon-button"
              type="button"
              aria-label="Open in browser"
              title="브라우저에서 열기"
              onClick={() => onOpenInBrowser(notification)}
            >
              <Globe size={16} />
            </button>
          </div>
        </div>
        <div className="detail-actions">
          {detail &&
            (notification.subject.type === "Release" ? (
              <span className="chip">{detail.state}</span>
            ) : (
              <StateBadge
                kind={subjectKind(notification.subject.type)}
                state={detail.state}
              />
            ))}
          {detail?.labels.map((label) => (
            <LabelChip key={label.name} label={label} />
          ))}
          <span className="detail-connection">
            {notification.reason.replace(/_/g, " ")}
          </span>
        </div>
      </header>

      {loading && (
        <div className="detail-loading" aria-label="Loading conversation">
          <Loader2 size={20} className="spinning" />
          <span>Loading conversation...</span>
        </div>
      )}

      {error && <p className="notifications-error detail-error">{error}</p>}
      {detail?.commentsError && !loading && (
        <p className="notifications-error detail-error">
          Comments could not be loaded. Reopen this notification to retry.
        </p>
      )}

      {detail && !loading && (
        <div className="conversation">
          <OpeningPost
            author={{
              login: detail.author,
              name: detail.authorName,
              avatarUrl: detail.authorAvatarUrl,
              association: detail.authorAssociation
            }}
            subtitle={`${subjectTypeLabel(notification.subject.type)} · ${
              detail.created_at ? `opened ${timeAgo(detail.created_at)}` : "conversation"
            }`}
            body={detail.body || "No description provided."}
            reactions={detail.reactions}
          />
          <CommentThread comments={detail.comments} subjectAuthor={detail.author} />
        </div>
      )}
    </>
  );
}
