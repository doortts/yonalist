import {
  summarizeReactions,
  type ConversationComment,
  type GitHubLabel,
  type ReactionSummary
} from "../domain/conversation";
import { subjectNumber, type GitHubNotification } from "../domain/notifications";
import { createGitHubClient } from "./github";
import { LruCache } from "./lruCache";
import {
  clearPersistedNotificationDetails,
  loadLatestPersistedNotificationDetail,
  loadPersistedNotificationDetail,
  persistNotificationDetail
} from "./notificationStores";
import {
  clearUserProfileCache,
  displayNameForLogin,
  fetchUserProfiles,
  type UserProfile
} from "./userProfiles";

export type { ConversationComment as NotificationComment } from "../domain/conversation";

export interface NotificationDetailContent {
  title: string;
  state: string;
  author: string;
  authorName?: string;
  authorAvatarUrl?: string;
  authorAssociation?: string;
  created_at?: string;
  body: string;
  labels: GitHubLabel[];
  reactions?: ReactionSummary;
  comments: ConversationComment[];
  /** True when the comment listing failed — distinct from "no comments". */
  commentsError?: boolean;
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
  node_id?: string;
  body?: string | null;
  user?: UserResponse;
  author_association?: string;
  reactions?: Record<string, unknown>;
  created_at?: string;
  replies?: CommentResponse[];
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

function flattenComments(comments: CommentResponse[]): CommentResponse[] {
  return comments.flatMap((comment) => [
    comment,
    ...flattenComments(comment.replies ?? [])
  ]);
}

const detailCache = new LruCache<NotificationDetailContent>(50);
const inflightDetails = new Map<string, Promise<NotificationDetailContent>>();
/**
 * The most recently cached detail per subject, keyed independently of the
 * version marker. Lets consumers show the previous conversation immediately
 * while a newer version is fetched, instead of falling back to a skeleton.
 */
const latestDetails = new Map<string, NotificationDetailContent>();

export function clearNotificationDetailCache() {
  resetNotificationDetailMemoryCache();
  clearPersistedNotificationDetails();
  clearUserProfileCache();
}

/**
 * Drops the in-memory caches but keeps the persisted store, mirroring an app
 * restart where localStorage survives. Exposed mainly for tests that exercise
 * the persistence-restore path.
 */
export function resetNotificationDetailMemoryCache() {
  detailCache.clear();
  inflightDetails.clear();
  latestDetails.clear();
}

/**
 * Just enough of the fetch options to key the detail cache. The synchronous
 * peek APIs accept this subset so callers can look before deciding to fetch.
 */
export interface NotificationDetailCacheKeyOptions {
  apiBaseUrl: string;
  notification: GitHubNotification;
}

function detailSubjectKey(
  options: NotificationDetailCacheKeyOptions
): string {
  const { notification } = options;
  return [
    options.apiBaseUrl,
    notification.subject.url ??
      `${notification.repository.full_name}#${notification.id}`
  ].join("|");
}

/**
 * Synchronous cache peek for the notification's current version. Checks the
 * in-memory cache first and, on a miss, restores a matching entry from the
 * persisted store (surviving app restarts). Returns null when nothing matches
 * the current version.
 */
export function getCachedNotificationDetail(
  options: NotificationDetailCacheKeyOptions
): NotificationDetailContent | null {
  const cached = detailCache.get(detailCacheKey(options));
  if (cached) {
    return cached;
  }
  const persisted = loadPersistedNotificationDetail(
    options.apiBaseUrl,
    options.notification
  );
  if (persisted) {
    // Warm the memory cache so subsequent peeks are pointer-cheap and the
    // latest pointer is populated for stale-while-revalidate.
    detailCache.set(detailCacheKey(options), persisted);
    latestDetails.set(detailSubjectKey(options), persisted);
  }
  return persisted;
}

/**
 * Returns the most recently cached detail for a subject, regardless of which
 * version it was cached under. Used to keep the previously seen conversation
 * on screen while a newer version is fetched. Falls back to the persisted
 * store so a restart still shows a stale conversation.
 */
export function getLatestCachedNotificationDetail(
  options: NotificationDetailCacheKeyOptions
): NotificationDetailContent | null {
  const inMemory = latestDetails.get(detailSubjectKey(options));
  if (inMemory) {
    return inMemory;
  }
  const persisted = loadLatestPersistedNotificationDetail(
    options.apiBaseUrl,
    options.notification
  );
  if (persisted) {
    latestDetails.set(detailSubjectKey(options), persisted);
  }
  return persisted;
}

async function userProfilesForDetail(
  options: FetchNotificationDetailOptions,
  item: IssueResponse,
  comments: CommentResponse[] | null
): Promise<ProfileMap> {
  return fetchUserProfiles(
    {
      token: options.token,
      apiBaseUrl: options.apiBaseUrl,
      webBaseUrl: options.webBaseUrl,
      fetch: options.fetchImpl
    },
    [
      loginNeedingProfile(item.user),
      ...flattenComments(comments ?? []).map((comment) =>
        loginNeedingProfile(comment.user)
      )
    ]
  );
}

function detailCacheKey(options: NotificationDetailCacheKeyOptions): string {
  const { notification } = options;
  return [
    detailSubjectKey(options),
    // A new activity bumps updated_at, invalidating the cached conversation.
    notification.updated_at
  ].join("|");
}

/**
 * Loads the conversation behind a notification through the GitHub REST API,
 * normalized so the detail pane can render every subject type the same way.
 * Results are cached per (connection, subject, updated_at); details whose
 * comments failed to load are not cached so reopening retries.
 */
export async function fetchNotificationDetail(
  options: FetchNotificationDetailOptions
): Promise<NotificationDetailContent> {
  const key = detailCacheKey(options);
  const cached = detailCache.get(key);
  if (cached) {
    return cached;
  }
  const running = inflightDetails.get(key);
  if (running) {
    return running;
  }

  const request = fetchNotificationDetailUncached(options)
    .then((detail) => {
      if (!detail.commentsError) {
        detailCache.set(key, detail);
        latestDetails.set(detailSubjectKey(options), detail);
        persistNotificationDetail(options.apiBaseUrl, options.notification, detail);
      }
      return detail;
    })
    .finally(() => {
      inflightDetails.delete(key);
    });
  inflightDetails.set(key, request);
  return request;
}

async function fetchNotificationDetailUncached(
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
    const authorName = displayNameForUser(discussion.user, {});
    return {
      title: discussion.title ?? notification.subject.title,
      state: discussion.state ?? "open",
      author: discussion.user?.login ?? "unknown",
      ...(authorName ? { authorName } : {}),
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
    client.listIssueComments(owner, repo, number).catch(() => null) as Promise<
      CommentResponse[] | null
    >
  ]);
  const profiles = await userProfilesForDetail(options, item, comments);
  const authorName = displayNameForUser(item.user, profiles);

  return {
    title: item.title ?? notification.subject.title,
    state: isPull && item.merged_at ? "merged" : item.state ?? "open",
    author: item.user?.login ?? "unknown",
    ...(authorName ? { authorName } : {}),
    authorAvatarUrl: item.user?.avatar_url,
    authorAssociation: item.author_association,
    created_at: item.created_at,
    body: item.body ?? "",
    labels: mapLabels(item.labels),
    reactions: summarizeReactions(item.reactions),
    comments: mapComments(comments ?? [], profiles),
    commentsError: comments === null
  };
}
