import type { CommentDocument } from "./types";

export function sortCommentsByTimeline(
  comments: CommentDocument[]
): CommentDocument[] {
  return [...comments].sort((left, right) => {
    const leftTime = new Date(left.frontMatter.created_at).valueOf();
    const rightTime = new Date(right.frontMatter.created_at).valueOf();
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return (left.frontMatter.remote_id ?? 0) - (right.frontMatter.remote_id ?? 0);
  });
}
