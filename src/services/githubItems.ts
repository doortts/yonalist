import type { ItemDocument, ItemKind, ItemState } from "../domain/types";
import { itemMainPath } from "../domain/paths";
import type { GithubConnection } from "../hooks/useGithubAuth";
import { GitHubRequestError } from "./github";

/**
 * Fetches the signed-in user's work items (issues, pull requests,
 * discussions) and participating repositories, normalized into the vault
 * ItemDocument shape so the list/detail panes render them like local items.
 */

const VAULT_ROOT = "/vault";
const PAGE_SIZE = 50;

export interface RepositorySummary {
  owner: string;
  name: string;
  fullName: string;
  openIssuesCount: number;
  pushedAt: string;
  /** Owned by or directly collaborating with the user. */
  participating: boolean;
  /** Watched (subscribed) by the user. */
  watched: boolean;
  /** Reachable only through an organization membership. */
  orgMember: boolean;
}

export interface OwnerGroup {
  owner: string;
  repositories: RepositorySummary[];
}

interface SearchIssueItem {
  number: number;
  title?: string;
  state?: string;
  body?: string | null;
  user?: { login?: string };
  labels?: Array<{ name?: string } | string>;
  created_at?: string;
  updated_at?: string;
  html_url?: string;
  pull_request?: unknown;
  repository_url?: string;
}

interface SearchIssuesResponse {
  items?: SearchIssueItem[];
}

interface RestDiscussionItem {
  number: number;
  title?: string;
  state?: string;
  body?: string | null;
  user?: { login?: string };
  labels?: Array<{ name?: string } | string>;
  created_at?: string;
  updated_at?: string;
  html_url?: string;
}

interface UserRepoItem {
  name?: string;
  full_name?: string;
  owner?: { login?: string };
  open_issues_count?: number;
  pushed_at?: string;
}

interface DiscussionSearchNode {
  number?: number;
  title?: string;
  body?: string;
  closed?: boolean;
  createdAt?: string;
  updatedAt?: string;
  author?: { login?: string } | null;
  repository?: { name?: string; owner?: { login?: string } };
  labels?: { nodes?: Array<{ name?: string }> };
}

function hostOf(connection: GithubConnection): string {
  try {
    return new URL(connection.webBaseUrl).host;
  } catch {
    return connection.webBaseUrl;
  }
}

function apiHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

async function requestJson<T>(connection: GithubConnection, path: string): Promise<T> {
  const base = connection.apiBaseUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}${path}`, {
    headers: apiHeaders(connection.token)
  });
  if (!response.ok) {
    throw new GitHubRequestError(response.status, "");
  }
  return (await response.json()) as T;
}

function graphqlUrl(connection: GithubConnection): string {
  const base = connection.apiBaseUrl.replace(/\/+$/, "");
  if (/\/api\/v\d+$/.test(base)) {
    return base.replace(/\/api\/v\d+$/, "/api/graphql");
  }
  return `${base}/graphql`;
}

async function graphql<T>(
  connection: GithubConnection,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const response = await fetch(graphqlUrl(connection), {
    method: "POST",
    headers: {
      ...apiHeaders(connection.token),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, variables })
  });
  if (!response.ok) {
    throw new GitHubRequestError(response.status, "");
  }
  const payload = (await response.json()) as {
    data?: T;
    errors?: Array<{ message?: string }>;
  };
  if (payload.errors?.length) {
    throw new Error(payload.errors[0].message ?? "GraphQL request failed.");
  }
  if (!payload.data) {
    throw new Error("GraphQL response has no data.");
  }
  return payload.data;
}

function labelNames(labels: Array<{ name?: string } | string> | undefined): string[] {
  return (labels ?? [])
    .map((label) => (typeof label === "string" ? label : label.name ?? ""))
    .filter(Boolean);
}

function normalizeState(state: string | undefined): ItemState {
  return state === "closed" || state === "merged" ? state : "open";
}

function toItemDocument(input: {
  host: string;
  owner: string;
  repo: string;
  kind: ItemKind;
  number: number;
  title: string;
  state: ItemState;
  author: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  htmlUrl?: string;
  body: string;
}): ItemDocument {
  const identity = {
    kind: input.kind,
    host: input.host,
    owner: input.owner,
    repo: input.repo,
    number: input.number
  };
  return {
    path: itemMainPath(VAULT_ROOT, identity),
    body: input.body,
    frontMatter: {
      ...identity,
      html_url: input.htmlUrl,
      title: input.title,
      state: input.state,
      author: input.author,
      labels: input.labels,
      created_at: input.createdAt,
      updated_at: input.updatedAt,
      local: { favorite: false },
      sync: { status: "synced" }
    }
  };
}

function ownerRepoFromRepositoryUrl(repositoryUrl: string | undefined): {
  owner: string;
  repo: string;
} {
  const segments = (repositoryUrl ?? "").split("/").filter(Boolean);
  return {
    owner: segments[segments.length - 2] ?? "unknown",
    repo: segments[segments.length - 1] ?? "unknown"
  };
}

async function searchIssues(
  connection: GithubConnection,
  query: string
): Promise<ItemDocument[]> {
  const host = hostOf(connection);
  const params = new URLSearchParams({
    q: query,
    sort: "updated",
    order: "desc",
    per_page: String(PAGE_SIZE)
  });
  const response = await requestJson<SearchIssuesResponse>(
    connection,
    `/search/issues?${params.toString()}`
  );

  return (response.items ?? []).map((item) => {
    const { owner, repo } = ownerRepoFromRepositoryUrl(item.repository_url);
    return toItemDocument({
      host,
      owner,
      repo,
      kind: item.pull_request ? "pull" : "issue",
      number: item.number,
      title: item.title ?? `#${item.number}`,
      state: normalizeState(item.state),
      author: item.user?.login ?? "unknown",
      labels: labelNames(item.labels),
      createdAt: item.created_at ?? "",
      updatedAt: item.updated_at ?? "",
      htmlUrl: item.html_url,
      body: item.body ?? ""
    });
  });
}

const DISCUSSION_SEARCH_QUERY = `
query ($q: String!, $first: Int!) {
  search(query: $q, type: DISCUSSION, first: $first) {
    nodes {
      ... on Discussion {
        number
        title
        body
        closed
        createdAt
        updatedAt
        author { login }
        repository { name owner { login } }
        labels(first: 10) { nodes { name } }
      }
    }
  }
}`;

async function searchDiscussions(
  connection: GithubConnection,
  query: string
): Promise<ItemDocument[]> {
  const host = hostOf(connection);
  const data = await graphql<{ search: { nodes: DiscussionSearchNode[] } }>(
    connection,
    DISCUSSION_SEARCH_QUERY,
    { q: query, first: PAGE_SIZE }
  );

  return data.search.nodes
    .filter((node) => typeof node.number === "number")
    .map((node) =>
      toItemDocument({
        host,
        owner: node.repository?.owner?.login ?? "unknown",
        repo: node.repository?.name ?? "unknown",
        kind: "discussion",
        number: node.number as number,
        title: node.title ?? `#${node.number}`,
        state: node.closed ? "closed" : "open",
        author: node.author?.login ?? "unknown",
        labels: (node.labels?.nodes ?? [])
          .map((label) => label.name ?? "")
          .filter(Boolean),
        createdAt: node.createdAt ?? "",
        updatedAt: node.updatedAt ?? "",
        body: node.body ?? ""
      })
    );
}

async function listRepoDiscussions(
  connection: GithubConnection,
  owner: string,
  repo: string
): Promise<ItemDocument[]> {
  const host = hostOf(connection);
  const items = await requestJson<RestDiscussionItem[]>(
    connection,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/discussions?per_page=${PAGE_SIZE}`
  );

  return items.map((item) =>
    toItemDocument({
      host,
      owner,
      repo,
      kind: "discussion",
      number: item.number,
      title: item.title ?? `#${item.number}`,
      state: normalizeState(item.state),
      author: item.user?.login ?? "unknown",
      labels: labelNames(item.labels),
      createdAt: item.created_at ?? "",
      updatedAt: item.updated_at ?? "",
      htmlUrl: item.html_url,
      body: item.body ?? ""
    })
  );
}

function sortByUpdatedDesc(items: ItemDocument[]): ItemDocument[] {
  return items.sort((left, right) =>
    right.frontMatter.updated_at.localeCompare(left.frontMatter.updated_at)
  );
}

/** Issues + PRs + discussions the signed-in user is involved in. */
export async function fetchMyWorkItems(
  connection: GithubConnection
): Promise<ItemDocument[]> {
  const [issuePulls, discussions] = await Promise.all([
    searchIssues(connection, "involves:@me"),
    // Discussion search needs GraphQL; older GHE instances may lack it.
    searchDiscussions(connection, "involves:@me").catch(() => [])
  ]);
  return sortByUpdatedDesc([...issuePulls, ...discussions]);
}

/** Every issue, PR, and discussion of one repository, newest first. */
export async function fetchRepoWorkItems(
  connection: GithubConnection,
  owner: string,
  repo: string
): Promise<ItemDocument[]> {
  const [issuePulls, discussions] = await Promise.all([
    searchIssues(connection, `repo:${owner}/${repo}`),
    listRepoDiscussions(connection, owner, repo).catch(() => [])
  ]);
  return sortByUpdatedDesc([...issuePulls, ...discussions]);
}

function toSummaries(
  repos: UserRepoItem[],
  flags: Pick<RepositorySummary, "participating" | "watched" | "orgMember">
): RepositorySummary[] {
  if (!Array.isArray(repos)) {
    return [];
  }
  return repos
    .filter((repo) => repo.name && repo.owner?.login)
    .map((repo) => ({
      owner: repo.owner?.login ?? "",
      name: repo.name ?? "",
      fullName: repo.full_name ?? `${repo.owner?.login}/${repo.name}`,
      openIssuesCount: repo.open_issues_count ?? 0,
      pushedAt: repo.pushed_at ?? "",
      ...flags
    }));
}

function userReposPath(affiliation: string): string {
  const params = new URLSearchParams({
    affiliation,
    sort: "pushed",
    per_page: "100"
  });
  return `/user/repos?${params.toString()}`;
}

/**
 * Repositories the user can reach, tagged by how: owned/directly
 * collaborating, watched (subscribed), or via an organization/team
 * membership. The sidebar decides visibility from these flags.
 */
export async function fetchMyRepositories(
  connection: GithubConnection
): Promise<RepositorySummary[]> {
  const noFlags = { participating: false, watched: false, orgMember: false };
  const [participating, orgMember, watched] = await Promise.all([
    requestJson<UserRepoItem[]>(
      connection,
      userReposPath("owner,collaborator")
    ),
    // Team/org membership repos (e.g. pi/agent-dev); optional per instance.
    requestJson<UserRepoItem[]>(
      connection,
      userReposPath("organization_member")
    ).catch(() => []),
    requestJson<UserRepoItem[]>(connection, "/user/subscriptions?per_page=100").catch(
      () => []
    )
  ]);

  const merged = new Map<string, RepositorySummary>();
  const upsert = (
    summaries: RepositorySummary[],
    flag: keyof typeof noFlags
  ) => {
    for (const summary of summaries) {
      const existing = merged.get(summary.fullName) ?? summary;
      merged.set(summary.fullName, { ...existing, [flag]: true });
    }
  };
  upsert(toSummaries(participating, noFlags), "participating");
  upsert(toSummaries(orgMember, noFlags), "orgMember");
  upsert(toSummaries(watched, noFlags), "watched");

  return [...merged.values()];
}

/** Groups repositories by owner, owners alphabetical, repos by recent push. */
export function groupRepositoriesByOwner(
  repositories: RepositorySummary[]
): OwnerGroup[] {
  const groups = new Map<string, RepositorySummary[]>();
  for (const repository of repositories) {
    const group = groups.get(repository.owner) ?? [];
    group.push(repository);
    groups.set(repository.owner, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([owner, repos]) => ({
      owner,
      repositories: repos.sort((a, b) => b.pushedAt.localeCompare(a.pushedAt))
    }));
}
