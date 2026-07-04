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
  avatarUrl?: string;
  association?: string;
  isAuthor?: boolean;
}

function AssociationBadge({ author }: { author: EntryAuthor }) {
  const association = authorAssociationLabel(author.association);
  const label = author.isAuthor ? "Author" : association;
  if (!label) {
    return null;
  }
  return <span className="comment-association">{label}</span>;
}

function EntryMeta({ author, meta }: { author: EntryAuthor; meta: string }) {
  return (
    <>
      <Avatar
        login={author.login}
        avatarUrl={author.avatarUrl}
        size={20}
        showFallback={false}
      />
      <strong className="comment-author">{author.login}</strong>
      <AssociationBadge author={author} />
      <span className="comment-time">{meta}</span>
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
 * Reply comments rendered as a GitHub-style timeline: a vertical line with a
 * node dot per comment and a bordered card holding a header and body. No
 * initial-letter avatars sit on the line.
 */
export function CommentThread({ comments, subjectAuthor }: CommentThreadProps) {
  if (comments.length === 0) {
    return null;
  }
  return (
    <section className="comment-thread" aria-label="Comments">
      {comments.map((comment) => (
        <article className="comment-item" key={comment.id}>
          <div className="comment-bubble">
            <header className="comment-header">
              <EntryMeta
                author={{
                  login: comment.author,
                  avatarUrl: comment.avatarUrl,
                  association: comment.authorAssociation,
                  isAuthor:
                    Boolean(subjectAuthor) && comment.author === subjectAuthor
                }}
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
        </article>
      ))}
    </section>
  );
}
