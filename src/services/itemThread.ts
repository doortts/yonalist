import {
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
import { createGitHubClient } from "./github";
import {
  createGitHubTransport,
  encodePathSegment,
  type GitHubResponseMeta
} from "./githubTransport";
import { LruCache } from "./lruCache";
import {
  clearUserProfileCache,
  displayNameForLogin,
  fetchUserProfiles,
  type UserProfile
} from "./userProfiles";

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

const threadCache = new LruCache<ItemThread>(50);
const inflightThreads = new Map<string, Promise<ItemThread>>();
/**
 * The most recently cached thread per target, keyed independently of the
 * version marker. Lets consumers show the previous conversation immediately
 * while a newer version is fetched, instead of falling back to a skeleton.
 */
const latestThreads = new Map<string, ItemThread>();
const threadValidators = new Map<string, ThreadValidator[]>();

interface ThreadValidator {
  path: string;
  meta: GitHubResponseMeta;
}

interface FetchedItemThread {
  thread: ItemThread;
  validators: ThreadValidator[];
}

export interface ItemThreadRevalidationResult {
  changed: boolean;
}

export function clearItemThreadCache() {
  threadCache.clear();
  inflightThreads.clear();
  latestThreads.clear();
  threadValidators.clear();
  clearUserProfileCache();
}

export function getItemThreadCacheStats(): CacheSizeStats {
  return threadCache.entries().reduce<CacheSizeStats>(
    (stats, [key, thread]) => ({
      entries: stats.entries + 1,
      bytes:
        stats.bytes + estimateTextBytes(key) + estimateJsonBytes(thread)
    }),
    { entries: 0, bytes: 0 }
  );
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

function threadCacheKey(
  connection: GithubConnection,
  target: ItemThreadTarget,
  version: string
): string {
  return [threadTargetKey(connection, target), version].join("|");
}

export function getCachedItemThread(
  connection: GithubConnection,
  target: ItemThreadTarget,
  version = ""
): ItemThread | null {
  return threadCache.get(threadCacheKey(connection, target, version)) ?? null;
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
  return latestThreads.get(threadTargetKey(connection, target)) ?? null;
}

export function deleteCachedItemThread(
  connection: GithubConnection,
  target: ItemThreadTarget,
  version = ""
): boolean {
  const key = threadCacheKey(connection, target, version);
  inflightThreads.delete(key);
  const deleted = threadCache.delete(key);
  // Drop the "latest" pointer only when no versioned entry for this target
  // survives, keeping it consistent with the versioned cache and LRU eviction.
  const targetKey = threadTargetKey(connection, target);
  const hasSurvivingVersion = threadCache
    .entries()
    .some(([entryKey]) => entryKey.startsWith(`${targetKey}|`));
  if (!hasSurvivingVersion) {
    latestThreads.delete(targetKey);
    threadValidators.delete(targetKey);
  }
  return deleted;
}

interface UserResponse {
  login?: string;
  name?: string | null;
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
  node_id?: string;
  body?: string | null;
  user?: UserResponse;
  author_association?: string;
  reactions?: Record<string, unknown>;
  created_at?: string;
  replies?: CommentResponse[];
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

type ProfileMap = Record<string, UserProfile>;

function displayNameForUser(
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

function loginNeedingProfile(user: UserResponse | undefined): string | undefined {
  const login = user?.login;
  if (!login || login === "unknown") {
    return undefined;
  }
  const inlineName = user.name?.trim();
  return inlineName && inlineName !== login ? undefined : login;
}

function mapComments(
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

function flattenComments(comments: CommentResponse[]): CommentResponse[] {
  return comments.flatMap((comment) => [
    comment,
    ...flattenComments(comment.replies ?? [])
  ]);
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

function hasValidator(meta: GitHubResponseMeta): boolean {
  return Boolean(meta.etag || meta.lastModified);
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

  const request = fetchItemThreadUncached(connection, target, options.signal)
    .then(({ thread, validators }) => {
      if (!thread.commentsError) {
        threadCache.set(key, thread);
        recordLatestThread(connection, target, thread);
        recordThreadValidators(connection, target, validators);
      }
      return thread;
    })
    .finally(() => {
      inflightThreads.delete(key);
    });
  inflightThreads.set(key, request);
  return request;
}

/**
 * Marks a freshly cached thread as the latest for its target and drops any
 * "latest" pointers whose only versioned entries were evicted by the LRU, so
 * the version-independent map cannot outgrow the bounded versioned cache.
 */
function recordLatestThread(
  connection: GithubConnection,
  target: ItemThreadTarget,
  thread: ItemThread
): void {
  latestThreads.set(threadTargetKey(connection, target), thread);
  if (latestThreads.size <= threadCache.size) {
    return;
  }
  const liveTargetKeys = new Set(
    threadCache
      .entries()
      .map(([entryKey]) => entryKey.slice(0, entryKey.lastIndexOf("|")))
  );
  for (const targetKey of latestThreads.keys()) {
    if (!liveTargetKeys.has(targetKey)) {
      latestThreads.delete(targetKey);
      threadValidators.delete(targetKey);
    }
  }
}

function recordThreadValidators(
  connection: GithubConnection,
  target: ItemThreadTarget,
  validators: ThreadValidator[]
): void {
  const usable = validators.filter((validator) => hasValidator(validator.meta));
  const targetKey = threadTargetKey(connection, target);
  if (usable.length > 0) {
    threadValidators.set(targetKey, usable);
  } else {
    threadValidators.delete(targetKey);
  }
}

export async function revalidateItemThread(
  connection: GithubConnection,
  target: ItemThreadTarget
): Promise<ItemThreadRevalidationResult> {
  const validators = threadValidators.get(threadTargetKey(connection, target));
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
