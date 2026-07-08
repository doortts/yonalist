import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { OwnerGroup, RepositorySummary } from "../services/githubItems";
import { useProjectVisibility } from "./useProjectVisibility";

const visibilityStorageKey = "yonalist.projectVisibility.v1";

function repository(
  fullName: string,
  overrides: Partial<RepositorySummary> = {}
): RepositorySummary {
  const [owner, name] = fullName.split("/");
  return {
    owner,
    name,
    fullName,
    openIssuesCount: 0,
    pushedAt: "2026-07-01T00:00:00Z",
    participating: false,
    watched: false,
    orgMember: false,
    ...overrides
  };
}

const groups: OwnerGroup[] = [
  {
    owner: "acme",
    repositories: [
      repository("acme/participating", { participating: true }),
      repository("acme/org-only", { orgMember: true })
    ]
  },
  {
    owner: "pi",
    repositories: [
      repository("pi/watched", { watched: true }),
      repository("pi/from-notification")
    ]
  }
];

function visibleRepoNames(result: ReturnType<typeof useProjectVisibility>) {
  return result.visibleGroups.flatMap((group) =>
    group.repositories.map((repo) => repo.fullName)
  );
}

describe("useProjectVisibility", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("does not show broad repository defaults before the first notification snapshot is ready", () => {
    const { result } = renderHook(() =>
      useProjectVisibility(groups, new Set(["pi/from-notification"]), false)
    );

    expect(visibleRepoNames(result.current)).toEqual([]);
  });

  it("seeds first-run project visibility from repositories present in notifications", async () => {
    const { result } = renderHook(() =>
      useProjectVisibility(groups, new Set(["pi/from-notification"]), true)
    );

    await waitFor(() =>
      expect(visibleRepoNames(result.current)).toEqual(["pi/from-notification"])
    );

    expect(window.localStorage.getItem(visibilityStorageKey)).toBe(
      JSON.stringify({
        "acme/participating": false,
        "acme/org-only": false,
        "pi/watched": false,
        "pi/from-notification": true
      })
    );
  });

  it("seeds first-run visibility when repository and notification snapshots arrive after mount", async () => {
    const { result, rerender } = renderHook(
      ({
        sourceGroups,
        defaults,
        ready
      }: {
        sourceGroups: OwnerGroup[];
        defaults: ReadonlySet<string>;
        ready: boolean;
      }) => useProjectVisibility(sourceGroups, defaults, ready),
      {
        initialProps: {
          sourceGroups: [] as OwnerGroup[],
          defaults: new Set<string>(),
          ready: false
        }
      }
    );

    expect(visibleRepoNames(result.current)).toEqual([]);

    rerender({
      sourceGroups: groups,
      defaults: new Set(["pi/from-notification"]),
      ready: true
    });

    await waitFor(() =>
      expect(visibleRepoNames(result.current)).toEqual(["pi/from-notification"])
    );
  });

  it("keeps persisted manual visibility instead of reseeding from notifications", () => {
    window.localStorage.setItem(
      visibilityStorageKey,
      JSON.stringify({
        "acme/participating": false,
        "acme/org-only": true
      })
    );

    const { result } = renderHook(() =>
      useProjectVisibility(groups, new Set(["acme/participating"]), true)
    );

    expect(visibleRepoNames(result.current)).toEqual([
      "acme/org-only",
      "pi/watched"
    ]);
  });

  it("treats an empty persisted visibility map as first-run state", async () => {
    window.localStorage.setItem(visibilityStorageKey, "{}");

    const { result } = renderHook(() =>
      useProjectVisibility(groups, new Set(["pi/from-notification"]), true)
    );

    await waitFor(() =>
      expect(visibleRepoNames(result.current)).toEqual(["pi/from-notification"])
    );
  });
});
