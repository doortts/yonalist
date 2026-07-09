import {
  flattenComments,
  summarizeReactions,
  type ConversationComment,
  type GitHubLabel,
  type ReactionSummary
} from "../domain/conversation";
import type { ItemKind, ItemState } from "../domain/types";
import type { GithubConnection } from "../hooks/useGithubAuth";
import {
  estimateJsonBytes,
  estimateTextBytes,
  type CacheSizeStats
} from "./cacheStats";
import {
  displayNameForUser,
  loginNeedingProfile,
  mapComments,
  mapLabels,
  type CommentResponse,
  type LabelResponse,
  type ProfileMap,
  type UserResponse
} from "./conversationMapping";
import { createGitHubClient } from "./github";
import { createGitHubTransport, encodePathSegment } from "./githubTransport";
import { clearUserProfileCache, fetchUserProfiles } from "./userProfiles";
import {
  createVersionedConversationCache,
  type ConversationValidator
} from "./versionedConversationCache";

export interface ItemThread {
  state: ItemState;
  /** Pull requests only: still marked as a draft. */
  draft: boolean;
  authorName?: string;
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
  signal?: AbortSignal;
}

const cache = createVersionedConversationCache<ItemThread>({
  maxEntries: 50,
  estimateBytes: (key, thread) => estimateTextBytes(key) + estimateJsonBytes(thread)
});

interface FetchedItemThread {
  thread: ItemThread;
  validators: ConversationValidator[];
}

export interface ItemThreadRevalidationResult {
  changed: boolean;
}

export function clearItemThreadCache() {
  cache.clear();
  clearUserProfileCache();
}

export function getItemThreadCacheStats(): CacheSizeStats {
  return cache.stats();
}

function threadTargetKey(
  connection: GithubConnection,
  target: ItemThreadTarget
): string {
  return [
    connection.apiBaseUrl,
    target.kind,
    target.owner,
    target.repo,
    target.number
  ].join("|");
}

export function getCachedItemThread(
  connection: GithubConnection,
  target: ItemThreadTarget,
  version = ""
): ItemThread | null {
  return cache.get(threadTargetKey(connection, target), version) ?? null;
}

/**
 * Returns the most recently cached thread for a target, regardless of which
 * version it was cached under. Used to keep the previously seen conversation
 * on screen while a newer version is fetched in the background.
 */
export function getLatestCachedItemThread(
  connection: GithubConnection,
  target: ItemThreadTarget
): ItemThread | null {
  return cache.getLatest(threadTargetKey(connection, target)) ?? null;
}

export function deleteCachedItemThread(
  connection: GithubConnection,
  target: ItemThreadTarget,
  version = ""
): boolean {
  return cache.deleteVersion(threadTargetKey(connection, target), version);
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

function normalizeState(state: string | undefined): ItemState {
  return state === "closed" || state === "merged" ? state : "open";
}

function threadFrom(
  item: StateResponse,
  comments: CommentResponse[] | null,
  state: ItemState,
  profiles: ProfileMap = {}
): ItemThread {
  const authorName = displayNameForUser(item.user, profiles);
  return {
    state,
    draft: Boolean(item.draft),
    ...(authorName ? { authorName } : {}),
    authorAvatarUrl: item.user?.avatar_url,
    authorAssociation: item.author_association,
    labels: mapLabels(item.labels),
    reactions: summarizeReactions(item.reactions),
    comments: mapComments(comments ?? [], profiles),
    commentsError: comments === null
  };
}

async function userProfilesForThread(
  connection: GithubConnection,
  item: StateResponse,
  comments: CommentResponse[] | null,
  signal?: AbortSignal
): Promise<ProfileMap> {
  return fetchUserProfiles(
    {
      token: connection.token,
      apiBaseUrl: connection.apiBaseUrl,
      webBaseUrl: connection.webBaseUrl,
      signal
    },
    [
      loginNeedingProfile(item.user),
      ...flattenComments(comments ?? []).map((comment) =>
        loginNeedingProfile(comment.user)
      )
    ]
  );
}

function issuePath(owner: string, repo: string, number: number): string {
  return `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues/${encodePathSegment(number)}`;
}

function pullPath(owner: string, repo: string, number: number): string {
  return `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/pulls/${encodePathSegment(number)}`;
}

function issueCommentsPath(owner: string, repo: string, number: number): string {
  return `${issuePath(owner, repo, number)}/comments?per_page=100`;
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
  const targetKey = threadTargetKey(connection, target);
  const version = options.version ?? "";
  const cached = cache.get(targetKey, version);
  if (cached) {
    return cached;
  }
  const inflightKey = cache.keyFor(targetKey, version);
  const running = cache.inflight.get(inflightKey);
  if (running) {
    return running;
  }

  const request = fetchItemThreadUncached(connection, target, options.signal)
    .then(({ thread, validators }) => {
      if (!thread.commentsError) {
        // set() also refreshes the target's latest pointer.
        cache.set(targetKey, version, thread);
        cache.recordValidators(targetKey, validators);
      }
      return thread;
    })
    .finally(() => {
      cache.inflight.delete(inflightKey);
    });
  cache.inflight.set(inflightKey, request);
  return request;
}

export async function revalidateItemThread(
  connection: GithubConnection,
  target: ItemThreadTarget
): Promise<ItemThreadRevalidationResult> {
  const validators = cache.getValidators(threadTargetKey(connection, target));
  if (!validators || validators.length === 0) {
    return { changed: true };
  }
  const transport = createGitHubTransport({
    token: connection.token,
    apiBaseUrl: connection.apiBaseUrl,
    webBaseUrl: connection.webBaseUrl
  });
  for (const validator of validators) {
    const result = await transport.conditionalHead(
      validator.path,
      validator.meta
    );
    if (!result.unchanged) {
      return { changed: true };
    }
  }
  return { changed: false };
}

async function fetchItemThreadUncached(
  connection: GithubConnection,
  target: ItemThreadTarget,
  signal?: AbortSignal
): Promise<FetchedItemThread> {
  const client = createGitHubClient({
    token: connection.token,
    apiBaseUrl: connection.apiBaseUrl,
    webBaseUrl: connection.webBaseUrl,
    signal
  });
  const { owner, repo, number } = target;
  signal?.throwIfAborted();

  if (target.kind === "discussion") {
    const { discussion, comments } = (await client.getDiscussionWithComments(
      owner,
      repo,
      number
    )) as { discussion: StateResponse; comments: CommentResponse[] };
    signal?.throwIfAborted();
    const profiles = await userProfilesForThread(connection, discussion, comments, signal);
    signal?.throwIfAborted();
    return {
      thread: threadFrom(
        discussion,
        comments,
        normalizeState(discussion.state),
        profiles
      ),
      validators: []
    };
  }

  const transport = createGitHubTransport({
    token: connection.token,
    apiBaseUrl: connection.apiBaseUrl,
    webBaseUrl: connection.webBaseUrl,
    signal
  });

  if (target.kind === "pull") {
    const itemPath = pullPath(owner, repo, number);
    const commentsPath = issueCommentsPath(owner, repo, number);
    const [pullResult, commentsResult] = await Promise.all([
      transport.requestJsonWithMeta<StateResponse>(itemPath, { method: "GET" }),
      transport
        .requestJsonWithMeta<CommentResponse[]>(commentsPath, { method: "GET" })
        .catch(() => null)
    ]);
    const pull = pullResult.data;
    const comments = commentsResult?.data ?? null;
    signal?.throwIfAborted();
    const profiles = await userProfilesForThread(connection, pull, comments, signal);
    signal?.throwIfAborted();
    return {
      thread: threadFrom(
        pull,
        comments,
        pull.merged_at ? "merged" : normalizeState(pull.state),
        profiles
      ),
      validators: [
        { path: itemPath, meta: pullResult.meta },
        ...(commentsResult
          ? [{ path: commentsPath, meta: commentsResult.meta }]
          : [])
      ]
    };
  }

  const itemPath = issuePath(owner, repo, number);
  const commentsPath = issueCommentsPath(owner, repo, number);
  const [issueResult, commentsResult] = await Promise.all([
    transport.requestJsonWithMeta<StateResponse>(itemPath, { method: "GET" }),
    transport
      .requestJsonWithMeta<CommentResponse[]>(commentsPath, { method: "GET" })
      .catch(() => null)
  ]);
  const issue = issueResult.data;
  const comments = commentsResult?.data ?? null;
  signal?.throwIfAborted();
  const profiles = await userProfilesForThread(connection, issue, comments, signal);
  signal?.throwIfAborted();
  return {
    thread: threadFrom(issue, comments, normalizeState(issue.state), profiles),
    validators: [
      { path: itemPath, meta: issueResult.meta },
      ...(commentsResult
        ? [{ path: commentsPath, meta: commentsResult.meta }]
        : [])
    ]
  };
}
