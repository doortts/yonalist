import { Bell, Globe, Loader2, Maximize2, Minimize2 } from "lucide-react";
import type { ConversationComment } from "../domain/conversation";
import { subjectNumber, type GitHubNotification } from "../domain/notifications";
import type { ItemKind } from "../domain/types";
import type { UseNotificationDetailResult } from "../hooks/useNotificationDetail";
import { timeAgo } from "../timeFormat";
import { CommentComposer, type CommentSubmitAction } from "./CommentComposer";
import { CommentThread, OpeningPost } from "./CommentThread";
import { LabelChip } from "./LabelChip";
import { StateBadge } from "./StateBadge";
import { StickyTitle } from "./ui/StickyTitle";
import { IconTooltip, TooltipProvider } from "./ui/Tooltip";

interface NotificationDetailProps {
  notification: GitHubNotification | null;
  state: UseNotificationDetailResult;
  online: boolean;
  commentDraft: string;
  onOpenInBrowser: (notification: GitHubNotification) => void;
  onCommentDraftChange: (draft: string) => void;
  onQueueComment: (action: CommentSubmitAction) => void;
  onQueueReply?: (parent: ConversationComment, body: string) => void;
  /** Whether the detail pane is maximized (drives the inline toggle glyph). */
  detailMaximized: boolean;
  /** Toggles the maximized layout from the inline header control. */
  onToggleMaximize: () => void;
  /** Lifts the header's on-screen state so the app can move the maximize
   * control between this inline slot and the fixed titlebar corner. */
  onHeaderVisibilityChange: (headerVisible: boolean) => void;
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
  online,
  commentDraft,
  onOpenInBrowser,
  onCommentDraftChange,
  onQueueComment,
  onQueueReply,
  detailMaximized,
  onToggleMaximize,
  onHeaderVisibilityChange
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
  const { detail, loading, error, refreshing } = state;
  // Only show the full-height skeleton before any conversation is available;
  // once a (possibly stale) detail is on screen we keep it visible and swap
  // in the fresh version in the background (stale-while-revalidate).
  const showSkeleton = loading && !detail;
  const canComment = notification.subject.type !== "Release" && number !== null;
  const canClose =
    notification.subject.type === "Issue" &&
    (detail?.state ?? "open") === "open";

  return (
    <>
      <StickyTitle
        title={detail?.title ?? notification.subject.title}
        number={number}
        onHeaderVisibilityChange={onHeaderVisibilityChange}
      >
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
              <TooltipProvider>
                <IconTooltip
                  label={detailMaximized ? "상세 최대화 해제" : "상세 최대화"}
                >
                  <button
                    type="button"
                    className="icon-button detail-maximize-toggle"
                    aria-label="상세 최대화"
                    aria-pressed={detailMaximized}
                    onClick={onToggleMaximize}
                  >
                    {detailMaximized ? (
                      <Minimize2 size={16} />
                    ) : (
                      <Maximize2 size={16} />
                    )}
                  </button>
                </IconTooltip>
                <IconTooltip label="브라우저에서 열기">
                  <button
                    className="icon-button"
                    type="button"
                    aria-label="Open in browser"
                    onClick={() => onOpenInBrowser(notification)}
                  >
                    <Globe size={16} />
                  </button>
                </IconTooltip>
              </TooltipProvider>
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
      </StickyTitle>

      {showSkeleton && (
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

      {detail && (
        <div className="conversation">
          {refreshing && (
            <div className="detail-loading" aria-label="Refreshing conversation">
              <Loader2 size={16} className="spinning" />
              <span>Refreshing…</span>
            </div>
          )}
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
          <CommentThread
            comments={detail.comments}
            subjectAuthor={detail.author}
            onReplySubmit={
              notification.subject.type === "Discussion" ? onQueueReply : undefined
            }
          />
        </div>
      )}

      {canComment && (
        <CommentComposer
          draft={commentDraft}
          online={online}
          canClose={canClose}
          onDraftChange={onCommentDraftChange}
          onSubmit={onQueueComment}
        />
      )}
    </>
  );
}
