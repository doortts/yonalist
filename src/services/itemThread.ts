import {
  summarizeReactions,
  type ConversationComment,
  type GitHubLabel,
  type ReactionSummary
} from "../domain/conversation";
import type { ItemKind, ItemState } from "../domain/types";
import type { GithubConnection } from "../hooks/useGithubAuth";
import { createGitHubClient } from "./github";
import { LruCache } from "./lruCache";

export interface ItemThread {
  state: ItemState;
  /** Pull requests only: still marked as a draft. */
  draft: boolean;
  authorAvatarUrl?: string;
  authorAssociation?: string;
  labels: GitHubLabel[];
  reactions?: ReactionSummary;
  comments: ConversationComment[];
  /** True when the comment listing failed — distinct from "no comments". */
  commentsError?: boolean;
}

export interface ItemThreadTarget {
  kind: ItemKind;
  owner: string;
  repo: string;
  number: number;
}

export interface FetchItemThreadOptions {
  /**
   * The item's updated_at (or any changing marker). Repeat requests for the
   * same version are served from the session cache; a new version refetches.
   */
  version?: string;
}

const threadCache = new LruCache<ItemThread>(50);
const inflightThreads = new Map<string, Promise<ItemThread>>();

export function clearItemThreadCache() {
  threadCache.clear();
  inflightThreads.clear();
}

function threadCacheKey(
  connection: GithubConnection,
  target: ItemThreadTarget,
  version: string
): string {
  return [
    connection.apiBaseUrl,
    target.kind,
    target.owner,
    target.repo,
    target.number,
    version
  ].join("|");
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
  reactions?: Record<string, unknown>;
}

interface CommentResponse {
  id?: number | string;
  body?: string | null;
  user?: UserResponse;
  author_association?: string;
  reactions?: Record<string, unknown>;
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
    body: comment.body ?? "",
    reactions: summarizeReactions(comment.reactions)
  }));
}

function threadFrom(
  item: StateResponse,
  comments: CommentResponse[] | null,
  state: ItemState
): ItemThread {
  return {
    state,
    draft: Boolean(item.draft),
    authorAvatarUrl: item.user?.avatar_url,
    authorAssociation: item.author_association,
    labels: mapLabels(item.labels),
    reactions: summarizeReactions(item.reactions),
    comments: mapComments(comments ?? []),
    commentsError: comments === null
  };
}

/**
 * Loads the live conversation for a work item: refined state (merged/draft
 * for pull requests), labels, author, and the comment thread. Results are
 * cached per (connection, target, version) so reselecting an unchanged item
 * does not refetch; threads with failed comment loads are never cached.
 */
export async function fetchItemThread(
  connection: GithubConnection,
  target: ItemThreadTarget,
  options: FetchItemThreadOptions = {}
): Promise<ItemThread> {
  const key = threadCacheKey(connection, target, options.version ?? "");
  const cached = threadCache.get(key);
  if (cached) {
    return cached;
  }
  const running = inflightThreads.get(key);
  if (running) {
    return running;
  }

  const request = fetchItemThreadUncached(connection, target)
    .then((thread) => {
      if (!thread.commentsError) {
        threadCache.set(key, thread);
      }
      return thread;
    })
    .finally(() => {
      inflightThreads.delete(key);
    });
  inflightThreads.set(key, request);
  return request;
}

async function fetchItemThreadUncached(
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
        .catch(() => null) as Promise<CommentResponse[] | null>
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
      .catch(() => null) as Promise<CommentResponse[] | null>
  ]);
  return threadFrom(issue, comments, normalizeState(issue.state));
}
