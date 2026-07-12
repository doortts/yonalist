import { useMemo, useRef } from "react";
import { warmMarkdownBodies } from "../components/MarkdownBody";
import { flattenComments } from "../domain/conversation";
import { itemThreadVersion } from "../domain/itemThreadVersion";
import { commentFilePath } from "../domain/paths";
import type { CommentDocument, ItemDocument } from "../domain/types";
import {
  deleteCachedItemThread,
  fetchItemThread,
  type ItemThread,
  type ItemThreadTarget
} from "../services/itemThread";
import {
  loadItemDocumentBody,
  persistCommentDocuments,
  persistItemDocument
} from "../services/vaultStore";
import type { GithubConnection } from "./useGithubAuth";
import {
  useVisiblePrefetchQueue,
  type VisiblePrefetchQueueStats
} from "./useVisiblePrefetchQueue";

export interface UseVisibleItemPrefetchOptions {
  visibleItems: ItemDocument[];
  selectedPath: string | null;
  vaultRoot: string;
  connection: GithubConnection;
  online: boolean;
  enabled: boolean;
  loadedBodies: Record<string, string>;
  refreshKey?: number;
  dwellMs?: number;
  evictionMs?: number;
  maxConcurrentPrefetches?: number;
  onBodyPrefetched: (path: string, body: string) => void;
  onBodyInvalidated: (path: string) => void;
  onError?: (message: string) => void;
}

export type VisibleItemPrefetchStats = VisiblePrefetchQueueStats;

interface PrefetchValue {
  item: ItemDocument;
  version: string;
}

interface LatestOptions
  extends Omit<UseVisibleItemPrefetchOptions, "visibleItems"> {
  refreshKey: number;
}

function itemTarget(item: ItemDocument): ItemThreadTarget {
  return {
    kind: item.frontMatter.kind,
    owner: item.frontMatter.owner,
    repo: item.frontMatter.repo,
    number: item.frontMatter.number
  };
}

function expectsRemoteThread(options: LatestOptions, item: ItemDocument): boolean {
  return Boolean(options.connection.token.trim()) && item.frontMatter.number > 0;
}

function commentDocumentsFromThread(
  vaultRoot: string,
  item: ItemDocument,
  thread: ItemThread
): CommentDocument[] {
  return flattenComments(thread.comments).map((comment) => {
    const remoteIdNumber = Number(comment.id);
    const createdAt = comment.created_at || new Date(0).toISOString();
    return {
      path: commentFilePath(vaultRoot, {
        kind: item.frontMatter.kind,
        host: item.frontMatter.host,
        owner: item.frontMatter.owner,
        repo: item.frontMatter.repo,
        number: item.frontMatter.number,
        created_at: createdAt,
        remote_id: comment.id
      }),
      body: comment.body,
      frontMatter: {
        kind: "issue_comment",
        ...(Number.isFinite(remoteIdNumber) ? { remote_id: remoteIdNumber } : {}),
        author: comment.author,
        created_at: createdAt,
        updated_at: createdAt,
        sync: { status: "synced" }
      }
    };
  });
}

async function persistPrefetchedThread(
  options: LatestOptions,
  item: ItemDocument,
  body: string,
  thread: ItemThread
) {
  const labelColors = Object.fromEntries(
    thread.labels
      .filter((label) => label.name && label.color)
      .map((label) => [label.name, label.color])
  );
  const nextFrontMatter = {
    ...item.frontMatter,
    state: thread.state,
    labels: thread.labels.map((label) => label.name),
    comments_count: flattenComments(thread.comments).length,
    sync: { status: "synced" as const }
  };
  if (Object.keys(labelColors).length > 0) {
    nextFrontMatter.label_colors = labelColors;
  } else {
    delete nextFrontMatter.label_colors;
  }

  const itemDocument: ItemDocument = {
    ...item,
    body,
    frontMatter: nextFrontMatter
  };
  const commentDocuments = commentDocumentsFromThread(
    options.vaultRoot,
    item,
    thread
  );

  await Promise.all([
    persistItemDocument(options.vaultRoot, itemDocument),
    commentDocuments.length > 0
      ? persistCommentDocuments(options.vaultRoot, commentDocuments)
      : Promise.resolve({ checked: 0, written: 0, skipped: 0 })
  ]);
}

async function resolveBody(
  current: LatestOptions,
  item: ItemDocument
): Promise<string> {
  if (item.body) {
    return item.body;
  }
  const cached = current.loadedBodies[item.path];
  if (cached !== undefined) {
    return cached;
  }
  const body = await loadItemDocumentBody(current.vaultRoot, item);
  current.onBodyPrefetched(item.path, body);
  return body;
}

async function resolveThread(
  current: LatestOptions,
  value: PrefetchValue
): Promise<ItemThread | null> {
  if (
    !current.enabled ||
    !current.online ||
    !current.connection.token.trim() ||
    value.item.frontMatter.number <= 0
  ) {
    return null;
  }
  return fetchItemThread(current.connection, itemTarget(value.item), {
    version: value.version
  });
}

/**
 * Warms the body and conversation cache for list rows the user is actually
 * looking at. It deliberately uses the same body/thread/vault persistence
 * functions as click-time loading, so prefetch never bypasses hash checks.
 */
export function useVisibleItemPrefetch(
  options: UseVisibleItemPrefetchOptions
): () => VisibleItemPrefetchStats {
  const refreshKey = options.refreshKey ?? 0;

  const latest = useRef<LatestOptions>({ ...options, refreshKey });
  latest.current = { ...options, refreshKey };

  const entries = useMemo(
    () =>
      options.visibleItems.map((item) => {
        const version = itemThreadVersion(item, refreshKey);
        return {
          key: [
            item.path,
            version,
            options.connection.apiBaseUrl,
            options.connection.token.trim() ? "auth" : "anon"
          ].join("|"),
          value: { item, version }
        };
      }),
    [
      options.connection.apiBaseUrl,
      options.connection.token,
      options.visibleItems,
      refreshKey
    ]
  );

  return useVisiblePrefetchQueue<PrefetchValue>({
    entries,
    enabled: options.enabled,
    dwellMs: options.dwellMs,
    evictionMs: options.evictionMs,
    maxConcurrentPrefetches: options.maxConcurrentPrefetches,
    // Covers the old effect's online/selectedPath deps: dwell re-arms on
    // reconnect and eviction re-evaluates when selection moves away.
    rescheduleSignature: `${options.online}|${options.selectedPath ?? ""}`,
    // Keep the selected row's warmed body/thread even after it leaves view.
    isProtected: (value) => latest.current.selectedPath === value.item.path,
    prefetchEntry: async (value) => {
      const current = latest.current;
      const body = await resolveBody(current, value.item);
      const thread = await resolveThread(current, value);
      await warmMarkdownBodies([
        body,
        ...(thread
          ? flattenComments(thread.comments).map((comment) => comment.body)
          : [])
      ]);
      if (thread && !thread.commentsError) {
        await persistPrefetchedThread(current, value.item, body, thread);
      }
      return (
        !expectsRemoteThread(current, value.item) ||
        (thread != null && !thread.commentsError)
      );
    },
    onEvicted: (value) => {
      const current = latest.current;
      current.onBodyInvalidated(value.item.path);
      if (current.connection.token.trim() && value.item.frontMatter.number > 0) {
        deleteCachedItemThread(
          current.connection,
          itemTarget(value.item),
          value.version
        );
      }
    },
    onError: options.onError
  });
}
