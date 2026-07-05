import { useEffect, useState } from "react";
import type { ItemDocument } from "../domain/types";
import { isSampleItem, sampleItemThread } from "../fixtures/sampleItems";
import { fetchItemThread, type ItemThread } from "../services/itemThread";
import type { GithubConnection } from "./useGithubAuth";

export interface UseItemThreadResult {
  thread: ItemThread | null;
  loading: boolean;
  error: string | null;
}

/** Loads the selected work item's live state and comment thread. */
export function useItemThread(
  item: ItemDocument | null,
  connection: GithubConnection,
  online: boolean
): UseItemThreadResult {
  const [thread, setThread] = useState<ItemThread | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = connection.token.trim();

  const number = item?.frontMatter.number ?? 0;

  useEffect(() => {
    if (!item) {
      setThread(null);
      setLoading(false);
      setError(null);
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
      return;
    }

    if (number === 0) {
      // Local drafts have no remote conversation yet.
      setThread({ state: item.frontMatter.state, draft: false, labels: [], comments: [] });
      setLoading(false);
      setError(null);
      return;
    }

    if (!online) {
      setThread(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchItemThread(
      connection,
      {
        kind: item.frontMatter.kind,
        owner: item.frontMatter.owner,
        repo: item.frontMatter.repo,
        number
      },
      // Reselecting an unchanged item is served from the session cache.
      { version: item.frontMatter.updated_at }
    )
      .then((result) => {
        if (!cancelled) {
          setThread(result);
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setThread(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    item?.path,
    number,
    token,
    online,
    connection.apiBaseUrl,
    connection.webBaseUrl
  ]);

  return { thread, loading, error };
}
