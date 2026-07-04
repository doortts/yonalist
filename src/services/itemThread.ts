import type {
  ConversationComment,
  GitHubLabel
} from "../domain/conversation";
import type { ItemKind, ItemState } from "../domain/types";
import type { GithubConnection } from "../hooks/useGithubAuth";
import { createGitHubClient } from "./github";

export interface ItemThread {
  state: ItemState;
  /** Pull requests only: still marked as a draft. */
  draft: boolean;
  authorAvatarUrl?: string;
  authorAssociation?: string;
  labels: GitHubLabel[];
  comments: ConversationComment[];
}

export interface ItemThreadTarget {
  kind: ItemKind;
  owner: string;
  repo: string;
  number: number;
}

interface UserResponse {
  login?: string;
  avatar_url?: string;
}

interface LabelResponse {
  name?: string;
  color?: string;
}

interface StateResponse {
  state?: string;
  merged_at?: string | null;
  draft?: boolean;
  user?: UserResponse;
  author_association?: string;
  labels?: Array<LabelResponse | string>;
}

interface CommentResponse {
  id?: number | string;
  body?: string | null;
  user?: UserResponse;
  author_association?: string;
  created_at?: string;
}

function normalizeState(state: string | undefined): ItemState {
  return state === "closed" || state === "merged" ? state : "open";
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
  if (!Array.isArray(comments)) {
    return [];
  }
  return comments.map((comment) => ({
    id: String(comment.id ?? ""),
    author: comment.user?.login ?? "unknown",
    avatarUrl: comment.user?.avatar_url,
    authorAssociation: comment.author_association,
    created_at: comment.created_at ?? "",
    body: comment.body ?? ""
  }));
}

function threadFrom(item: StateResponse, comments: CommentResponse[], state: ItemState): ItemThread {
  return {
    state,
    draft: Boolean(item.draft),
    authorAvatarUrl: item.user?.avatar_url,
    authorAssociation: item.author_association,
    labels: mapLabels(item.labels),
    comments: mapComments(comments)
  };
}

/**
 * Loads the live conversation for a work item: refined state (merged/draft
 * for pull requests), labels, author, and the comment thread.
 */
export async function fetchItemThread(
  connection: GithubConnection,
  target: ItemThreadTarget
): Promise<ItemThread> {
  const client = createGitHubClient({
    token: connection.token,
    apiBaseUrl: connection.apiBaseUrl,
    webBaseUrl: connection.webBaseUrl
  });
  const { owner, repo, number } = target;

  if (target.kind === "discussion") {
    const { discussion, comments } = (await client.getDiscussionWithComments(
      owner,
      repo,
      number
    )) as { discussion: StateResponse; comments: CommentResponse[] };
    return threadFrom(discussion, comments, normalizeState(discussion.state));
  }

  if (target.kind === "pull") {
    const [pull, comments] = await Promise.all([
      client.getPull(owner, repo, number) as Promise<StateResponse>,
      client
        .listIssueComments(owner, repo, number)
        .catch(() => []) as Promise<CommentResponse[]>
    ]);
    return threadFrom(
      pull,
      comments,
      pull.merged_at ? "merged" : normalizeState(pull.state)
    );
  }

  const [issue, comments] = await Promise.all([
    client.getIssue(owner, repo, number) as Promise<StateResponse>,
    client
      .listIssueComments(owner, repo, number)
      .catch(() => []) as Promise<CommentResponse[]>
  ]);
  return threadFrom(issue, comments, normalizeState(issue.state));
}
