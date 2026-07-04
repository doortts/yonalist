import type { ItemDocument, ItemKind, ItemState } from "../domain/types";
import { itemMainPath } from "../domain/paths";
import type { GithubConnection } from "../hooks/useGithubAuth";
import { createGitHubTransport } from "./githubTransport";

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
  comments?: number;
}

interface SearchIssuesResponse {
  items?: SearchIssueItem[];
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
  url?: string;
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
  commentsCount?: number;
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
      comments_count: input.commentsCount,
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
  const transport = createGitHubTransport(connection);
  const params = new URLSearchParams({
    q: query,
    sort: "updated",
    order: "desc",
    per_page: String(PAGE_SIZE)
  });
  const response = await transport.requestJson<SearchIssuesResponse>(
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
      commentsCount: item.comments,
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
        url
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

const REPO_DISCUSSIONS_QUERY = `
query ($owner: String!, $repo: String!, $first: Int!) {
  repository(owner: $owner, name: $repo) {
    discussions(first: $first, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number
        title
        body
        url
        closed
        createdAt
        updatedAt
        author { login }
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
  const data = await createGitHubTransport(connection).graphql<{
    search: { nodes: DiscussionSearchNode[] };
  }>(DISCUSSION_SEARCH_QUERY, { q: query, first: PAGE_SIZE });

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
        htmlUrl: node.url,
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
  const data = await createGitHubTransport(connection).graphql<{
    repository?: { discussions?: { nodes?: DiscussionSearchNode[] } } | null;
  }>(REPO_DISCUSSIONS_QUERY, { owner, repo, first: PAGE_SIZE });

  return (data.repository?.discussions?.nodes ?? []).map((item) =>
    toItemDocument({
      host,
      owner,
      repo,
      kind: "discussion",
      number: item.number ?? 0,
      title: item.title ?? `#${item.number}`,
      state: item.closed ? "closed" : "open",
      author: item.author?.login ?? "unknown",
      labels: (item.labels?.nodes ?? [])
        .map((label) => label.name ?? "")
        .filter(Boolean),
      createdAt: item.createdAt ?? "",
      updatedAt: item.updatedAt ?? "",
      htmlUrl: item.url,
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

const REPO_PAGE_SIZE = 100;
const MAX_REPO_PAGES = 5;

/** Follows pagination so large org memberships are not cut off at 100. */
async function requestAllPages(
  connection: GithubConnection,
  pathForPage: (page: number) => string
): Promise<UserRepoItem[]> {
  const collected: UserRepoItem[] = [];
  for (let page = 1; page <= MAX_REPO_PAGES; page += 1) {
    const items = await createGitHubTransport(connection).requestJson<UserRepoItem[]>(
      pathForPage(page)
    );
    if (!Array.isArray(items)) {
      break;
    }
    collected.push(...items);
    if (items.length < REPO_PAGE_SIZE) {
      break;
    }
  }
  return collected;
}

function userReposPath(affiliation: string, page: number): string {
  const params = new URLSearchParams({
    affiliation,
    sort: "pushed",
    per_page: String(REPO_PAGE_SIZE),
    page: String(page)
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
    requestAllPages(connection, (page) => userReposPath("owner,collaborator", page)),
    // Team/org membership repos (e.g. pi/agent-dev); optional per instance.
    requestAllPages(connection, (page) =>
      userReposPath("organization_member", page)
    ).catch(() => []),
    requestAllPages(
      connection,
      (page) => `/user/subscriptions?per_page=${REPO_PAGE_SIZE}&page=${page}`
    ).catch(() => [])
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
