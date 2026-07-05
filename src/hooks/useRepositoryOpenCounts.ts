import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchRepositoryOpenItemCounts,
  type OwnerGroup,
  type RepositorySummary
} from "../services/githubItems";
import {
  loadCachedRepositoryOpenCounts,
  persistCachedRepositoryOpenCounts
} from "../services/repositoryCache";
import { tracePerf } from "../services/perfTrace";
import type { GithubConnection } from "./useGithubAuth";

export interface UseRepositoryOpenCountsResult {
  groups: OwnerGroup[];
  loading: boolean;
  error: string | null;
}

function flattenGroups(groups: OwnerGroup[]): RepositorySummary[] {
  return groups.flatMap((group) => group.repositories);
}

function withCounts(
  groups: OwnerGroup[],
  counts: Record<string, number>
): OwnerGroup[] {
  return groups.map((group) => ({
    ...group,
    repositories: group.repositories.map((repository) => ({
      ...repository,
      openIssuesCount: counts[repository.fullName] ?? repository.openIssuesCount
    }))
  }));
}

export function useRepositoryOpenCounts(
  connection: GithubConnection,
  online: boolean,
  groups: OwnerGroup[],
  selectedRepositoryFullName: string | null
): UseRepositoryOpenCountsResult {
  const token = connection.token.trim();
  const [counts, setCounts] = useState<Record<string, number>>(() =>
    loadCachedRepositoryOpenCounts(connection.apiBaseUrl)
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requested = useRef<Set<string>>(new Set());
  const requestSeq = useRef(0);
  const visibleNames = useRef<Set<string>>(new Set());

  useEffect(() => {
    requestSeq.current += 1;
    requested.current = new Set();
    setCounts(loadCachedRepositoryOpenCounts(connection.apiBaseUrl));
    setError(null);
  }, [connection.apiBaseUrl, token]);

  const visibleKey = useMemo(
    () => flattenGroups(groups).map((repository) => repository.fullName).join("\n"),
    [groups]
  );
  const selectedRepository = useMemo(
    () =>
      selectedRepositoryFullName
        ? flattenGroups(groups).find(
            (repository) => repository.fullName === selectedRepositoryFullName
          ) ?? null
        : null,
    [groups, selectedRepositoryFullName]
  );

  useEffect(() => {
    const visibleRepositories = flattenGroups(groups);
    const visible = new Set(
      visibleRepositories.map((repository) => repository.fullName)
    );
    visibleNames.current = visible;
    for (const fullName of [...requested.current]) {
      if (!visible.has(fullName)) {
        requested.current.delete(fullName);
      }
    }

    if (!token || !online || groups.length === 0 || !selectedRepository) {
      setLoading(false);
      return;
    }
    if (requested.current.has(selectedRepository.fullName)) {
      setLoading(false);
      return;
    }

    const repositories = [selectedRepository];
    repositories.forEach((repository) => requested.current.add(repository.fullName));
    const seq = requestSeq.current;
    const startedAt = performance.now();
    tracePerf("repository_count_remote_start", {
      fullName: selectedRepository.fullName,
      apiBaseUrl: connection.apiBaseUrl
    });
    setLoading(true);
    fetchRepositoryOpenItemCounts(connection, repositories)
      .then((nextCounts) => {
        if (requestSeq.current !== seq) {
          repositories.forEach((repository) =>
            requested.current.delete(repository.fullName)
          );
          return;
        }
        const visibleCounts = Object.fromEntries(
          Object.entries(nextCounts).filter(([fullName]) =>
            visibleNames.current.has(fullName)
          )
        );
        setCounts((current) => {
          const merged = { ...current, ...visibleCounts };
          persistCachedRepositoryOpenCounts(connection.apiBaseUrl, merged);
          return merged;
        });
        setError(null);
        tracePerf("repository_count_remote_done", {
          fullName: selectedRepository.fullName,
          count: visibleCounts[selectedRepository.fullName],
          durationMs: performance.now() - startedAt
        });
      })
      .catch((cause) => {
        repositories.forEach((repository) =>
          requested.current.delete(repository.fullName)
        );
        if (requestSeq.current === seq) {
          const detail = cause instanceof Error ? cause.message : String(cause);
          setError(`Could not refresh project counts: ${detail}`);
          tracePerf("repository_count_remote_error", {
            fullName: selectedRepository.fullName,
            message: detail,
            durationMs: performance.now() - startedAt
          });
        }
      })
      .finally(() => {
        if (requestSeq.current === seq) {
          setLoading(false);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, online, connection.apiBaseUrl, visibleKey, selectedRepository]);

  return {
    groups: withCounts(groups, counts),
    loading,
    error
  };
}
