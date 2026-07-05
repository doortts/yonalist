import { Bookmark, Globe, Inbox, Loader2, Send } from "lucide-react";
import { type FormEvent, useContext } from "react";
import { GithubConnectionContext } from "../GithubConnectionContext";
import { itemWebUrl } from "../domain/itemLinks";
import type { ItemDocument } from "../domain/types";
import type { UseItemThreadResult } from "../hooks/useItemThread";
import { openExternal } from "../services/browser";
import { timeAgo } from "../timeFormat";
import { CommentThread, OpeningPost } from "./CommentThread";
import { itemTypeLabel } from "./ItemListPane";
import { LabelChip } from "./LabelChip";
import { StateBadge } from "./StateBadge";

interface ItemDetailProps {
  item: ItemDocument | undefined;
  thread: UseItemThreadResult;
  online: boolean;
  outboxCount: number;
  commentDraft: string;
  onCommentDraftChange: (draft: string) => void;
  onQueueComment: (event: FormEvent) => void;
  onToggleFavorite: () => void;
  onOpenOutbox: () => void;
}

export function ItemDetail({
  item,
  thread,
  online,
  outboxCount,
  commentDraft,
  onCommentDraftChange,
  onQueueComment,
  onToggleFavorite,
  onOpenOutbox
}: ItemDetailProps) {
  const connection = useContext(GithubConnectionContext);

  if (!item) {
    return (
      <div className="detail-empty" aria-label="Empty detail">
        <Inbox size={32} />
        <h2>Nothing selected</h2>
        <p className="empty-copy">Select an item from the list or create a new issue.</p>
      </div>
    );
  }

  // Prefer the live thread state (merged/draft detection) over the listing.
  const state = thread.thread?.state ?? item.frontMatter.state;
  const comments = thread.thread?.comments ?? [];
  // Colored labels from the live thread; fall back to stored front matter.
  const storedLabels = item.frontMatter.labels.map((name) => ({
    name,
    color: item.frontMatter.label_colors?.[name] ?? ""
  }));
  const labels =
    thread.thread?.labels && thread.thread.labels.length > 0
      ? thread.thread.labels
      : storedLabels;

  return (
    <>
      <header className="detail-header">
        <div className="detail-title-row">
          <div>
            <p className="eyebrow">
              {item.frontMatter.owner}/{item.frontMatter.repo} ·{" "}
              {itemTypeLabel(item)} #{item.frontMatter.number || "draft"}
            </p>
            <h2>{item.frontMatter.title}</h2>
          </div>
          <div className="detail-header-actions">
            <button
              type="button"
              className="icon-button"
              aria-label="Open in browser"
              title="브라우저에서 열기"
              onClick={() => void openExternal(itemWebUrl(item, connection.webBaseUrl))}
            >
              <Globe size={16} />
            </button>
            <button
              type="button"
              className={
                item.frontMatter.local.favorite
                  ? "favorite-button active"
                  : "favorite-button"
              }
              aria-label="Toggle favorite"
              aria-pressed={item.frontMatter.local.favorite}
              onClick={onToggleFavorite}
            >
              <Bookmark size={18} fill="currentColor" />
            </button>
            <button className="secondary-button" type="button" onClick={onOpenOutbox}>
              <Inbox size={16} />
              Outbox {outboxCount}
            </button>
          </div>
        </div>
        <div className="detail-actions">
          <StateBadge
            kind={item.frontMatter.kind}
            state={state}
            draft={thread.thread?.draft}
          />
          {labels.map((label) => (
            <LabelChip key={label.name} label={label} />
          ))}
          <span className="chip chip-status">{item.frontMatter.sync.status}</span>
          <span className="detail-connection">
            {comments.length > 0 && `댓글 ${comments.length} · `}
            {online ? "Online" : "Offline queue enabled"}
          </span>
        </div>
      </header>

      <div className="conversation">
        <OpeningPost
          author={{
            login: item.frontMatter.author,
            avatarUrl: thread.thread?.authorAvatarUrl,
            association: thread.thread?.authorAssociation
          }}
          subtitle={`${itemTypeLabel(item)} · ${
            item.frontMatter.created_at
              ? `opened ${timeAgo(item.frontMatter.created_at)}`
              : "conversation"
          }`}
          body={item.body || "No body."}
          reactions={thread.thread?.reactions}
        />

        {thread.loading && (
          <div className="detail-loading" aria-label="Loading comments">
            <Loader2 size={18} className="spinning" />
            <span>Loading comments...</span>
          </div>
        )}
        {thread.error && (
          <p className="notifications-error detail-error">{thread.error}</p>
        )}

        <CommentThread comments={comments} subjectAuthor={item.frontMatter.author} />
      </div>

      <form className="comment-composer" onSubmit={onQueueComment}>
        <textarea
          id="comment-draft"
          aria-label="Write a comment"
          placeholder="Write a comment..."
          value={commentDraft}
          onChange={(event) => onCommentDraftChange(event.target.value)}
        />
        <div className="composer-actions">
          <span>
            {online
              ? "Comments are queued first, then synced."
              : "Offline comment will wait in the outbox."}
          </span>
          <button
            className={online ? "primary-button comment-button" : "primary-button"}
            type="submit"
          >
            <Send size={16} />
            {online ? "Comment" : "Queue comment"}
          </button>
        </div>
      </form>
    </>
  );
}
