import { afterEach, describe, expect, it, vi } from "vitest";
import type { GithubConnection } from "../hooks/useGithubAuth";
import {
  fetchMyRepositories,
  fetchMyWorkItems,
  fetchRepoWorkItems,
  groupRepositoriesByOwner
} from "./githubItems";

const connection: GithubConnection = {
  apiBaseUrl: "https://api.github.com",
  webBaseUrl: "https://github.com",
  token: "token"
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchMyWorkItems", () => {
  it("maps search results and discussions into vault item documents", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/search/issues")) {
        return jsonResponse({
          items: [
            {
              number: 42,
              title: "Fix login",
              state: "open",
              body: "Body",
              user: { login: "doortts" },
              labels: [{ name: "bug" }],
              created_at: "2026-07-01T00:00:00Z",
              updated_at: "2026-07-02T00:00:00Z",
              html_url: "https://github.com/acme/app/issues/42",
              repository_url: "https://api.github.com/repos/acme/app"
            },
            {
              number: 7,
              title: "Add feature",
              state: "open",
              pull_request: {},
              user: { login: "mona" },
              created_at: "2026-07-01T00:00:00Z",
              updated_at: "2026-07-03T00:00:00Z",
              repository_url: "https://api.github.com/repos/acme/app"
            }
          ]
        });
      }
      // GraphQL discussion search
      return jsonResponse({
        data: {
          search: {
            nodes: [
              {
                number: 5,
                title: "Roadmap",
                body: "Talk",
                closed: false,
                createdAt: "2026-06-30T00:00:00Z",
                updatedAt: "2026-07-01T00:00:00Z",
                author: { login: "doortts" },
                repository: { name: "app", owner: { login: "acme" } },
                labels: { nodes: [{ name: "planning" }] }
              }
            ]
          }
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const items = await fetchMyWorkItems(connection);

    expect(items.map((item) => item.frontMatter.kind)).toEqual([
      "pull",
      "issue",
      "discussion"
    ]);
    expect(items[1].path).toBe("/vault/github.com/acme/app/issues/42/issue.md");
    expect(items[1].frontMatter.labels).toEqual(["bug"]);
    expect(items[2].path).toBe(
      "/vault/github.com/acme/app/discussions/5/discussion.md"
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/search/issues?q=involves%3A%40me"),
      expect.anything()
    );
  });
});

describe("fetchRepoWorkItems", () => {
  it("combines repo search results with REST discussions", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/search/issues")) {
        return jsonResponse({ items: [] });
      }
      if (target.includes("/repos/acme/app/discussions")) {
        return jsonResponse([
          {
            number: 9,
            title: "Q&A",
            state: "open",
            body: "Question",
            user: { login: "mona" },
            created_at: "2026-07-01T00:00:00Z",
            updated_at: "2026-07-02T00:00:00Z",
            html_url: "https://github.com/acme/app/discussions/9"
          }
        ]);
      }
      throw new Error(`Unexpected request: ${target}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const items = await fetchRepoWorkItems(connection, "acme", "app");

    expect(items).toHaveLength(1);
    expect(items[0].frontMatter.kind).toBe("discussion");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("q=repo%3Aacme%2Fapp"),
      expect.anything()
    );
  });
});

describe("fetchMyRepositories", () => {
  it("merges participating and watched repositories without duplicates", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/user/repos")) {
        expect(target).toContain("affiliation=owner%2Ccollaborator");
        expect(target).not.toContain("organization_member");
        return jsonResponse([
          {
            name: "mine",
            full_name: "doortts/mine",
            owner: { login: "doortts" },
            open_issues_count: 1,
            pushed_at: "2026-07-01T00:00:00Z"
          },
          {
            name: "shared",
            full_name: "acme/shared",
            owner: { login: "acme" },
            open_issues_count: 2,
            pushed_at: "2026-06-01T00:00:00Z"
          }
        ]);
      }
      if (target.includes("/user/subscriptions")) {
        return jsonResponse([
          {
            name: "shared",
            full_name: "acme/shared",
            owner: { login: "acme" },
            open_issues_count: 2,
            pushed_at: "2026-06-01T00:00:00Z"
          },
          {
            name: "watched-only",
            full_name: "vendor/watched-only",
            owner: { login: "vendor" },
            open_issues_count: 5,
            pushed_at: "2026-05-01T00:00:00Z"
          }
        ]);
      }
      throw new Error(`Unexpected request: ${target}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const repos = await fetchMyRepositories(connection);

    expect(repos.map((repo) => repo.fullName)).toEqual([
      "doortts/mine",
      "acme/shared",
      "vendor/watched-only"
    ]);
  });

  it("still lists participating repositories when subscriptions fail", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/user/repos")) {
        return jsonResponse([
          {
            name: "mine",
            full_name: "doortts/mine",
            owner: { login: "doortts" },
            open_issues_count: 0,
            pushed_at: "2026-07-01T00:00:00Z"
          }
        ]);
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const repos = await fetchMyRepositories(connection);

    expect(repos.map((repo) => repo.fullName)).toEqual(["doortts/mine"]);
  });
});

describe("groupRepositoriesByOwner", () => {
  it("groups by owner alphabetically with repos by recent push", () => {
    const groups = groupRepositoriesByOwner([
      { owner: "zeta", name: "one", fullName: "zeta/one", openIssuesCount: 1, pushedAt: "2026-01-01" },
      { owner: "acme", name: "old", fullName: "acme/old", openIssuesCount: 2, pushedAt: "2026-01-01" },
      { owner: "acme", name: "new", fullName: "acme/new", openIssuesCount: 3, pushedAt: "2026-06-01" }
    ]);

    expect(groups.map((group) => group.owner)).toEqual(["acme", "zeta"]);
    expect(groups[0].repositories.map((repo) => repo.name)).toEqual(["new", "old"]);
  });
});
