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
}

/**
 * Reply comments rendered as a GitHub-style timeline: each reply shows the
 * author's avatar in a left gutter beside a bordered speech bubble whose tail
 * points back at the avatar.
 */
export function CommentThread({ comments, subjectAuthor }: CommentThreadProps) {
  if (comments.length === 0) {
    return null;
  }
  function renderComment(comment: ConversationComment, nested = false) {
    const author: EntryAuthor = {
      login: comment.author,
      name: comment.authorName,
      avatarUrl: comment.avatarUrl,
      association: comment.authorAssociation,
      isAuthor: Boolean(subjectAuthor) && comment.author === subjectAuthor
    };
    return (
      <article
        className={nested ? "comment-item comment-item-reply" : "comment-item"}
        key={comment.id}
      >
        <Avatar login={comment.author} avatarUrl={comment.avatarUrl} size={nested ? 32 : 40} />
        <div className="comment-stack">
          <div className="comment-bubble">
            <header className="comment-header">
              <HeaderMeta
                author={author}
                meta={
                  comment.created_at
                    ? `commented ${timeAgo(comment.created_at)}`
                    : "commented"
                }
              />
            </header>
            <div className="comment-body">
              <MarkdownBody body={comment.body} />
              <Reactions reactions={comment.reactions} />
            </div>
          </div>
          {comment.replies && comment.replies.length > 0 && (
            <div className="comment-replies" aria-label="Replies">
              {comment.replies.map((reply) => renderComment(reply, true))}
            </div>
          )}
        </div>
      </article>
    );
  }
  return (
    <section className="comment-thread" aria-label="Comments">
      {comments.map((comment) => renderComment(comment))}
    </section>
  );
}
