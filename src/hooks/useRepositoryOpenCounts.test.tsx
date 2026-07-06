import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnerGroup } from "../services/githubItems";
import type { GithubConnection } from "./useGithubAuth";
import { useRepositoryOpenCounts } from "./useRepositoryOpenCounts";

const fetchRepositoryItemStateCountsMock = vi.hoisted(() => vi.fn());

vi.mock("../services/githubItems", () => ({
  fetchRepositoryItemStateCounts: fetchRepositoryItemStateCountsMock
}));

const connection: GithubConnection = {
  apiBaseUrl: "https://api.github.com",
  webBaseUrl: "https://github.com",
  token: "ghp_test"
};

const groups: OwnerGroup[] = [
  {
    owner: "acme",
    repositories: [
      {
        owner: "acme",
        name: "app",
        fullName: "acme/app",
        openIssuesCount: 1,
        pushedAt: "2026-07-01T00:00:00Z",
        participating: true,
        watched: false,
        orgMember: false
      }
    ]
  }
];

describe("useRepositoryOpenCounts", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
    fetchRepositoryItemStateCountsMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("defers the exact remote count refresh after a repository is selected", async () => {
    fetchRepositoryItemStateCountsMock.mockResolvedValue({
      "acme/app": { open: 3, closed: 5 }
    });

    const { result } = renderHook(() =>
      useRepositoryOpenCounts(connection, true, groups, "acme/app")
    );

    expect(fetchRepositoryItemStateCountsMock).not.toHaveBeenCalled();
    expect(result.current.selectedStateCounts).toBeUndefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });

    expect(fetchRepositoryItemStateCountsMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(fetchRepositoryItemStateCountsMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.selectedStateCounts).toEqual({ open: 3, closed: 5 });
  });
});
