import {
  authorAssociationLabel,
  type ConversationComment
} from "../domain/conversation";
import { timeAgo } from "../timeFormat";
import { Avatar } from "./Avatar";
import { MarkdownBody } from "./MarkdownBody";

interface CommentAuthor {
  login: string;
  avatarUrl?: string;
  association?: string;
  isAuthor?: boolean;
}

interface ConversationEntryProps {
  author: CommentAuthor;
  timestamp?: string;
  subtitle?: string;
  body: string;
}

function AssociationBadge({
  author
}: {
  author: CommentAuthor;
}) {
  const association = authorAssociationLabel(author.association);
  const label = author.isAuthor ? "Author" : association;
  if (!label) {
    return null;
  }
  return <span className="comment-association">{label}</span>;
}

/**
 * A single timeline entry (the opening post or a comment) rendered like a
 * GitHub conversation card: an avatar on the timeline, a header bar with the
 * author, association badge and time, and the sanitized markdown body.
 */
export function ConversationEntry({
  author,
  timestamp,
  subtitle,
  body
}: ConversationEntryProps) {
  return (
    <article className="comment-item">
      <Avatar login={author.login} avatarUrl={author.avatarUrl} size={40} />
      <div className="comment-bubble">
        <header className="comment-header">
          <strong className="comment-author">{author.login}</strong>
          <AssociationBadge author={author} />
          <span className="comment-time">
            {subtitle ? subtitle : timestamp ? `commented ${timeAgo(timestamp)}` : ""}
          </span>
        </header>
        <div className="comment-body">
          <MarkdownBody body={body} />
        </div>
      </div>
    </article>
  );
}

interface CommentThreadProps {
  comments: ConversationComment[];
  /** The opening post's author, so replies by them get an "Author" badge. */
  subjectAuthor?: string;
}

/** The list of reply comments below the opening post. */
export function CommentThread({ comments, subjectAuthor }: CommentThreadProps) {
  if (comments.length === 0) {
    return null;
  }
  return (
    <section className="comment-thread" aria-label="Comments">
      {comments.map((comment) => (
        <ConversationEntry
          key={comment.id}
          author={{
            login: comment.author,
            avatarUrl: comment.avatarUrl,
            association: comment.authorAssociation,
            isAuthor: Boolean(subjectAuthor) && comment.author === subjectAuthor
          }}
          timestamp={comment.created_at}
          body={comment.body}
        />
      ))}
    </section>
  );
}
