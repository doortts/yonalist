import type { ItemKind, ItemState } from "../domain/types";
import type { GithubConnection } from "../hooks/useGithubAuth";
import { createGitHubClient } from "./github";
import type { NotificationComment } from "./notificationDetail";

export interface ItemThread {
  state: ItemState;
  /** Pull requests only: still marked as a draft. */
  draft: boolean;
  comments: NotificationComment[];
}

export interface ItemThreadTarget {
  kind: ItemKind;
  owner: string;
  repo: string;
  number: number;
}

interface StateResponse {
  state?: string;
  merged_at?: string | null;
  draft?: boolean;
}

interface CommentResponse {
  id?: number | string;
  body?: string | null;
  user?: { login?: string };
  created_at?: string;
}

function normalizeState(state: string | undefined): ItemState {
  return state === "closed" || state === "merged" ? state : "open";
}

function mapComments(comments: CommentResponse[]): NotificationComment[] {
  if (!Array.isArray(comments)) {
    return [];
  }
  return comments.map((comment) => ({
    id: String(comment.id ?? ""),
    author: comment.user?.login ?? "unknown",
    created_at: comment.created_at ?? "",
    body: comment.body ?? ""
  }));
}

/**
 * Loads the live conversation for a work item: refined state (merged/draft
 * for pull requests) plus the comment thread.
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
    return {
      state: normalizeState(discussion.state),
      draft: false,
      comments: mapComments(comments)
    };
  }

  if (target.kind === "pull") {
    const [pull, comments] = await Promise.all([
      client.getPull(owner, repo, number) as Promise<StateResponse>,
      client
        .listIssueComments(owner, repo, number)
        .catch(() => []) as Promise<CommentResponse[]>
    ]);
    return {
      state: pull.merged_at ? "merged" : normalizeState(pull.state),
      draft: Boolean(pull.draft),
      comments: mapComments(comments)
    };
  }

  const [issue, comments] = await Promise.all([
    client.getIssue(owner, repo, number) as Promise<StateResponse>,
    client
      .listIssueComments(owner, repo, number)
      .catch(() => []) as Promise<CommentResponse[]>
  ]);
  return {
    state: normalizeState(issue.state),
    draft: false,
    comments: mapComments(comments)
  };
}
