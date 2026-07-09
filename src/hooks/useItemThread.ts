import { useEffect, useState } from "react";
import { itemThreadVersion } from "../domain/itemThreadVersion";
import type { ItemDocument } from "../domain/types";
import { isSampleItem, sampleItemThread } from "../fixtures/sampleItems";
import {
  fetchItemThread,
  getCachedItemThread,
  getLatestCachedItemThread,
  type ItemThread
} from "../services/itemThread";
import type { GithubConnection } from "./useGithubAuth";

export interface UseItemThreadResult {
  thread: ItemThread | null;
  loading: boolean;
  error: string | null;
  /**
   * True while a stale (previous-version) thread is shown and a newer version
   * is being fetched in the background. Consumers may ignore this field.
   */
  refreshing: boolean;
}

/** Loads the selected work item's live state and comment thread. */
export function useItemThread(
  item: ItemDocument | null,
  connection: GithubConnection,
  online: boolean,
  refreshKey = 0
): UseItemThreadResult {
  const [thread, setThread] = useState<ItemThread | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const token = connection.token.trim();

  const number = item?.frontMatter.number ?? 0;

  useEffect(() => {
    if (!item) {
      setThread(null);
      setLoading(false);
      setError(null);
      setRefreshing(false);
      return;
    }

    if (!token) {
      setThread(
        isSampleItem(item)
          ? sampleItemThread(item)
          : { state: item.frontMatter.state, draft: false, labels: [], comments: [] }
      );
      setLoading(false);
      setError(null);
      setRefreshing(false);
      return;
    }

    if (number === 0) {
      // Local drafts have no remote conversation yet.
      setThread({ state: item.frontMatter.state, draft: false, labels: [], comments: [] });
      setLoading(false);
      setError(null);
      setRefreshing(false);
      return;
    }

    if (!online) {
      setThread(null);
      setLoading(false);
      setError(null);
      setRefreshing(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const target = {
      kind: item.frontMatter.kind,
      owner: item.frontMatter.owner,
      repo: item.frontMatter.repo,
      number
    };
    const version = itemThreadVersion(item, refreshKey);
    const cached = getCachedItemThread(connection, target, version);
    if (cached) {
      setThread(cached);
      setLoading(false);
      setError(null);
      setRefreshing(false);
      return () => {
        cancelled = true;
        controller.abort();
      };
    }
    // Cache miss for the current version. If a previous version of this same
    // thread is still cached, show it immediately (stale-while-revalidate) so
    // the reader keeps the conversation instead of a skeleton, then swap in
    // the fresh result when it arrives.
    const stale = getLatestCachedItemThread(connection, target);
    if (stale) {
      setThread(stale);
      setRefreshing(false);
    } else {
      setThread({
        state: item.frontMatter.state,
        draft: false,
        labels: [],
        comments: []
      });
      setRefreshing(false);
    }
    setLoading(!stale);
    setError(null);
    fetchItemThread(
      connection,
      target,
      // Reselecting an unchanged item is served from the session cache.
      { version, signal: controller.signal }
    )
      .then((result) => {
        if (!cancelled) {
          setThread(result);
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          if (stale) {
            setThread(stale);
            setError(null);
          } else {
            setThread(null);
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    item?.path,
    item?.frontMatter.kind,
    item?.frontMatter.owner,
    item?.frontMatter.repo,
    item?.frontMatter.state,
    item?.frontMatter.updated_at,
    number,
    token,
    online,
    refreshKey,
    connection.apiBaseUrl,
    connection.webBaseUrl
  ]);

  return { thread, loading, error, refreshing };
}
