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
  involvedRepoNames: ReadonlySet<string>,
  snapshotReady = false
): UseProjectVisibilityResult {
  const [overrides, setOverrides] = useState<ProjectVisibilityMap>(() =>
    loadProjectVisibility()
  );

  useEffect(() => {
    persistProjectVisibility(overrides);
  }, [overrides]);

  // Defaults depend on live signals (involves:@me activity) that vary between
  // sessions. Once those signals are ready, freeze the computed default for
  // every repository without an explicit choice so the sidebar stays exactly
  // as the user last saw it instead of re-deriving on each launch.
  useEffect(() => {
    if (!snapshotReady || groups.length === 0) {
      return;
    }
    setOverrides((current) => {
      let changed = false;
      const next = { ...current };
      for (const group of groups) {
        for (const repository of group.repositories) {
          if (next[repository.fullName] === undefined) {
            next[repository.fullName] = isRepositoryVisible(
              repository,
              current,
              involvedRepoNames
            );
            changed = true;
          }
        }
      }
      return changed ? next : current;
    });
  }, [snapshotReady, groups, involvedRepoNames]);

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
