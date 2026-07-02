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
  it("tags repositories by access source and merges duplicates", async () => {
    const repo = (owner: string, name: string) => ({
      name,
      full_name: `${owner}/${name}`,
      owner: { login: owner },
      open_issues_count: 1,
      pushed_at: "2026-07-01T00:00:00Z"
    });
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("affiliation=owner%2Ccollaborator")) {
        return jsonResponse([repo("doortts", "mine"), repo("acme", "shared")]);
      }
      if (target.includes("affiliation=organization_member")) {
        return jsonResponse([repo("pi", "agent-dev"), repo("acme", "shared")]);
      }
      if (target.includes("/user/subscriptions")) {
        return jsonResponse([repo("vendor", "watched-only")]);
      }
      throw new Error(`Unexpected request: ${target}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const repos = await fetchMyRepositories(connection);
    const byName = Object.fromEntries(repos.map((entry) => [entry.fullName, entry]));

    expect(Object.keys(byName)).toHaveLength(4);
    expect(byName["doortts/mine"]).toMatchObject({
      participating: true,
      orgMember: false,
      watched: false
    });
    expect(byName["pi/agent-dev"]).toMatchObject({
      participating: false,
      orgMember: true,
      watched: false
    });
    expect(byName["acme/shared"]).toMatchObject({
      participating: true,
      orgMember: true
    });
    expect(byName["vendor/watched-only"]).toMatchObject({ watched: true });
  });

  it("follows pagination so large org memberships are not cut off", async () => {
    const repoAt = (index: number) => ({
      name: `repo-${index}`,
      full_name: `pi/repo-${index}`,
      owner: { login: "pi" },
      open_issues_count: 0,
      pushed_at: "2026-07-01T00:00:00Z"
    });
    const fullPage = Array.from({ length: 100 }, (_, index) => repoAt(index));
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = new URL(String(url));
      if (target.searchParams.get("affiliation") === "organization_member") {
        return target.searchParams.get("page") === "1"
          ? jsonResponse(fullPage)
          : jsonResponse([repoAt(100)]);
      }
      return jsonResponse([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const repos = await fetchMyRepositories(connection);

    expect(repos).toHaveLength(101);
    expect(
      fetchMock.mock.calls.some((call) =>
        String(call[0]).includes("affiliation=organization_member&sort=pushed&per_page=100&page=2")
      )
    ).toBe(true);
  });

  it("still lists participating repositories when the optional sources fail", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("affiliation=owner%2Ccollaborator")) {
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
    const flags = { participating: true, watched: false, orgMember: false };
    const groups = groupRepositoriesByOwner([
      { owner: "zeta", name: "one", fullName: "zeta/one", openIssuesCount: 1, pushedAt: "2026-01-01", ...flags },
      { owner: "acme", name: "old", fullName: "acme/old", openIssuesCount: 2, pushedAt: "2026-01-01", ...flags },
      { owner: "acme", name: "new", fullName: "acme/new", openIssuesCount: 3, pushedAt: "2026-06-01", ...flags }
    ]);

    expect(groups.map((group) => group.owner)).toEqual(["acme", "zeta"]);
    expect(groups[0].repositories.map((repo) => repo.name)).toEqual(["new", "old"]);
  });
});
