import { useCallback, useEffect, useMemo, useState } from "react";
import type { OwnerGroup, RepositorySummary } from "../services/githubItems";
import {
  isRepositoryVisible,
  loadProjectVisibility,
  persistProjectVisibility,
  type ProjectVisibilityMap
} from "../services/projectVisibilityStore";

export interface UseProjectVisibilityResult {
  /** Groups with only the repositories chosen for the sidebar. */
  visibleGroups: OwnerGroup[];
  isVisible: (repository: RepositorySummary) => boolean;
  setRepositoryVisible: (fullName: string, visible: boolean) => void;
  setOwnerVisible: (group: OwnerGroup, visible: boolean) => void;
}

export function useProjectVisibility(
  groups: OwnerGroup[],
  involvedRepoNames: ReadonlySet<string>
): UseProjectVisibilityResult {
  const [overrides, setOverrides] = useState<ProjectVisibilityMap>(() =>
    loadProjectVisibility()
  );

  useEffect(() => {
    persistProjectVisibility(overrides);
  }, [overrides]);

  const isVisible = useCallback(
    (repository: RepositorySummary) =>
      isRepositoryVisible(repository, overrides, involvedRepoNames),
    [overrides, involvedRepoNames]
  );

  const visibleGroups = useMemo(
    () =>
      groups
        .map((group) => ({
          ...group,
          repositories: group.repositories.filter(isVisible)
        }))
        .filter((group) => group.repositories.length > 0),
    [groups, isVisible]
  );

  const setRepositoryVisible = useCallback((fullName: string, visible: boolean) => {
    setOverrides((current) => ({ ...current, [fullName]: visible }));
  }, []);

  const setOwnerVisible = useCallback((group: OwnerGroup, visible: boolean) => {
    setOverrides((current) => {
      const next = { ...current };
      for (const repository of group.repositories) {
        next[repository.fullName] = visible;
      }
      return next;
    });
  }, []);

  return { visibleGroups, isVisible, setRepositoryVisible, setOwnerVisible };
}
