import {
  summarizeReactions,
  type ConversationComment,
  type GitHubLabel,
  type ReactionSummary
} from "../domain/conversation";
import { subjectNumber, type GitHubNotification } from "../domain/notifications";
import { createGitHubClient } from "./github";

export type { ConversationComment as NotificationComment } from "../domain/conversation";

export interface NotificationDetailContent {
  title: string;
  state: string;
  author: string;
  authorAvatarUrl?: string;
  authorAssociation?: string;
  created_at?: string;
  body: string;
  labels: GitHubLabel[];
  reactions?: ReactionSummary;
  comments: ConversationComment[];
}

interface UserResponse {
  login?: string;
  avatar_url?: string;
}

interface LabelResponse {
  name?: string;
  color?: string;
}

interface IssueResponse {
  title?: string;
  state?: string;
  body?: string | null;
  user?: UserResponse;
  labels?: Array<LabelResponse | string>;
  author_association?: string;
  reactions?: Record<string, unknown>;
  created_at?: string;
  merged_at?: string | null;
}

interface CommentResponse {
  id?: number | string;
  body?: string | null;
  user?: UserResponse;
  author_association?: string;
  reactions?: Record<string, unknown>;
  created_at?: string;
}

interface ReleaseResponse {
  name?: string | null;
  tag_name?: string;
  body?: string | null;
  author?: UserResponse;
  created_at?: string;
  published_at?: string;
}

export interface FetchNotificationDetailOptions {
  token: string;
  apiBaseUrl: string;
  webBaseUrl: string;
  notification: GitHubNotification;
  fetchImpl?: typeof fetch;
}

function mapLabels(labels: Array<LabelResponse | string> | undefined): GitHubLabel[] {
  return (labels ?? [])
    .map((label) =>
      typeof label === "string"
        ? { name: label, color: "" }
        : { name: label.name ?? "", color: label.color ?? "" }
    )
    .filter((label) => label.name);
}

function mapComments(comments: CommentResponse[]): ConversationComment[] {
  return comments.map((comment) => ({
    id: String(comment.id ?? ""),
    author: comment.user?.login ?? "unknown",
    avatarUrl: comment.user?.avatar_url,
    authorAssociation: comment.author_association,
    created_at: comment.created_at ?? "",
    body: comment.body ?? "",
    reactions: summarizeReactions(comment.reactions)
  }));
}

/**
 * Loads the conversation behind a notification through the GitHub REST API,
 * normalized so the detail pane can render every subject type the same way.
 */
export async function fetchNotificationDetail(
  options: FetchNotificationDetailOptions
): Promise<NotificationDetailContent> {
  const { notification } = options;
  const client = createGitHubClient({
    token: options.token,
    apiBaseUrl: options.apiBaseUrl,
    webBaseUrl: options.webBaseUrl,
    fetch: options.fetchImpl
  });
  const owner = notification.repository.owner.login;
  const repo = notification.repository.name;
  const number = subjectNumber(notification.subject);

  if (notification.subject.type === "Release") {
    if (number === null) {
      throw new Error("Release notification is missing a release id.");
    }
    const release = (await client.getRelease(owner, repo, number)) as ReleaseResponse;
    return {
      title: release.name || release.tag_name || notification.subject.title,
      state: release.tag_name ?? "release",
      author: release.author?.login ?? "unknown",
      authorAvatarUrl: release.author?.avatar_url,
      created_at: release.published_at ?? release.created_at,
      body: release.body ?? "",
      labels: [],
      comments: []
    };
  }

  if (number === null) {
    throw new Error("Notification is missing a subject number.");
  }

  if (notification.subject.type === "Discussion") {
    const { discussion, comments } = (await client.getDiscussionWithComments(
      owner,
      repo,
      number
    )) as { discussion: IssueResponse; comments: CommentResponse[] };
    return {
      title: discussion.title ?? notification.subject.title,
      state: discussion.state ?? "open",
      author: discussion.user?.login ?? "unknown",
      authorAvatarUrl: discussion.user?.avatar_url,
      authorAssociation: discussion.author_association,
      created_at: discussion.created_at,
      body: discussion.body ?? "",
      labels: mapLabels(discussion.labels),
      reactions: summarizeReactions(discussion.reactions),
      comments: mapComments(comments)
    };
  }

  const isPull = notification.subject.type === "PullRequest";
  const [item, comments] = await Promise.all([
    (isPull
      ? client.getPull(owner, repo, number)
      : client.getIssue(owner, repo, number)) as Promise<IssueResponse>,
    client.listIssueComments(owner, repo, number).catch(() => []) as Promise<
      CommentResponse[]
    >
  ]);

  return {
    title: item.title ?? notification.subject.title,
    state: isPull && item.merged_at ? "merged" : item.state ?? "open",
    author: item.user?.login ?? "unknown",
    authorAvatarUrl: item.user?.avatar_url,
    authorAssociation: item.author_association,
    created_at: item.created_at,
    body: item.body ?? "",
    labels: mapLabels(item.labels),
    reactions: summarizeReactions(item.reactions),
    comments: mapComments(comments)
  };
}
