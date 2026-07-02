import { subjectNumber, type GitHubNotification } from "../domain/notifications";
import { createGitHubClient } from "./github";

export interface NotificationComment {
  id: string;
  author: string;
  created_at: string;
  body: string;
}

export interface NotificationDetailContent {
  title: string;
  state: string;
  author: string;
  created_at?: string;
  body: string;
  labels: string[];
  comments: NotificationComment[];
}

interface UserResponse {
  login?: string;
}

interface LabelResponse {
  name?: string;
}

interface IssueResponse {
  title?: string;
  state?: string;
  body?: string | null;
  user?: UserResponse;
  labels?: Array<LabelResponse | string>;
  created_at?: string;
  merged_at?: string | null;
}

interface CommentResponse {
  id?: number | string;
  body?: string | null;
  user?: UserResponse;
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

function labelNames(labels: Array<LabelResponse | string> | undefined): string[] {
  return (labels ?? [])
    .map((label) => (typeof label === "string" ? label : label.name ?? ""))
    .filter(Boolean);
}

function mapComments(comments: CommentResponse[]): NotificationComment[] {
  return comments.map((comment) => ({
    id: String(comment.id ?? ""),
    author: comment.user?.login ?? "unknown",
    created_at: comment.created_at ?? "",
    body: comment.body ?? ""
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
    const [discussion, comments] = await Promise.all([
      client.getDiscussion(owner, repo, number) as Promise<IssueResponse>,
      client
        .listDiscussionComments(owner, repo, number)
        .catch(() => []) as Promise<CommentResponse[]>
    ]);
    return {
      title: discussion.title ?? notification.subject.title,
      state: discussion.state ?? "open",
      author: discussion.user?.login ?? "unknown",
      created_at: discussion.created_at,
      body: discussion.body ?? "",
      labels: labelNames(discussion.labels),
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
    created_at: item.created_at,
    body: item.body ?? "",
    labels: labelNames(item.labels),
    comments: mapComments(comments)
  };
}
