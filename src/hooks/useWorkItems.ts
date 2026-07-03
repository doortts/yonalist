import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { withVaultItemPath } from "../domain/items";
import type { ItemDocument } from "../domain/types";
import { sampleItems } from "../fixtures/sampleItems";
import {
  loadFavorites,
  persistFavorites,
  type FavoritesMap
} from "../services/favoritesStore";
import { fetchMyWorkItems, fetchRepoWorkItems } from "../services/githubItems";
import type { GithubConnection } from "./useGithubAuth";

export type WorkScope =
  | { type: "inbox" }
  | { type: "repo"; owner: string; name: string };

export interface UseWorkItemsResult {
  items: ItemDocument[];
  loading: boolean;
  error: string | null;
  demoMode: boolean;
  refresh: () => void;
  toggleFavorite: (path: string) => void;
}

/**
 * Loads the work items for the current scope — the user's involves:@me inbox
 * or a single repository — and overlays locally stored favorite flags.
 */
export function useWorkItems(
  connection: GithubConnection,
  online: boolean,
  scope: WorkScope,
  vaultRoot = "/vault"
): UseWorkItemsResult {
  const token = connection.token.trim();
  const demoMode = !token;

  const [fetched, setFetched] = useState<ItemDocument[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<FavoritesMap>(() => loadFavorites());
  const requestSeq = useRef(0);

  const scopeKey =
    scope.type === "repo" ? `repo:${scope.owner}/${scope.name}` : "inbox";

  const load = useCallback(() => {
    if (!token || !online) {
      return;
    }
    const seq = ++requestSeq.current;
    setLoading(true);
    const request =
      scope.type === "repo"
        ? fetchRepoWorkItems(connection, scope.owner, scope.name)
        : fetchMyWorkItems(connection);
    request
      .then((items) => {
        if (requestSeq.current === seq) {
          setFetched(items);
          setError(null);
        }
      })
      .catch((cause) => {
        if (requestSeq.current === seq) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (requestSeq.current === seq) {
          setLoading(false);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, online, connection.apiBaseUrl, connection.webBaseUrl, scopeKey]);

  useEffect(() => {
    setFetched(null);
    load();
  }, [load]);

  useEffect(() => {
    persistFavorites(favorites);
  }, [favorites]);

  const items = useMemo(() => {
    const base = demoMode ? sampleItems : fetched ?? [];
    return base.map((rawItem) => {
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
  }, [demoMode, fetched, favorites, vaultRoot]);

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

  return { items, loading, error, demoMode, refresh: load, toggleFavorite };
}
