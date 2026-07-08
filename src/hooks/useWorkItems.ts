import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_ITEM_SORT,
  reconcileItems,
  withVaultItemPath,
  type ItemSort
} from "../domain/items";
import type { ItemDocument } from "../domain/types";
import { sampleItems } from "../fixtures/sampleItems";
import {
  loadFavorites,
  persistFavorites,
  type FavoritesMap
} from "../services/favoritesStore";
import { fetchMyWorkItems, fetchRepoWorkItems } from "../services/githubItems";
import { tracePerf } from "../services/perfTrace";
import type { GithubConnection } from "./useGithubAuth";

export type WorkScope =
  | { type: "inbox" }
  | { type: "repo"; owner: string; name: string };

export interface UseWorkItemsResult {
  items: ItemDocument[];
  loading: boolean;
  error: string | null;
  demoMode: boolean;
  lastFetchDurationMs: number | null;
  refresh: () => void;
  toggleFavorite: (path: string) => void;
}

export interface WorkItemsCacheEntry {
  items: ItemDocument[];
  fetchedAt: number;
  newestUpdatedAt: string;
}

const workItemsCache = new Map<string, WorkItemsCacheEntry>();

function apiScopedCacheKey(apiBaseUrl: string, scopeKey: string): string {
  return `${apiBaseUrl}|${scopeKey}`;
}

function itemSortCacheKey(sort: ItemSort): string {
  return `${sort.field}:${sort.direction}`;
}

function newestUpdatedAt(items: ItemDocument[]): string {
  return items.reduce(
    (newest, item) =>
      item.frontMatter.updated_at.localeCompare(newest) > 0
        ? item.frontMatter.updated_at
        : newest,
    ""
  );
}

export function smartWorkItemsCacheTtlMs(
  entry: Pick<WorkItemsCacheEntry, "items" | "newestUpdatedAt">,
  now = Date.now()
): number {
  if (entry.items.length === 0) {
    return 30_000;
  }

  const newest = Date.parse(entry.newestUpdatedAt);
  if (!Number.isFinite(newest)) {
    return 120_000;
  }

  const remoteAgeMs = Math.max(0, now - newest);
  if (remoteAgeMs < 10 * 60_000) {
    return 60_000;
  }
  if (remoteAgeMs < 60 * 60_000) {
    return 240_000;
  }
  if (remoteAgeMs < 24 * 60 * 60_000) {
    return 600_000;
  }
  return 1_800_000;
}

function isCacheFresh(entry: WorkItemsCacheEntry, now = Date.now()): boolean {
  return now - entry.fetchedAt < smartWorkItemsCacheTtlMs(entry, now);
}

export function clearWorkItemsCache() {
  workItemsCache.clear();
}

function testCacheKey(key: string): string {
  const scoped = key.includes("|")
    ? key
    : apiScopedCacheKey("https://api.github.com", key);
  return scoped.includes("|sort:")
    ? scoped
    : `${scoped}|sort:${itemSortCacheKey(DEFAULT_ITEM_SORT)}`;
}

export function clearWorkItemsCacheForTests() {
  clearWorkItemsCache();
}

export function primeWorkItemsCacheForTests(
  key: string,
  entry: WorkItemsCacheEntry
) {
  workItemsCache.set(testCacheKey(key), entry);
}

/**
 * Loads the work items for the current scope — the user's involves:@me inbox
 * or a single repository — and overlays locally stored favorite flags.
 */
export function useWorkItems(
  connection: GithubConnection,
  online: boolean,
  scope: WorkScope,
  vaultRoot = "/vault",
  enabled = true,
  sort: ItemSort = DEFAULT_ITEM_SORT
): UseWorkItemsResult {
  const token = connection.token.trim();
  const demoMode = !token;

  const [fetched, setFetched] = useState<ItemDocument[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchDurationMs, setLastFetchDurationMs] = useState<number | null>(null);
  const [favorites, setFavorites] = useState<FavoritesMap>(() => loadFavorites());
  const requestSeq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const scopeKey =
    scope.type === "repo" ? `repo:${scope.owner}/${scope.name}` : "inbox";
  const sortKey = itemSortCacheKey(sort);
  const cacheKey = apiScopedCacheKey(
    connection.apiBaseUrl,
    `${scopeKey}|sort:${sortKey}`
  );

  const load = useCallback((force = false) => {
    const cached = workItemsCache.get(cacheKey);
    if (!force && cached) {
      setFetched(cached.items);
      if (isCacheFresh(cached)) {
        setLoading(false);
        return;
      }
    }
    if (!enabled || !token || !online) {
      setLoading(false);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = ++requestSeq.current;
    const startedAt = performance.now();
    tracePerf("work_items_remote_start", {
      scope: scopeKey,
      apiBaseUrl: connection.apiBaseUrl
    });
    setLoading(true);
    const request =
      scope.type === "repo"
        ? fetchRepoWorkItems(connection, scope.owner, scope.name, {
            signal: controller.signal,
            sort
          })
        : fetchMyWorkItems(connection, { signal: controller.signal, sort });
    request
      .then((rawItems) => {
        if (requestSeq.current === seq && !controller.signal.aborted) {
          const durationMs = performance.now() - startedAt;
          const items = reconcileItems(
            workItemsCache.get(cacheKey)?.items,
            rawItems
          );
          workItemsCache.set(cacheKey, {
            items,
            fetchedAt: Date.now(),
            newestUpdatedAt: newestUpdatedAt(items)
          });
          setFetched((prev) => reconcileItems(prev, items));
          setError(null);
          setLastFetchDurationMs(durationMs);
          tracePerf("work_items_remote_done", {
            scope: scopeKey,
            count: items.length,
            durationMs
          });
        }
      })
      .catch((cause) => {
        if (controller.signal.aborted) {
          return;
        }
        if (requestSeq.current === seq) {
          const durationMs = performance.now() - startedAt;
          setError(cause instanceof Error ? cause.message : String(cause));
          setLastFetchDurationMs(durationMs);
          tracePerf("work_items_remote_error", {
            scope: scopeKey,
            message: cause instanceof Error ? cause.message : String(cause),
            durationMs
          });
        }
      })
      .finally(() => {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        if (requestSeq.current === seq && !controller.signal.aborted) {
          setLoading(false);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    cacheKey,
    enabled,
    token,
    online,
    connection.apiBaseUrl,
    connection.webBaseUrl,
    scopeKey,
    sort
  ]);

  useEffect(() => {
    const cached = workItemsCache.get(cacheKey);
    setFetched(cached?.items ?? null);
    if (enabled) {
      load(false);
    } else {
      setLoading(false);
    }
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [cacheKey, enabled, load]);

  useEffect(() => {
    persistFavorites(favorites);
  }, [favorites]);

  const itemsRef = useRef<ItemDocument[]>([]);
  const items = useMemo(() => {
    const base = demoMode ? sampleItems : enabled ? fetched ?? [] : [];
    const next = base.map((rawItem) => {
      const item = withVaultItemPath(vaultRoot, rawItem);
      const favorite = favorites[item.path] ?? favorites[rawItem.path];
      return favorite === undefined
        ? item
        : {
            ...item,
            frontMatter: {
              ...item.frontMatter,
              local: { ...item.frontMatter.local, favorite }
            }
          };
    });
    const reconciled = reconcileItems(itemsRef.current, next);
    itemsRef.current = reconciled;
    return reconciled;
  }, [demoMode, enabled, fetched, favorites, vaultRoot]);

  const toggleFavorite = useCallback(
    (path: string) => {
      const current =
        favorites[path] ??
        items.find((item) => item.path === path)?.frontMatter.local.favorite ??
        false;
      setFavorites((map) => ({ ...map, [path]: !current }));
    },
    [favorites, items]
  );

  return {
    items,
    loading: enabled ? loading : false,
    error: enabled ? error : null,
    demoMode,
    lastFetchDurationMs: enabled ? lastFetchDurationMs : null,
    refresh: () => load(true),
    toggleFavorite
  };
}
