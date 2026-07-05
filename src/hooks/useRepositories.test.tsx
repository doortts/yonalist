import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubNotification } from "../domain/notifications";
import type { ItemDocument, ItemKind, ItemState } from "../domain/types";
import type { RepositorySummary } from "../services/githubItems";
import type { GithubConnection } from "./useGithubAuth";
import { useRepositories } from "./useRepositories";

const fetchMyRepositorySummariesMock = vi.hoisted(() => vi.fn());

vi.mock("../services/githubItems", () => ({
  fetchMyRepositorySummaries: fetchMyRepositorySummariesMock,
  groupRepositoriesByOwner: (repositories: RepositorySummary[]) => {
    const byOwner = new Map<string, RepositorySummary[]>();
    for (const repository of repositories) {
      byOwner.set(repository.owner, [
        ...(byOwner.get(repository.owner) ?? []),
        repository
      ]);
    }
    return [...byOwner.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([owner, ownerRepos]) => ({
        owner,
        repositories: ownerRepos.sort((left, right) =>
          left.name.localeCompare(right.name)
        )
      }));
  }
}));

const connection: GithubConnection = {
  apiBaseUrl: "https://api.github.com",
  webBaseUrl: "https://github.com",
  token: "ghp_test"
};

function item(
  owner: string,
  repo: string,
  kind: ItemKind,
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
      title: `${owner}/${repo}`,
      state,
      author: "mona",
      labels: [],
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-02T00:00:00Z",
      local: { favorite: false },
      sync: { status: "synced" }
    }
  };
}

function repository(owner: string, name: string): RepositorySummary {
  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
    openIssuesCount: 7,
    pushedAt: "2026-07-03T00:00:00Z",
    participating: true,
    watched: false,
    orgMember: false
  };
}

function notification(fullName: string): GitHubNotification {
  const [owner, name] = fullName.split("/");
  return {
    id: `${fullName}-notification`,
    unread: true,
    reason: "subscribed",
    updated_at: "2026-07-04T00:00:00Z",
    last_read_at: null,
    subject: {
      title: `${fullName} updated`,
      type: "PullRequest",
      url: `https://api.github.com/repos/${fullName}/pulls/1`
    },
    repository: {
      full_name: fullName,
      name,
      owner: { login: owner }
    }
  };
}

describe("useRepositories", () => {
  beforeEach(() => {
    window.localStorage.clear();
    fetchMyRepositorySummariesMock.mockReset();
  });

  it("shows repositories from local vault items before remote summaries finish", async () => {
    let resolveRemote: (repositories: RepositorySummary[]) => void = () => {};
    fetchMyRepositorySummariesMock.mockReturnValue(
      new Promise<RepositorySummary[]>((resolve) => {
        resolveRemote = resolve;
      })
    );

    const { result } = renderHook(() =>
      useRepositories(connection, true, [
        item("pi", "agent-dev", "issue"),
        item("pi", "agent-dev", "pull"),
        item("pi", "agent-dev", "discussion", "closed"),
        item("doortts", "blog", "discussion")
      ])
    );

    expect(result.current.groups.map((group) => group.owner)).toEqual([
      "doortts",
      "pi"
    ]);
    expect(result.current.groups[1].repositories[0]).toMatchObject({
      fullName: "pi/agent-dev",
      openIssuesCount: 2
    });
    expect(result.current.loaded).toBe(true);

    resolveRemote([repository("remote", "app")]);

    await waitFor(() =>
      expect(result.current.groups.map((group) => group.owner)).toEqual([
        "remote"
      ])
    );
    expect(result.current.groups[0].repositories[0].fullName).toBe("remote/app");
  });

  it("adds watched repositories discovered from notifications to the filter list", async () => {
    fetchMyRepositorySummariesMock.mockResolvedValue([repository("pi", "agent-dev")]);

    const { result } = renderHook(() =>
      useRepositories(connection, true, [], [notification("pi/orderbot")])
    );

    await waitFor(() =>
      expect(
        result.current.groups
          .find((group) => group.owner === "pi")
          ?.repositories.map((repo) => repo.fullName)
      ).toEqual(["pi/agent-dev", "pi/orderbot"])
    );
    expect(
      result.current.groups
        .find((group) => group.owner === "pi")
        ?.repositories.find((repo) => repo.fullName === "pi/orderbot")
    ).toMatchObject({ watched: true, participating: false });
  });
});
