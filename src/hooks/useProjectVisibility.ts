import { useCallback, useEffect, useMemo, useState } from "react";
import type { OwnerGroup, RepositorySummary } from "../services/githubItems";
import {
  hasStoredProjectVisibility,
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
  reset: () => void;
}

export function useProjectVisibility(
  groups: OwnerGroup[],
  defaultVisibleRepoNames: ReadonlySet<string>,
  snapshotReady = false
): UseProjectVisibilityResult {
  const [hadStoredVisibility] = useState(() => hasStoredProjectVisibility());
  const [overrides, setOverrides] = useState<ProjectVisibilityMap>(() =>
    loadProjectVisibility()
  );

  useEffect(() => {
    persistProjectVisibility(overrides);
  }, [overrides]);

  // First-run defaults come from the user's notification feed: repositories
  // that currently produce notifications are useful immediately, while the
  // larger accessible repository list can stay hidden until selected in
  // Settings. Existing saved choices keep the historical fallback so manual
  // project visibility is never overwritten by a later notification refresh.
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
            next[repository.fullName] = hadStoredVisibility
              ? isRepositoryVisible(repository, current, defaultVisibleRepoNames)
              : defaultVisibleRepoNames.has(repository.fullName);
            changed = true;
          }
        }
      }
      return changed ? next : current;
    });
  }, [snapshotReady, groups, defaultVisibleRepoNames, hadStoredVisibility]);

  const isVisible = useCallback(
    (repository: RepositorySummary) => {
      if (!hadStoredVisibility) {
        const override = overrides[repository.fullName];
        if (override !== undefined) {
          return override;
        }
        return snapshotReady && defaultVisibleRepoNames.has(repository.fullName);
      }
      return isRepositoryVisible(repository, overrides, defaultVisibleRepoNames);
    },
    [hadStoredVisibility, snapshotReady, overrides, defaultVisibleRepoNames]
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

  const reset = useCallback(() => {
    setOverrides({});
  }, []);

  return { visibleGroups, isVisible, setRepositoryVisible, setOwnerVisible, reset };
}
