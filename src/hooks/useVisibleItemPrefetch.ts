import { useEffect, useMemo, useRef, useState } from "react";
import { warmMarkdownBodies } from "../components/MarkdownBody";
import type { ConversationComment } from "../domain/conversation";
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

const DEFAULT_DWELL_MS = 2_000;
const DEFAULT_EVICTION_MS = 60_000;
const DEFAULT_MAX_CONCURRENT_PREFETCHES = 12;

type Timer = ReturnType<typeof setTimeout>;

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

export interface VisibleItemPrefetchStats {
  enabled: boolean;
  visible: number;
  queued: number;
  active: number;
  cached: number;
  completed: number;
  totalDurationMs: number;
  lastDurationMs: number | null;
}

interface PrefetchEntry {
  key: string;
  item: ItemDocument;
  version: string;
}

interface LatestOptions
  extends Omit<UseVisibleItemPrefetchOptions, "visibleItems"> {
  refreshKey: number;
  dwellMs: number;
  evictionMs: number;
  maxConcurrentPrefetches: number;
}

function itemTarget(item: ItemDocument): ItemThreadTarget {
  return {
    kind: item.frontMatter.kind,
    owner: item.frontMatter.owner,
    repo: item.frontMatter.repo,
    number: item.frontMatter.number
  };
}

function entryKey(item: ItemDocument, refreshKey: number): string {
  return `${item.path}|${itemThreadVersion(item, refreshKey)}`;
}

function expectsRemoteThread(options: LatestOptions, item: ItemDocument): boolean {
  return Boolean(options.connection.token.trim()) && item.frontMatter.number > 0;
}

function flattenComments(comments: ConversationComment[]): ConversationComment[] {
  return comments.flatMap((comment) => [
    comment,
    ...flattenComments(comment.replies ?? [])
  ]);
}

function countComments(comments: ConversationComment[]): number {
  return flattenComments(comments).length;
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
    comments_count: countComments(thread.comments),
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

/**
 * Warms the body and conversation cache for list rows the user is actually
 * looking at. It deliberately uses the same body/thread/vault persistence
 * functions as click-time loading, so prefetch never bypasses hash checks.
 */
export function useVisibleItemPrefetch(options: UseVisibleItemPrefetchOptions) {
  const refreshKey = options.refreshKey ?? 0;
  const dwellMs = options.dwellMs ?? DEFAULT_DWELL_MS;
  const evictionMs = options.evictionMs ?? DEFAULT_EVICTION_MS;
  const maxConcurrentPrefetches = Math.max(
    1,
    options.maxConcurrentPrefetches ?? DEFAULT_MAX_CONCURRENT_PREFETCHES
  );
  const [stats, setStats] = useState<VisibleItemPrefetchStats>({
    enabled: options.enabled,
    visible: 0,
    queued: 0,
    active: 0,
    cached: 0,
    completed: 0,
    totalDurationMs: 0,
    lastDurationMs: null
  });
  const entries = useMemo<PrefetchEntry[]>(
    () =>
      options.visibleItems.map((item) => ({
        key: [
          entryKey(item, refreshKey),
          options.connection.apiBaseUrl,
          options.connection.token.trim() ? "auth" : "anon"
        ].join("|"),
        item,
        version: itemThreadVersion(item, refreshKey)
      })),
    [options.connection.apiBaseUrl, options.connection.token, options.visibleItems, refreshKey]
  );
  const visibleSignature = entries.map((entry) => entry.key).join("\n");

  const latest = useRef<LatestOptions>({
    ...options,
    refreshKey,
    dwellMs,
    evictionMs,
    maxConcurrentPrefetches
  });
  latest.current = {
    ...options,
    refreshKey,
    dwellMs,
    evictionMs,
    maxConcurrentPrefetches
  };

  const entriesByKey = useRef(new Map<string, PrefetchEntry>());
  const visibleKeys = useRef(new Set<string>());
  const dwellTimers = useRef(new Map<string, Timer>());
  const evictionTimers = useRef(new Map<string, Timer>());
  const pendingKeys = useRef<string[]>([]);
  const inflightKeys = useRef(new Set<string>());
  const prefetchedKeys = useRef(new Set<string>());
  const lastDurationMs = useRef<number | null>(null);
  const completedCount = useRef(0);
  const totalDurationMs = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    const nextVisibleKeys = new Set(entries.map((entry) => entry.key));
    const previousVisibleKeys = visibleKeys.current;
    for (const entry of entries) {
      entriesByKey.current.set(entry.key, entry);
      const eviction = evictionTimers.current.get(entry.key);
      if (eviction) {
        clearTimeout(eviction);
        evictionTimers.current.delete(entry.key);
      }
      if (
        !options.enabled ||
        prefetchedKeys.current.has(entry.key) ||
        inflightKeys.current.has(entry.key) ||
        dwellTimers.current.has(entry.key)
      ) {
        continue;
      }
      const timer = setTimeout(() => {
        dwellTimers.current.delete(entry.key);
        enqueuePrefetch(entry.key);
      }, dwellMs);
      dwellTimers.current.set(entry.key, timer);
    }

    visibleKeys.current = nextVisibleKeys;

    for (const key of previousVisibleKeys) {
      if (!nextVisibleKeys.has(key)) {
        clearDwell(key);
        scheduleEviction(key);
      }
    }

    for (const key of prefetchedKeys.current) {
      if (!nextVisibleKeys.has(key)) {
        scheduleEviction(key);
      }
    }
    publishStats();
    // selectedPath intentionally participates through options.selectedPath:
    // when selection moves away from an out-of-view row, eviction can start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    visibleSignature,
    options.enabled,
    options.online,
    options.connection.apiBaseUrl,
    options.connection.token,
    options.selectedPath,
    dwellMs,
    evictionMs,
    maxConcurrentPrefetches
  ]);

  useEffect(
    () => {
      mounted.current = true;
      return () => {
        mounted.current = false;
        for (const timer of dwellTimers.current.values()) {
          clearTimeout(timer);
        }
        for (const timer of evictionTimers.current.values()) {
          clearTimeout(timer);
        }
        dwellTimers.current.clear();
        evictionTimers.current.clear();
        pendingKeys.current = [];
      };
    },
    []
  );

  return stats;

  function clearDwell(key: string) {
    const timer = dwellTimers.current.get(key);
    if (timer) {
      clearTimeout(timer);
      dwellTimers.current.delete(key);
    }
  }

  function scheduleEviction(key: string) {
    removePending(key);
    if (!prefetchedKeys.current.has(key) && !inflightKeys.current.has(key)) {
      return;
    }
    if (evictionTimers.current.has(key)) {
      return;
    }
    const entry = entriesByKey.current.get(key);
    if (!entry || visibleKeys.current.has(key)) {
      return;
    }
    const timer = setTimeout(() => {
      evictionTimers.current.delete(key);
      const current = latest.current;
      const latestEntry = entriesByKey.current.get(key);
      if (
        !latestEntry ||
        visibleKeys.current.has(key) ||
        current.selectedPath === latestEntry.item.path
      ) {
        return;
      }
      prefetchedKeys.current.delete(key);
      inflightKeys.current.delete(key);
      current.onBodyInvalidated(latestEntry.item.path);
      if (current.connection.token.trim() && latestEntry.item.frontMatter.number > 0) {
        deleteCachedItemThread(
          current.connection,
          itemTarget(latestEntry.item),
          latestEntry.version
        );
      }
      publishStats();
    }, latest.current.evictionMs);
    evictionTimers.current.set(key, timer);
  }

  function enqueuePrefetch(key: string) {
    if (
      pendingKeys.current.includes(key) ||
      inflightKeys.current.has(key) ||
      prefetchedKeys.current.has(key)
    ) {
      return;
    }
    pendingKeys.current.push(key);
    publishStats();
    drainPrefetchQueue();
  }

  function removePending(key: string) {
    const next = pendingKeys.current.filter((candidate) => candidate !== key);
    if (next.length !== pendingKeys.current.length) {
      pendingKeys.current = next;
      publishStats();
    }
  }

  function drainPrefetchQueue() {
    const maxConcurrent = latest.current.maxConcurrentPrefetches;
    while (
      inflightKeys.current.size < maxConcurrent &&
      pendingKeys.current.length > 0
    ) {
      const key = pendingKeys.current.shift() as string;
      if (
        inflightKeys.current.has(key) ||
        prefetchedKeys.current.has(key) ||
        (!visibleKeys.current.has(key) && !entriesByKey.current.get(key))
      ) {
        continue;
      }
      inflightKeys.current.add(key);
      void prefetchEntry(key);
    }
    publishStats();
  }

  async function prefetchEntry(key: string) {
    if (prefetchedKeys.current.has(key)) {
      inflightKeys.current.delete(key);
      drainPrefetchQueue();
      return;
    }
    const entry = entriesByKey.current.get(key);
    const current = latest.current;
    if (!entry || !current.enabled) {
      inflightKeys.current.delete(key);
      drainPrefetchQueue();
      return;
    }
    const startedAt =
      typeof performance === "undefined" ? Date.now() : performance.now();
    try {
      const body = await resolveBody(current, entry.item);
      const thread = await resolveThread(current, entry);
      await warmMarkdownBodies([
        body,
        ...(thread ? flattenComments(thread.comments).map((comment) => comment.body) : [])
      ]);
      if (thread && !thread.commentsError) {
        await persistPrefetchedThread(current, entry.item, body, thread);
      }
      if (!expectsRemoteThread(current, entry.item) || (thread && !thread.commentsError)) {
        prefetchedKeys.current.add(key);
      }
    } catch (cause) {
      current.onError?.(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inflightKeys.current.delete(key);
      const endedAt =
        typeof performance === "undefined" ? Date.now() : performance.now();
      lastDurationMs.current = endedAt - startedAt;
      completedCount.current += 1;
      totalDurationMs.current += lastDurationMs.current;
      publishStats();
      drainPrefetchQueue();
    }
  }

  function publishStats() {
    if (!mounted.current) {
      return;
    }
    const next = {
      enabled: latest.current.enabled,
      visible: visibleKeys.current.size,
      queued: pendingKeys.current.length,
      active: inflightKeys.current.size,
      cached: prefetchedKeys.current.size,
      completed: completedCount.current,
      totalDurationMs: totalDurationMs.current,
      lastDurationMs: lastDurationMs.current
    };
    setStats((current) =>
      current.enabled === next.enabled &&
      current.visible === next.visible &&
      current.queued === next.queued &&
      current.active === next.active &&
      current.cached === next.cached &&
      current.completed === next.completed &&
      current.totalDurationMs === next.totalDurationMs &&
      current.lastDurationMs === next.lastDurationMs
        ? current
        : next
    );
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
    entry: PrefetchEntry
  ): Promise<ItemThread | null> {
    if (
      !current.enabled ||
      !current.online ||
      !current.connection.token.trim() ||
      entry.item.frontMatter.number <= 0
    ) {
      return null;
    }
    return fetchItemThread(current.connection, itemTarget(entry.item), {
      version: entry.version
    });
  }
}
