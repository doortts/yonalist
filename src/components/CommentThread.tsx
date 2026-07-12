import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useTransition
} from "react";
import {
  authorAssociationLabel,
  type ConversationComment,
  type ReactionSummary
} from "../domain/conversation";
import { timeAgo } from "../timeFormat";
import { Avatar } from "./Avatar";
import { MarkdownBody } from "./MarkdownBody";

function Reactions({ reactions }: { reactions?: ReactionSummary }) {
  if (!reactions || reactions.length === 0) {
    return null;
  }
  return (
    <div className="reactions" aria-label="Reactions">
      {reactions.map((reaction) => (
        <span className="reaction" key={reaction.emoji}>
          <span className="reaction-emoji">{reaction.emoji}</span>
          {reaction.count}
        </span>
      ))}
    </div>
  );
}

interface EntryAuthor {
  login: string;
  name?: string;
  avatarUrl?: string;
  association?: string;
  isAuthor?: boolean;
  loading?: boolean;
}

function AssociationBadge({ author }: { author: EntryAuthor }) {
  const association = authorAssociationLabel(author.association);
  const label = author.isAuthor ? "Author" : association;
  if (!label) {
    return null;
  }
  return <span className="comment-association">{label}</span>;
}

function HeaderMeta({ author, meta }: { author: EntryAuthor; meta: string }) {
  const hasDisplayName = Boolean(author.name && author.name !== author.login);
  const displayName = hasDisplayName ? author.name : author.login;
  const showAuthorSkeleton = Boolean(author.loading && !author.name);

  return (
    <>
      <span className="comment-author-cluster">
        {showAuthorSkeleton ? (
          <span
            className="comment-author-skeleton"
            aria-label={`Loading author for ${author.login}`}
          />
        ) : (
          <>
            <strong
              className="comment-author"
              title={hasDisplayName ? author.login : undefined}
            >
              {displayName}
            </strong>
            <AssociationBadge author={author} />
          </>
        )}
      </span>
      <span className="comment-time">{meta}</span>
    </>
  );
}

function AuthorIdentity({ author }: { author: EntryAuthor }) {
  const hasDisplayName = Boolean(author.name && author.name !== author.login);
  const displayName = hasDisplayName ? author.name : author.login;

  return (
    <span className="comment-author-cluster">
      <strong
        className="comment-author"
        title={hasDisplayName ? author.login : undefined}
      >
        {displayName}
      </strong>
      <AssociationBadge author={author} />
    </span>
  );
}

function EntryMeta({ author, meta }: { author: EntryAuthor; meta: string }) {
  return (
    <>
      <span className="entry-avatar-slot">
        <Avatar
          login={author.login}
          avatarUrl={author.avatarUrl}
          size={20}
          showFallback={false}
          loading={author.loading}
        />
      </span>
      <HeaderMeta author={author} meta={meta} />
    </>
  );
}

interface OpeningPostProps {
  author: EntryAuthor;
  subtitle: string;
  body: string;
  reactions?: ReactionSummary;
}

/**
 * The opening issue/PR/discussion post — rendered full width, outside the
 * comment timeline, like GitHub's first conversation item.
 */
export function OpeningPost({ author, subtitle, body, reactions }: OpeningPostProps) {
  return (
    <article className="opening-post">
      <header className="opening-post-header">
        <EntryMeta author={author} meta={subtitle} />
      </header>
      <div className="opening-post-body">
        <MarkdownBody body={body} />
        <Reactions reactions={reactions} />
      </div>
    </article>
  );
}

interface CommentThreadProps {
  comments: ConversationComment[];
  /** The opening post's author, so replies by them get an "Author" badge. */
  subjectAuthor?: string;
  replyDraft?: CommentReplyDraft;
  /**
   * Called for GitHub Discussion replies. The parent must carry a GraphQL
   * node id; Issue/PR comments do not have a remote nested-reply endpoint.
   */
  onReplySubmit?: (parent: ConversationComment, body: string) => void;
}

export interface CommentReplyDraft {
  parentId?: number | string;
  parentNodeId?: string;
  body: string;
  version: number;
}

interface InlineReplyComposerProps {
  initialBody?: string;
  onCancel: () => void;
  onSubmit: (body: string) => void;
}

function InlineReplyComposer({
  initialBody = "",
  onCancel,
  onSubmit
}: InlineReplyComposerProps) {
  const [body, setBody] = useState(initialBody);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const hasBody = body.trim().length > 0;

  useEffect(() => {
    setBody(initialBody);
  }, [initialBody]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [body]);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) {
      return;
    }
    onSubmit(trimmed);
    setBody("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form className="inline-reply-composer" onSubmit={submit}>
      <textarea
        ref={textareaRef}
        aria-label="대댓글 입력"
        placeholder="대댓글 추가 (⌘ + ENTER)"
        rows={1}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={handleKeyDown}
        autoFocus
      />
      <button type="submit" disabled={!hasBody}>
        OK
      </button>
    </form>
  );
}

function matchesReplyDraft(
  comment: ConversationComment,
  draft: CommentReplyDraft
) {
  const parentId =
    draft.parentId === undefined ? undefined : String(draft.parentId);
  return (
    (parentId !== undefined && String(comment.id) === parentId) ||
    (draft.parentNodeId !== undefined && comment.nodeId === draft.parentNodeId)
  );
}

function findReplyDraftAnchor(
  comments: ConversationComment[],
  draft: CommentReplyDraft
): { anchor: ConversationComment; target: ConversationComment } | null {
  function findInReplies(
    replies: ConversationComment[] | undefined
  ): ConversationComment | null {
    for (const reply of replies ?? []) {
      if (matchesReplyDraft(reply, draft)) {
        return reply;
      }
      const nested = findInReplies(reply.replies);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  for (const comment of comments) {
    if (matchesReplyDraft(comment, draft)) {
      return { anchor: comment, target: comment };
    }
    const reply = findInReplies(comment.replies);
    if (reply) {
      return { anchor: reply, target: comment };
    }
  }
  return null;
}

// Top-level comments mounted per batch. The first batch renders in the
// selection's commit; the rest stream in one batch per frame inside a
// transition, so a very long conversation never builds its entire comment DOM
// in a single synchronous commit. Typical threads fit in the first batch and
// mount exactly as before.
const COMMENT_MOUNT_BATCH = 30;

function requestMountFrame(callback: () => void): () => void {
  if (typeof window !== "undefined" && window.requestAnimationFrame) {
    const frame = window.requestAnimationFrame(() => callback());
    return () => window.cancelAnimationFrame(frame);
  }
  const timer = window.setTimeout(callback, 0);
  return () => window.clearTimeout(timer);
}

/**
 * Reply comments rendered as a GitHub-style timeline: each reply shows the
 * author's avatar in a left gutter beside a bordered speech bubble whose tail
 * points back at the avatar.
 *
 * Callers key this component by conversation (item path / notification id) so
 * the incremental mount count resets when the user opens a different
 * conversation but survives same-conversation refreshes.
 */
export function CommentThread({
  comments,
  subjectAuthor,
  replyDraft,
  onReplySubmit
}: CommentThreadProps) {
  const [activeReplyId, setActiveReplyId] = useState<string | null>(null);
  const [activeReplyDraftBody, setActiveReplyDraftBody] = useState("");
  const [, startMountTransition] = useTransition();
  // Grow-only: revalidations that append comments schedule further batches;
  // shrinking threads are simply capped by slice below.
  const [mountedCount, setMountedCount] = useState(() =>
    Math.min(COMMENT_MOUNT_BATCH, comments.length)
  );

  useEffect(() => {
    if (mountedCount >= comments.length) {
      return;
    }
    return requestMountFrame(() => {
      startMountTransition(() => {
        setMountedCount((current) =>
          Math.min(current + COMMENT_MOUNT_BATCH, comments.length)
        );
      });
    });
  }, [mountedCount, comments.length, startMountTransition]);

  useEffect(() => {
    if (!replyDraft || !onReplySubmit) {
      return;
    }
    const match = findReplyDraftAnchor(comments, replyDraft);
    if (!match || !match.target.nodeId) {
      return;
    }
    setActiveReplyId(match.anchor.id);
    setActiveReplyDraftBody(replyDraft.body);
    // replyDraft is rebuilt each render; depend on its fields (already listed)
    // rather than the object so an identity churn does not clobber active edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    comments,
    onReplySubmit,
    replyDraft?.body,
    replyDraft?.parentId,
    replyDraft?.parentNodeId,
    replyDraft?.version
  ]);

  if (comments.length === 0) {
    return null;
  }

  function authorForComment(comment: ConversationComment): EntryAuthor {
    return {
      login: comment.author,
      name: comment.authorName,
      avatarUrl: comment.avatarUrl,
      association: comment.authorAssociation,
      isAuthor: Boolean(subjectAuthor) && comment.author === subjectAuthor
    };
  }

  function commentMeta(comment: ConversationComment) {
    return comment.created_at
      ? `commented ${timeAgo(comment.created_at)}`
      : "commented";
  }

  function canReplyTo(comment: ConversationComment) {
    return Boolean(onReplySubmit && comment.nodeId);
  }

  function renderReplyAction(
    comment: ConversationComment,
    target: ConversationComment = comment
  ) {
    if (!canReplyTo(target)) {
      return null;
    }
    return (
      <div className="comment-hover-actions">
        <button
          type="button"
          className="comment-inline-reply-button"
          onClick={() => {
            setActiveReplyDraftBody("");
            setActiveReplyId(comment.id);
          }}
        >
          대댓글 추가
        </button>
      </div>
    );
  }

  function renderInlineReplyComposer(
    comment: ConversationComment,
    target: ConversationComment = comment
  ) {
    if (activeReplyId !== comment.id || !canReplyTo(target) || !onReplySubmit) {
      return null;
    }
    return (
      <InlineReplyComposer
        initialBody={activeReplyId === comment.id ? activeReplyDraftBody : ""}
        onCancel={() => {
          setActiveReplyDraftBody("");
          setActiveReplyId(null);
        }}
        onSubmit={(body) => {
          onReplySubmit(target, body);
          setActiveReplyDraftBody("");
          setActiveReplyId(null);
        }}
      />
    );
  }

  function renderReplyThread(
    replies: ConversationComment[],
    target: ConversationComment
  ) {
    return (
      <div className="comment-replies" aria-label="Replies">
        {replies.map((reply, index) => {
          const previous = replies[index - 1];
          const compact = Boolean(previous && previous.author === reply.author);
          const author = authorForComment(reply);
          return (
            <article
              className={
                compact
                  ? "comment-reply-card is-compact"
                  : "comment-reply-card"
              }
              key={reply.id}
            >
              {!compact && (
                <span className="comment-reply-author-row">
                  <span className="comment-reply-avatar">
                    <Avatar
                      login={reply.author}
                      avatarUrl={reply.avatarUrl}
                      size={32}
                    />
                  </span>
                  <AuthorIdentity author={author} />
                </span>
              )}
              <div className="comment-reply-bubble">
                <header className="comment-reply-header">
                  <span className="comment-reply-time">
                    {reply.created_at ? timeAgo(reply.created_at) : "now"}
                  </span>
                </header>
                <div className="comment-reply-body">
                  <MarkdownBody body={reply.body} />
                  <Reactions reactions={reply.reactions} />
                </div>
                {renderReplyAction(reply, target)}
              </div>
              {renderInlineReplyComposer(reply, target)}
              {reply.replies && reply.replies.length > 0 && (
                renderReplyThread(reply.replies, target)
              )}
            </article>
          );
        })}
      </div>
    );
  }

  function renderComment(comment: ConversationComment) {
    const author: EntryAuthor = {
      login: comment.author,
      name: comment.authorName,
      avatarUrl: comment.avatarUrl,
      association: comment.authorAssociation,
      isAuthor: Boolean(subjectAuthor) && comment.author === subjectAuthor
    };
    return (
      <article className="comment-item" key={comment.id}>
        <Avatar login={comment.author} avatarUrl={comment.avatarUrl} size={40} />
        <div className="comment-stack">
          <div className="comment-bubble">
            <header className="comment-header">
              <HeaderMeta author={author} meta={commentMeta(comment)} />
            </header>
            <div className="comment-body">
              <MarkdownBody body={comment.body} />
              <Reactions reactions={comment.reactions} />
            </div>
            {renderReplyAction(comment)}
          </div>
          {renderInlineReplyComposer(comment)}
          {comment.replies && comment.replies.length > 0 && (
            renderReplyThread(comment.replies, comment)
          )}
        </div>
      </article>
    );
  }
  const visibleComments =
    mountedCount >= comments.length ? comments : comments.slice(0, mountedCount);
  return (
    <section className="comment-thread" aria-label="Comments">
      {visibleComments.map((comment) => renderComment(comment))}
    </section>
  );
}
