import { afterEach, describe, expect, it, vi } from "vitest";
import type { GithubConnection } from "../hooks/useGithubAuth";
import {
  fetchMyRepositorySummaries,
  fetchMyRepositories,
  fetchMyWorkItems,
  fetchRepoWorkItems,
  fetchRepositoryItemStateCounts,
  fetchRepositoryOpenItemCounts,
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
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
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
              labels: [{ name: "bug", color: "b60205" }],
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
                comments: { totalCount: 6 },
                createdAt: "2026-06-30T00:00:00Z",
                updatedAt: "2026-07-01T00:00:00Z",
                author: { login: "doortts" },
                repository: { name: "app", owner: { login: "acme" } },
                labels: { nodes: [{ name: "planning", color: "fef2c0" }] }
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
    expect(items[1].frontMatter.label_colors).toEqual({ bug: "b60205" });
    expect(items[2].frontMatter.label_colors).toEqual({ planning: "fef2c0" });
    expect(items[2].frontMatter.comments_count).toBe(6);
    expect(items[2].path).toBe(
      "/vault/github.com/acme/app/discussions/5/discussion.md"
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/search/issues?q=involves%3A%40me"),
      expect.anything()
    );
    const graphQlCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/graphql")
    );
    expect(String(graphQlCall?.[1]?.body)).toContain("name color");
    expect(String(graphQlCall?.[1]?.body)).toContain("comments { totalCount }");
  });
});

describe("fetchRepoWorkItems", () => {
  it("combines direct repo issue results with GraphQL discussions", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/search/issues")) {
        throw new Error("Repo-scoped refresh should not use issue search.");
      }
      if (target.includes("/repos/acme/app/issues")) {
        return jsonResponse([
          {
            number: 42,
            title: "Repo issue",
            state: "open",
            body: "Issue body",
            user: { login: "mona" },
            labels: [{ name: "bug", color: "b60205" }],
            created_at: "2026-07-01T00:00:00Z",
            updated_at: "2026-07-03T00:00:00Z",
            html_url: "https://github.com/acme/app/issues/42",
            comments: 2
          }
        ]);
      }
      if (target.includes("/graphql")) {
        return jsonResponse({
          data: {
            repository: {
              discussions: {
                nodes: [
                  {
                    number: 9,
                    title: "Q&A",
                    closed: false,
                    body: "Question",
                    comments: { totalCount: 3 },
                    author: { login: "mona" },
                    createdAt: "2026-07-01T00:00:00Z",
                    updatedAt: "2026-07-02T00:00:00Z",
                    url: "https://github.com/acme/app/discussions/9",
                    labels: { nodes: [] }
                  }
                ]
              }
            }
          }
        });
      }
      throw new Error(`Unexpected request: ${target}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const items = await fetchRepoWorkItems(connection, "acme", "app");

    expect(items.map((item) => item.frontMatter.kind)).toEqual([
      "issue",
      "discussion"
    ]);
    expect(items[0].frontMatter.title).toBe("Repo issue");
    expect(items[0].frontMatter.label_colors).toEqual({ bug: "b60205" });
    expect(items[1].frontMatter.comments_count).toBe(3);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/repos/acme/app/issues?"),
      expect.anything()
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/graphql",
      expect.objectContaining({ method: "POST" })
    );
  });
});

describe("fetchMyRepositories", () => {
  it("loads repository summaries without waiting for GraphQL count enrichment", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("affiliation=owner%2Ccollaborator")) {
        return jsonResponse([
          {
            name: "app",
            full_name: "acme/app",
            owner: { login: "acme" },
            open_issues_count: 4,
            pushed_at: "2026-07-01T00:00:00Z"
          }
        ]);
      }
      if (target.includes("/graphql")) {
        throw new Error("Repository summaries should not fetch count GraphQL.");
      }
      return jsonResponse([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const repos = await fetchMyRepositorySummaries(connection);

    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({
      fullName: "acme/app",
      openIssuesCount: 4
    });
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]).includes("/graphql"))
    ).toBe(false);
  });

  it("fetches exact remote item state counts only for the repositories supplied", async () => {
    const flags = { participating: true, watched: false, orgMember: false };
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/graphql")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(String(body.query)).toContain("RepositoryItemStateCounts");
        expect(JSON.stringify(body.variables)).toContain("acme");
        expect(JSON.stringify(body.variables)).not.toContain("hidden");
        return jsonResponse({
          data: {
            r0: {
              issuesOpen: { totalCount: 1 },
              pullRequestsOpen: { totalCount: 2 },
              discussionsOpen: { totalCount: 3 },
              issuesClosed: { totalCount: 4 },
              pullRequestsClosed: { totalCount: 5 },
              pullRequestsMerged: { totalCount: 7 },
              discussionsClosed: { totalCount: 6 }
            }
          }
        });
      }
      throw new Error(`Unexpected request: ${target}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const stateCounts = await fetchRepositoryItemStateCounts(connection, [
      {
        owner: "acme",
        name: "visible",
        fullName: "acme/visible",
        openIssuesCount: 0,
        pushedAt: "",
        ...flags
      }
    ]);
    const openCounts = await fetchRepositoryOpenItemCounts(connection, [
      {
        owner: "acme",
        name: "visible",
        fullName: "acme/visible",
        openIssuesCount: 0,
        pushedAt: "",
        ...flags
      }
    ]);

    expect(stateCounts).toEqual({ "acme/visible": { open: 6, closed: 22 } });
    expect(openCounts).toEqual({ "acme/visible": 6 });
  });

  it("tags repositories by access source and merges duplicates", async () => {
    const repo = (owner: string, name: string) => ({
      name,
      full_name: `${owner}/${name}`,
      owner: { login: owner },
      open_issues_count: 1,
      pushed_at: "2026-07-01T00:00:00Z"
    });
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
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
      if (target.includes("/graphql")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(String(body.query)).toContain("issues(states: OPEN)");
        expect(String(body.query)).toContain("pullRequests(states: OPEN)");
        expect(String(body.query)).toContain("discussions(states: OPEN)");
        return jsonResponse({
          data: {
            r0: {
              issues: { totalCount: 2 },
              pullRequests: { totalCount: 3 },
              discussions: { totalCount: 4 }
            },
            r1: {
              issues: { totalCount: 0 },
              pullRequests: { totalCount: 5 },
              discussions: { totalCount: 0 }
            },
            r2: {
              issues: { totalCount: 1 },
              pullRequests: { totalCount: 1 },
              discussions: { totalCount: 1 }
            },
            r3: {
              issues: { totalCount: 9 },
              pullRequests: { totalCount: 0 },
              discussions: { totalCount: 2 }
            }
          }
        });
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
      watched: false,
      openIssuesCount: 9
    });
    expect(byName["pi/agent-dev"]).toMatchObject({
      participating: false,
      orgMember: true,
      watched: false,
      openIssuesCount: 3
    });
    expect(byName["acme/shared"]).toMatchObject({
      participating: true,
      orgMember: true,
      openIssuesCount: 5
    });
    expect(byName["vendor/watched-only"]).toMatchObject({
      watched: true,
      openIssuesCount: 11
    });
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

  it("includes watched repositories beyond the first five subscription pages", async () => {
    const repoAt = (index: number) => ({
      name: `watched-${index}`,
      full_name: `pi/watched-${index}`,
      owner: { login: "pi" },
      open_issues_count: 0,
      pushed_at: "2026-07-01T00:00:00Z"
    });
    const fullPage = Array.from({ length: 100 }, (_, index) => repoAt(index));
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = new URL(String(url));
      if (target.pathname.endsWith("/user/subscriptions")) {
        return Number(target.searchParams.get("page")) <= 5
          ? jsonResponse(fullPage)
          : jsonResponse([
              {
                name: "orderbot",
                full_name: "pi/orderbot",
                owner: { login: "pi" },
                open_issues_count: 0,
                pushed_at: "2026-05-11T00:00:00Z"
              }
            ]);
      }
      return jsonResponse([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const repos = await fetchMyRepositorySummaries(connection);

    expect(repos).toContainEqual(
      expect.objectContaining({
        fullName: "pi/orderbot",
        watched: true
      })
    );
    expect(
      fetchMock.mock.calls.some((call) =>
        String(call[0]).includes("/user/subscriptions?per_page=100&page=6")
      )
    ).toBe(true);
  });

  it("continues watched repository pagination when a short page still has a next link", async () => {
    const repoAt = (index: number) => ({
      name: `watched-${index}`,
      full_name: `pi/watched-${index}`,
      owner: { login: "pi" },
      open_issues_count: 0,
      pushed_at: "2026-07-01T00:00:00Z"
    });
    const shortPage = Array.from({ length: 99 }, (_, index) => repoAt(index));
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = new URL(String(url));
      if (target.pathname.endsWith("/user/subscriptions")) {
        return target.searchParams.get("page") === "1"
          ? new Response(JSON.stringify(shortPage), {
              status: 200,
              headers: {
                "content-type": "application/json",
                Link: '<https://api.github.com/user/subscriptions?per_page=100&page=2>; rel="next"'
              }
            })
          : jsonResponse([
              {
                name: "orderbot",
                full_name: "pi/orderbot",
                owner: { login: "pi" },
                open_issues_count: 0,
                pushed_at: "2026-05-11T00:00:00Z"
              }
            ]);
      }
      return jsonResponse([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const repos = await fetchMyRepositorySummaries(connection);

    expect(repos).toContainEqual(
      expect.objectContaining({
        fullName: "pi/orderbot",
        watched: true
      })
    );
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
            open_issues_count: 7,
            pushed_at: "2026-07-01T00:00:00Z"
          }
        ]);
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const repos = await fetchMyRepositories(connection);

    expect(repos.map((repo) => repo.fullName)).toEqual(["doortts/mine"]);
    expect(repos[0].openIssuesCount).toBe(7);
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
