import type { RepositorySummary } from "./githubItems";

const visibilityStorageKey = "yonalist.projectVisibility.v1";

/** Explicit user choices per repository full name; unset falls back to defaults. */
export type ProjectVisibilityMap = Record<string, boolean>;

export function loadProjectVisibility(): ProjectVisibilityMap {
  try {
    const stored = window.localStorage.getItem(visibilityStorageKey);
    return stored ? (JSON.parse(stored) as ProjectVisibilityMap) : {};
  } catch {
    return {};
  }
}

export function hasStoredProjectVisibility(): boolean {
  try {
    const stored = window.localStorage.getItem(visibilityStorageKey);
    if (!stored) {
      return false;
    }
    const decoded = JSON.parse(stored) as unknown;
    return (
      decoded !== null &&
      typeof decoded === "object" &&
      !Array.isArray(decoded) &&
      Object.keys(decoded).length > 0
    );
  } catch {
    return false;
  }
}

export function persistProjectVisibility(map: ProjectVisibilityMap) {
  try {
    window.localStorage.setItem(visibilityStorageKey, JSON.stringify(map));
  } catch {
    // Visibility choices still apply for the session without persistence.
  }
}

/**
 * A repository is shown by default when the user participates in it, watches
 * it, or has work items there (involves:@me); repos reachable only through an
 * org membership stay hidden until checked in Settings.
 */
export function isRepositoryVisible(
  repository: RepositorySummary,
  overrides: ProjectVisibilityMap,
  involvedRepoNames: ReadonlySet<string>
): boolean {
  const override = overrides[repository.fullName];
  if (override !== undefined) {
    return override;
  }
  return (
    repository.participating ||
    repository.watched ||
    involvedRepoNames.has(repository.fullName)
  );
}
