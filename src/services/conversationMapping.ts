import {
  summarizeReactions,
  type ConversationComment,
  type GitHubLabel
} from "../domain/conversation";
import { displayNameForLogin, type UserProfile } from "./userProfiles";

/**
 * Shared GitHub REST response shapes and mapping helpers used by both the item
 * thread and notification detail services. Each service keeps only its own
 * subject-specific response types (StateResponse, IssueResponse, ...) and its
 * subject-type dispatch; everything below was byte-for-byte duplicated.
 */

export interface UserResponse {
  login?: string;
  name?: string | null;
  avatar_url?: string;
}

export interface LabelResponse {
  name?: string;
  color?: string;
}

export interface CommentResponse {
  id?: number | string;
  node_id?: string;
  body?: string | null;
  user?: UserResponse;
  author_association?: string;
  reactions?: Record<string, unknown>;
  created_at?: string;
  replies?: CommentResponse[];
}

export type ProfileMap = Record<string, UserProfile>;

export function mapLabels(
  labels: Array<LabelResponse | string> | undefined
): GitHubLabel[] {
  return (labels ?? [])
    .map((label) =>
      typeof label === "string"
        ? { name: label, color: "" }
        : { name: label.name ?? "", color: label.color ?? "" }
    )
    .filter((label) => label.name);
}

export function displayNameForUser(
  user: UserResponse | undefined,
  profiles: ProfileMap
): string | undefined {
  const login = user?.login;
  const inlineName = user?.name?.trim();
  if (inlineName && inlineName !== login) {
    return inlineName;
  }
  return displayNameForLogin(profiles, login);
}

export function loginNeedingProfile(
  user: UserResponse | undefined
): string | undefined {
  const login = user?.login;
  if (!login || login === "unknown") {
    return undefined;
  }
  const inlineName = user.name?.trim();
  return inlineName && inlineName !== login ? undefined : login;
}

/**
 * Maps raw comment responses (with nested replies) to conversation comments.
 * The leading `Array.isArray` guard comes from itemThread's copy: it is
 * strictly more defensive than notificationDetail's old version, and since
 * notificationDetail only ever passes real arrays the behavior is identical.
 */
export function mapComments(
  comments: CommentResponse[],
  profiles: ProfileMap = {}
): ConversationComment[] {
  if (!Array.isArray(comments)) {
    return [];
  }
  return comments.map((comment) => {
    const authorName = displayNameForUser(comment.user, profiles);
    const replies = mapComments(comment.replies ?? [], profiles);
    return {
      id: String(comment.id ?? ""),
      ...(comment.node_id ? { nodeId: String(comment.node_id) } : {}),
      author: comment.user?.login ?? "unknown",
      ...(authorName ? { authorName } : {}),
      avatarUrl: comment.user?.avatar_url,
      authorAssociation: comment.author_association,
      created_at: comment.created_at ?? "",
      body: comment.body ?? "",
      reactions: summarizeReactions(comment.reactions),
      ...(replies.length > 0 ? { replies } : {})
    };
  });
}
