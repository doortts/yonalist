import { Bookmark, Inbox, Send } from "lucide-react";
import type { FormEvent } from "react";
import type { ItemDocument } from "../domain/types";
import { renderMarkdown } from "../markdownRender";
import { itemTypeLabel } from "./ItemListPane";

interface ItemDetailProps {
  item: ItemDocument | undefined;
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
  online,
  outboxCount,
  commentDraft,
  onCommentDraftChange,
  onQueueComment,
  onToggleFavorite,
  onOpenOutbox
}: ItemDetailProps) {
  if (!item) {
    return (
      <div className="detail-empty" aria-label="Empty detail">
        <Inbox size={32} />
        <h2>Nothing selected</h2>
        <p className="empty-copy">Select an item from the list or create a new issue.</p>
      </div>
    );
  }

  return (
    <>
      <header className="detail-header">
        <div className="bookmark-strip">
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
            <Bookmark size={25} fill="currentColor" />
          </button>
          <span className="number-ribbon">#</span>
        </div>
        <div className="detail-title-row">
          <div>
            <p className="eyebrow">
              {item.frontMatter.owner}/{item.frontMatter.repo}
            </p>
            <h2>{item.frontMatter.title}</h2>
          </div>
          <button className="secondary-button" type="button" onClick={onOpenOutbox}>
            <Inbox size={16} />
            Outbox {outboxCount}
          </button>
        </div>
        <div className="detail-actions">
          <span>{item.frontMatter.labels.join(", ") || "No labels"}</span>
          <span>{item.frontMatter.sync.status}</span>
          <span>{online ? "Online" : "Offline queue enabled"}</span>
        </div>
      </header>

      <article className="content-panel">
        <div className="author-row">
          <span className="avatar">
            {item.frontMatter.author.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <strong>{item.frontMatter.author}</strong>
            <p>{itemTypeLabel(item)} conversation</p>
          </div>
        </div>
        <div
          className="markdown-body"
          dangerouslySetInnerHTML={renderMarkdown(item.body || "No body.")}
        />
      </article>

      <form className="comment-composer" onSubmit={onQueueComment}>
        <label htmlFor="comment-draft">Write a comment</label>
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
          <button className="primary-button" type="submit">
            <Send size={16} />
            Queue comment
          </button>
        </div>
      </form>
    </>
  );
}
