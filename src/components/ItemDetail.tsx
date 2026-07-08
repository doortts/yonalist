import { Toggle } from "@base-ui/react/toggle";
import { Bookmark, Globe, Inbox, Loader2, Maximize2, Minimize2 } from "lucide-react";
import { useContext } from "react";
import { GithubConnectionContext } from "../GithubConnectionContext";
import { itemWebUrl } from "../domain/itemLinks";
import type { ItemDocument } from "../domain/types";
import type { UseItemThreadResult } from "../hooks/useItemThread";
import { openExternal } from "../services/browser";
import { timeAgo } from "../timeFormat";
import { CommentComposer, type CommentSubmitAction } from "./CommentComposer";
import { CommentThread, OpeningPost } from "./CommentThread";
import { itemTypeLabel } from "./ItemListPane";
import { LabelChip } from "./LabelChip";
import { StateBadge } from "./StateBadge";
import { StickyTitle } from "./ui/StickyTitle";
import { IconTooltip, TooltipProvider } from "./ui/Tooltip";

interface ItemDetailProps {
  item: ItemDocument | undefined;
  thread: UseItemThreadResult;
  online: boolean;
  commentDraft: string;
  onCommentDraftChange: (draft: string) => void;
  onQueueComment: (action: CommentSubmitAction) => void;
  onToggleFavorite: () => void;
  /** Whether the detail pane is maximized (drives the inline toggle glyph). */
  detailMaximized: boolean;
  /** Toggles the maximized layout from the inline header control. */
  onToggleMaximize: () => void;
  /** Lifts the header's on-screen state so the app can move the maximize
   * control between this inline slot and the fixed titlebar corner. */
  onHeaderVisibilityChange: (headerVisible: boolean) => void;
}

export function ItemDetail({
  item,
  thread,
  online,
  commentDraft,
  onCommentDraftChange,
  onQueueComment,
  onToggleFavorite,
  detailMaximized,
  onToggleMaximize,
  onHeaderVisibilityChange
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
      <StickyTitle
        title={item.frontMatter.title}
        number={item.frontMatter.number}
        onHeaderVisibilityChange={onHeaderVisibilityChange}
      >
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
                    type="button"
                    className="icon-button"
                    aria-label="Open in browser"
                    onClick={() =>
                      void openExternal(itemWebUrl(item, connection.webBaseUrl))
                    }
                  >
                    <Globe size={16} />
                  </button>
                </IconTooltip>
                <IconTooltip
                  label={
                    item.frontMatter.local.favorite
                      ? "Remove from favorites"
                      : "Add to favorites"
                  }
                >
                  <Toggle
                    className={(state) =>
                      state.pressed ? "favorite-button active" : "favorite-button"
                    }
                    aria-label="Toggle favorite"
                    pressed={item.frontMatter.local.favorite}
                    onPressedChange={() => onToggleFavorite()}
                  >
                    <Bookmark size={18} fill="currentColor" />
                  </Toggle>
                </IconTooltip>
              </TooltipProvider>
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
      </StickyTitle>

      <div className="conversation">
        <OpeningPost
          author={{
            login: item.frontMatter.author,
            name: thread.thread?.authorName,
            avatarUrl: thread.thread?.authorAvatarUrl,
            association: thread.thread?.authorAssociation,
            loading: thread.loading
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
        {thread.thread?.commentsError && (
          <p className="notifications-error detail-error">
            Comments could not be loaded. Check the connection and reopen this
            item to retry.
          </p>
        )}

        <CommentThread comments={comments} subjectAuthor={item.frontMatter.author} />
      </div>

      {item.frontMatter.number > 0 && (
        <CommentComposer
          draft={commentDraft}
          online={online}
          canClose={item.frontMatter.kind === "issue" && state === "open"}
          onDraftChange={onCommentDraftChange}
          onSubmit={onQueueComment}
        />
      )}
    </>
  );
}
