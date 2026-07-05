import type { RepositorySummary } from "./githubItems";

const repositoryCacheKey = "yonalist.repositorySummaries.v1";
const repositoryCountCacheKey = "yonalist.repositoryOpenCounts.v1";

type RepositoryCache = Record<string, RepositorySummary[]>;
type CountCache = Record<string, Record<string, number>>;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Cache misses are acceptable; the live network result still works.
  }
}

function hostKey(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/+$/g, "");
}

export function loadCachedRepositorySummaries(
  apiBaseUrl: string
): RepositorySummary[] | null {
  return readJson<RepositoryCache>(repositoryCacheKey, {})[hostKey(apiBaseUrl)] ?? null;
}

export function persistCachedRepositorySummaries(
  apiBaseUrl: string,
  repositories: RepositorySummary[]
) {
  const cache = readJson<RepositoryCache>(repositoryCacheKey, {});
  writeJson(repositoryCacheKey, { ...cache, [hostKey(apiBaseUrl)]: repositories });
}

export function loadCachedRepositoryOpenCounts(
  apiBaseUrl: string
): Record<string, number> {
  return readJson<CountCache>(repositoryCountCacheKey, {})[hostKey(apiBaseUrl)] ?? {};
}

export function persistCachedRepositoryOpenCounts(
  apiBaseUrl: string,
  counts: Record<string, number>
) {
  const cache = readJson<CountCache>(repositoryCountCacheKey, {});
  writeJson(repositoryCountCacheKey, { ...cache, [hostKey(apiBaseUrl)]: counts });
}
