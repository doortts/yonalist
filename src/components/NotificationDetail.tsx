import { Bell, ExternalLink, Loader2 } from "lucide-react";
import { subjectNumber, type GitHubNotification } from "../domain/notifications";
import type { UseNotificationDetailResult } from "../hooks/useNotificationDetail";
import { renderMarkdown } from "../markdownRender";
import { timeAgo } from "../timeFormat";

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
              className="secondary-button"
              type="button"
              onClick={() => onOpenInBrowser(notification)}
            >
              <ExternalLink size={15} />
              Open in browser
            </button>
          </div>
        </div>
        <div className="detail-actions">
          {detail && <span className={`chip chip-state-${detail.state}`}>{detail.state}</span>}
          {detail?.labels.map((label) => (
            <span className="chip" key={label}>
              {label}
            </span>
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

      {detail && !loading && (
        <>
          <article className="content-panel">
            <div className="author-row">
              <span className="avatar">
                {detail.author.slice(0, 1).toUpperCase()}
              </span>
              <div>
                <strong>{detail.author}</strong>
                <p>
                  {subjectTypeLabel(notification.subject.type)} conversation
                  {detail.created_at ? ` · ${timeAgo(detail.created_at)}` : ""}
                </p>
              </div>
            </div>
            <div
              className="markdown-body"
              dangerouslySetInnerHTML={renderMarkdown(detail.body || "No description provided.")}
            />
          </article>

          {detail.comments.length > 0 && (
            <section className="notification-comments" aria-label="Comments">
              {detail.comments.map((comment) => (
                <article className="content-panel comment-panel" key={comment.id}>
                  <div className="author-row">
                    <span className="avatar">
                      {comment.author.slice(0, 1).toUpperCase()}
                    </span>
                    <div>
                      <strong>{comment.author}</strong>
                      <p>{comment.created_at ? timeAgo(comment.created_at) : ""}</p>
                    </div>
                  </div>
                  <div
                    className="markdown-body"
                    dangerouslySetInnerHTML={renderMarkdown(comment.body)}
                  />
                </article>
              ))}
            </section>
          )}
        </>
      )}
    </>
  );
}
