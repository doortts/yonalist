import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ItemDocument } from "../domain/types";
import {
  fetchMyRepositorySummaries,
  groupRepositoriesByOwner,
  type OwnerGroup
} from "../services/githubItems";
import {
  loadCachedRepositorySummaries,
  persistCachedRepositorySummaries
} from "../services/repositoryCache";
import type { GithubConnection } from "./useGithubAuth";

export interface UseRepositoriesResult {
  groups: OwnerGroup[];
  /** True once the repository list (the visibility-filter basis) has loaded. */
  loaded: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Repositories the user participates in, grouped by owner for the sidebar.
 * Without a token the groups are derived from the demo items so the section
 * still demonstrates the layout.
 */
export function useRepositories(
  connection: GithubConnection,
  online: boolean,
  demoItems: ItemDocument[]
): UseRepositoriesResult {
  const token = connection.token.trim();
  const [groups, setGroups] = useState<OwnerGroup[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(() => {
    if (!token) {
      return;
    }
    const cached = loadCachedRepositorySummaries(connection.apiBaseUrl);
    if (cached) {
      setGroups(groupRepositoriesByOwner(cached));
    }
    if (!online) {
      return;
    }
    const seq = ++requestSeq.current;
    setLoading(true);
    fetchMyRepositorySummaries(connection)
      .then((repositories) => {
        if (requestSeq.current === seq) {
          persistCachedRepositorySummaries(connection.apiBaseUrl, repositories);
          setGroups(groupRepositoriesByOwner(repositories));
          setError(null);
        }
      })
      .catch((cause) => {
        if (requestSeq.current === seq) {
          const detail = cause instanceof Error ? cause.message : String(cause);
          setError(`Could not load repositories: ${detail}`);
        }
      })
      .finally(() => {
        if (requestSeq.current === seq) {
          setLoading(false);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, online, connection.apiBaseUrl]);

  useEffect(() => {
    requestSeq.current += 1;
    if (!token) {
      setGroups(null);
      setLoading(false);
      setError(null);
      return;
    }
    const cached = loadCachedRepositorySummaries(connection.apiBaseUrl);
    setGroups(cached ? groupRepositoriesByOwner(cached) : null);
    load();
  }, [load, token, connection.apiBaseUrl]);

  const demoGroups = useMemo<OwnerGroup[]>(() => {
    const counts = new Map<string, Map<string, number>>();
    for (const item of demoItems) {
      const byRepo = counts.get(item.frontMatter.owner) ?? new Map<string, number>();
      byRepo.set(
        item.frontMatter.repo,
        (byRepo.get(item.frontMatter.repo) ?? 0) + 1
      );
      counts.set(item.frontMatter.owner, byRepo);
    }
    return [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([owner, byRepo]) => ({
        owner,
        repositories: [...byRepo.entries()].map(([name, count]) => ({
          owner,
          name,
          fullName: `${owner}/${name}`,
          openIssuesCount: count,
          pushedAt: "",
          participating: true,
          watched: false,
          orgMember: false
        }))
      }));
  }, [demoItems]);

  return {
    groups: token ? groups ?? [] : demoGroups,
    loaded: token ? groups !== null : true,
    loading,
    error,
    refresh: load
  };
}
