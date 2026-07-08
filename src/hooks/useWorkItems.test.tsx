import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ItemSort } from "../domain/items";
import type { ItemDocument, ItemKind, ItemState } from "../domain/types";
import type { GithubConnection } from "./useGithubAuth";
import {
  clearWorkItemsCacheForTests,
  primeWorkItemsCacheForTests,
  smartWorkItemsCacheTtlMs,
  useWorkItems,
  type WorkScope
} from "./useWorkItems";

const fetchMyWorkItemsMock = vi.hoisted(() => vi.fn());
const fetchRepoWorkItemsMock = vi.hoisted(() => vi.fn());

vi.mock("../services/githubItems", () => ({
  fetchMyWorkItems: fetchMyWorkItemsMock,
  fetchRepoWorkItems: fetchRepoWorkItemsMock
}));

const connection: GithubConnection = {
  apiBaseUrl: "https://api.github.com",
  webBaseUrl: "https://github.com",
  token: "ghp_test"
};

function item(
  title: string,
  owner = "acme",
  repo = "app",
  kind: ItemKind = "issue",
  state: ItemState = "open"
): ItemDocument {
  return {
    path: `/vault/github.com/${owner}/${repo}/${kind}s/1/${kind}.md`,
    body: "",
    frontMatter: {
      kind,
      host: "github.com",
      owner,
      repo,
      number: 1,
      title,
      state,
      author: "mona",
      labels: [],
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-06T00:00:00Z",
      local: { favorite: false },
      sync: { status: "synced" }
    }
  };
}

function renderWorkItems(scope: WorkScope) {
  return renderHook(
    ({ currentScope }) =>
      useWorkItems(connection, true, currentScope, "/vault", true),
    { initialProps: { currentScope: scope } }
  );
}

describe("useWorkItems", () => {
  beforeEach(() => {
    window.localStorage.clear();
    fetchMyWorkItemsMock.mockReset();
    fetchRepoWorkItemsMock.mockReset();
    clearWorkItemsCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses shorter freshness windows for recently active repositories and longer ones for quiet repositories", () => {
    const now = Date.parse("2026-07-06T12:00:00Z");

    expect(
      smartWorkItemsCacheTtlMs(
        {
          items: [item("recent")],
          newestUpdatedAt: "2026-07-06T11:55:00Z"
        },
        now
      )
    ).toBe(60_000);
    expect(
      smartWorkItemsCacheTtlMs(
        {
          items: [item("warm")],
          newestUpdatedAt: "2026-07-06T11:20:00Z"
        },
        now
      )
    ).toBe(240_000);
    expect(
      smartWorkItemsCacheTtlMs(
        {
          items: [item("same day")],
          newestUpdatedAt: "2026-07-06T09:00:00Z"
        },
        now
      )
    ).toBe(600_000);
    expect(
      smartWorkItemsCacheTtlMs(
        {
          items: [item("quiet")],
          newestUpdatedAt: "2026-07-03T09:00:00Z"
        },
        now
      )
    ).toBe(1_800_000);
  });

  it("shows stale cached repository items immediately while refreshing in the background", async () => {
    const now = Date.parse("2026-07-06T12:00:00Z");
    vi.setSystemTime(now);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let resolveRemote: (items: ItemDocument[]) => void = () => {};
    fetchRepoWorkItemsMock.mockReturnValue(
      new Promise<ItemDocument[]>((resolve) => {
        resolveRemote = resolve;
      })
    );
    primeWorkItemsCacheForTests("repo:acme/app", {
      items: [item("Cached repo item")],
      fetchedAt: now - 1_801_000,
      newestUpdatedAt: "2026-07-03T09:00:00Z"
    });

    const { result } = renderWorkItems({ type: "repo", owner: "acme", name: "app" });

    expect(result.current.items.map((current) => current.frontMatter.title)).toEqual([
      "Cached repo item"
    ]);
    expect(result.current.loading).toBe(true);
    expect(fetchRepoWorkItemsMock).toHaveBeenCalledTimes(1);

    resolveRemote([item("Remote repo item")]);

    await waitFor(() =>
      expect(result.current.items.map((current) => current.frontMatter.title)).toEqual([
        "Remote repo item"
      ])
    );
    expect(result.current.loading).toBe(false);
  });

  it("passes the requested sort to repository fetches and reloads when it changes", async () => {
    fetchRepoWorkItemsMock
      .mockResolvedValueOnce([item("Created sort")])
      .mockResolvedValueOnce([item("Updated sort")]);

    const { result, rerender } = renderHook(
      ({ sort }: { sort: ItemSort }) =>
        useWorkItems(
          connection,
          true,
          { type: "repo", owner: "acme", name: "app" },
          "/vault",
          true,
          sort
        ),
      {
        initialProps: {
          sort: { field: "created", direction: "desc" } as ItemSort
        }
      }
    );

    await waitFor(() => {
      expect(result.current.items[0]?.frontMatter.title).toBe("Created sort");
    });
    expect(fetchRepoWorkItemsMock).toHaveBeenLastCalledWith(
      connection,
      "acme",
      "app",
      expect.objectContaining({
        sort: { field: "created", direction: "desc" }
      })
    );

    rerender({ sort: { field: "updated", direction: "asc" } });

    await waitFor(() => {
      expect(result.current.items[0]?.frontMatter.title).toBe("Updated sort");
    });
    expect(fetchRepoWorkItemsMock).toHaveBeenCalledTimes(2);
    expect(fetchRepoWorkItemsMock).toHaveBeenLastCalledWith(
      connection,
      "acme",
      "app",
      expect.objectContaining({
        sort: { field: "updated", direction: "asc" }
      })
    );
  });

  it("does not refetch a fresh cached repository scope on selection", async () => {
    const now = Date.parse("2026-07-06T12:00:00Z");
    vi.setSystemTime(now);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    primeWorkItemsCacheForTests("repo:acme/app", {
      items: [item("Fresh cached repo item")],
      fetchedAt: now - 15_000,
      newestUpdatedAt: "2026-07-06T11:55:00Z"
    });

    const { result } = renderWorkItems({ type: "repo", owner: "acme", name: "app" });

    expect(result.current.items.map((current) => current.frontMatter.title)).toEqual([
      "Fresh cached repo item"
    ]);
    expect(result.current.loading).toBe(false);
    expect(fetchRepoWorkItemsMock).not.toHaveBeenCalled();
  });

  it("records the latest remote list fetch duration", async () => {
    fetchMyWorkItemsMock.mockResolvedValue([item("Remote inbox item")]);

    const { result } = renderWorkItems({ type: "inbox" });

    await waitFor(() =>
      expect(result.current.items.map((current) => current.frontMatter.title)).toEqual([
        "Remote inbox item"
      ])
    );
    expect(result.current.lastFetchDurationMs).toEqual(expect.any(Number));
  });

  it("aborts an in-flight repository refresh when another repository is selected", async () => {
    const signals: AbortSignal[] = [];
    fetchRepoWorkItemsMock.mockImplementation(
      (
        _connection: GithubConnection,
        _owner: string,
        _repo: string,
        options?: { signal?: AbortSignal }
      ) => {
        if (options?.signal) {
          signals.push(options.signal);
        }
        return new Promise<ItemDocument[]>(() => {});
      }
    );

    const { rerender } = renderWorkItems({
      type: "repo",
      owner: "acme",
      name: "app"
    });

    await waitFor(() => expect(fetchRepoWorkItemsMock).toHaveBeenCalledTimes(1));

    rerender({ currentScope: { type: "repo", owner: "acme", name: "docs" } });

    await waitFor(() => expect(fetchRepoWorkItemsMock).toHaveBeenCalledTimes(2));
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });
});
