import { Bookmark, Globe, Inbox, Loader2, Send } from "lucide-react";
import { type FormEvent, useContext } from "react";
import { GithubConnectionContext } from "../GithubConnectionContext";
import { itemWebUrl } from "../domain/itemLinks";
import type { ItemDocument } from "../domain/types";
import type { UseItemThreadResult } from "../hooks/useItemThread";
import { openExternal } from "../services/browser";
import { timeAgo } from "../timeFormat";
import { itemTypeLabel } from "./ItemListPane";
import { MarkdownBody } from "./MarkdownBody";

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
          <span className={`chip chip-state-${state}`}>{state}</span>
          {thread.thread?.draft && <span className="chip chip-state-draft">draft</span>}
          {item.frontMatter.labels.map((label) => (
            <span className="chip" key={label}>
              {label}
            </span>
          ))}
          <span className="chip chip-status">{item.frontMatter.sync.status}</span>
          <span className="detail-connection">
            {comments.length > 0 && `댓글 ${comments.length} · `}
            {online ? "Online" : "Offline queue enabled"}
          </span>
        </div>
      </header>

      <article className="content-panel">
        <div className="author-row">
          <span className="avatar">
            {item.frontMatter.author.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <strong>{item.frontMatter.author}</strong>
            <p>
              {itemTypeLabel(item)} conversation
              {item.frontMatter.created_at
                ? ` · ${timeAgo(item.frontMatter.created_at)}`
                : ""}
            </p>
          </div>
        </div>
        <MarkdownBody body={item.body || "No body."} />
      </article>

      {thread.loading && (
        <div className="detail-loading" aria-label="Loading comments">
          <Loader2 size={18} className="spinning" />
          <span>Loading comments...</span>
        </div>
      )}
      {thread.error && <p className="notifications-error detail-error">{thread.error}</p>}

      {comments.length > 0 && (
        <section className="notification-comments" aria-label="Comments">
          {comments.map((comment) => (
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
              <MarkdownBody body={comment.body} />
            </article>
          ))}
        </section>
      )}

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
