import {
  createGitHubTransport,
  encodePathSegment,
  GitHubRequestError
} from "./githubTransport";
import type {
  DiscussionCloseReason,
  IssueCloseReason
} from "../domain/types";

interface GitHubClientOptions {
  token: string;
  apiBaseUrl: string;
  webBaseUrl: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

interface CreateIssueInput {
  title: string;
  body: string;
}

interface CloseIssueOptions {
  reason?: IssueCloseReason;
  duplicateIssueId?: number;
}

interface DeviceFlowInput {
  clientId: string;
  scopes: string[];
}

interface PollDeviceFlowInput extends DeviceFlowInput {
  deviceCode: string;
}

interface ListOptions {
  page?: number;
  perPage?: number;
}

interface GraphQLDiscussionNode {
  id?: string;
  title?: string;
  body?: string;
  closed?: boolean;
  createdAt?: string;
  updatedAt?: string;
  url?: string;
  author?: { login?: string; name?: string; avatarUrl?: string } | null;
  authorAssociation?: string;
  labels?: { nodes?: Array<{ name?: string; color?: string }> };
  comments?: {
    nodes?: GraphQLDiscussionCommentNode[];
  };
}

interface GraphQLDiscussionCommentNode {
  id?: string;
  databaseId?: number;
  body?: string;
  author?: { login?: string; name?: string; avatarUrl?: string } | null;
  authorAssociation?: string;
  createdAt?: string;
  updatedAt?: string;
  replies?: {
    nodes?: GraphQLDiscussionCommentNode[];
  };
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface DeviceTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export { GitHubRequestError };

const DISCUSSION_DETAIL_QUERY = `
query ($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    discussion(number: $number) {
      id
      title
      body
      closed
      createdAt
      updatedAt
      url
      author { login ... on User { name } avatarUrl }
      authorAssociation
      labels(first: 20) { nodes { name color } }
      comments(first: 100) {
        nodes {
          id
          databaseId
          body
          author { login ... on User { name } avatarUrl }
          authorAssociation
          createdAt
          updatedAt
          replies(first: 100) {
            nodes {
              id
              databaseId
              body
              author { login ... on User { name } avatarUrl }
              authorAssociation
              createdAt
              updatedAt
            }
          }
        }
      }
    }
  }
}`;

const ADD_DISCUSSION_COMMENT_MUTATION = `
mutation ($discussionId: ID!, $body: String!, $replyToId: ID) {
  addDiscussionComment(input: { discussionId: $discussionId, body: $body, replyToId: $replyToId }) {
    comment {
      id
      databaseId
      body
      createdAt
      updatedAt
      url
      author { login ... on User { name } avatarUrl }
      authorAssociation
    }
  }
}`;

const CLOSE_DISCUSSION_MUTATION = `
mutation ($discussionId: ID!, $reason: DiscussionCloseReason!) {
  closeDiscussion(input: { discussionId: $discussionId, reason: $reason }) {
    discussion {
      id
      closed
    }
  }
}`;

function discussionLabels(
  node: GraphQLDiscussionNode
): Array<{ name?: string; color?: string }> {
  return node.labels?.nodes ?? [];
}

function mapDiscussion(node: GraphQLDiscussionNode | null | undefined) {
  if (!node) {
    throw new Error("Discussion was not found.");
  }
  return {
    node_id: node.id,
    title: node.title,
    state: node.closed ? "closed" : "open",
    body: node.body,
    user: {
      login: node.author?.login,
      name: node.author?.name,
      avatar_url: node.author?.avatarUrl
    },
    author_association: node.authorAssociation,
    labels: discussionLabels(node),
    created_at: node.createdAt,
    updated_at: node.updatedAt,
    html_url: node.url
  };
}

function mapDiscussionComments(
  node: GraphQLDiscussionNode | null | undefined
) {
  if (!node) {
    throw new Error("Discussion was not found.");
  }
  function mapComment(comment: GraphQLDiscussionCommentNode): Record<string, unknown> {
    return {
      id: comment.databaseId ?? comment.id,
      node_id: comment.id,
      body: comment.body,
      user: {
        login: comment.author?.login,
        name: comment.author?.name,
        avatar_url: comment.author?.avatarUrl
      },
      author_association: comment.authorAssociation,
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
      replies: (comment.replies?.nodes ?? []).map(mapComment)
    };
  }
  return (node.comments?.nodes ?? []).map(mapComment);
}

function mapDiscussionComment(comment: GraphQLDiscussionCommentNode | null | undefined) {
  if (!comment) {
    throw new Error("Discussion comment was not returned.");
  }
  return {
    id: comment.databaseId ?? comment.id,
    node_id: comment.id,
    body: comment.body,
    user: {
      login: comment.author?.login,
      name: comment.author?.name,
      avatar_url: comment.author?.avatarUrl
    },
    author_association: comment.authorAssociation,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt
  };
}

export function createGitHubClient(options: GitHubClientOptions) {
  const transport = createGitHubTransport(options);

  function listQuery(options: ListOptions = {}): string {
    const params = new URLSearchParams();
    params.set("per_page", String(options.perPage ?? 100));
    if (options.page) {
      params.set("page", String(options.page));
    }
    return `?${params.toString()}`;
  }

  return {
    createIssue(owner: string, repo: string, issue: CreateIssueInput) {
      return transport.requestJson(`/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues`, {
        method: "POST",
        body: JSON.stringify(issue)
      });
    },

    createIssueComment(
      owner: string,
      repo: string,
      number: number,
      body: string
    ) {
      return transport.requestJson(
        `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues/${encodePathSegment(number)}/comments`,
        {
          method: "POST",
          body: JSON.stringify({ body })
        }
      );
    },

    closeIssue(
      owner: string,
      repo: string,
      number: number,
      options: CloseIssueOptions = {}
    ) {
      const body = {
        state: "closed",
        ...(options.reason ? { state_reason: options.reason } : {}),
        ...(options.duplicateIssueId !== undefined
          ? { duplicate_issue_id: options.duplicateIssueId }
          : {})
      };
      return transport.requestJson(
        `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues/${encodePathSegment(number)}`,
        {
          method: "PATCH",
          body: JSON.stringify(body)
        }
      );
    },

    closePullRequest(owner: string, repo: string, number: number) {
      return transport.requestJson(
        `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/pulls/${encodePathSegment(number)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ state: "closed" })
        }
      );
    },

    getIssue(owner: string, repo: string, number: number) {
      return transport.requestJson(
        `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues/${encodePathSegment(number)}`,
        { method: "GET" }
      );
    },

    getPull(owner: string, repo: string, number: number) {
      return transport.requestJson(
        `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/pulls/${encodePathSegment(number)}`,
        { method: "GET" }
      );
    },

    listIssueComments(
      owner: string,
      repo: string,
      number: number,
      options: ListOptions = {}
    ) {
      return transport.requestJson(
        `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues/${encodePathSegment(number)}/comments${listQuery(options)}`,
        { method: "GET" }
      );
    },

    async getDiscussion(owner: string, repo: string, number: number) {
      const data = await transport.graphql<{
        repository?: { discussion?: GraphQLDiscussionNode | null } | null;
      }>(DISCUSSION_DETAIL_QUERY, { owner, repo, number });
      return mapDiscussion(data.repository?.discussion);
    },

    async createDiscussionComment(
      owner: string,
      repo: string,
      number: number,
      body: string,
      options: { replyToId?: string } = {}
    ) {
      const discussionData = await transport.graphql<{
        repository?: { discussion?: GraphQLDiscussionNode | null } | null;
      }>(DISCUSSION_DETAIL_QUERY, { owner, repo, number });
      const discussionId = discussionData.repository?.discussion?.id;
      if (!discussionId) {
        throw new Error("Discussion node id was not returned.");
      }
      const data = await transport.graphql<{
        addDiscussionComment?: {
          comment?: GraphQLDiscussionCommentNode | null;
        } | null;
      }>(ADD_DISCUSSION_COMMENT_MUTATION, {
        discussionId,
        body,
        ...(options.replyToId ? { replyToId: options.replyToId } : {})
      });
      return mapDiscussionComment(data.addDiscussionComment?.comment);
    },

    async listDiscussionComments(
      owner: string,
      repo: string,
      number: number
    ) {
      const data = await transport.graphql<{
        repository?: { discussion?: GraphQLDiscussionNode | null } | null;
      }>(DISCUSSION_DETAIL_QUERY, { owner, repo, number });
      return mapDiscussionComments(data.repository?.discussion);
    },

    async closeDiscussion(
      owner: string,
      repo: string,
      number: number,
      reason: DiscussionCloseReason
    ) {
      const discussionData = await transport.graphql<{
        repository?: { discussion?: GraphQLDiscussionNode | null } | null;
      }>(DISCUSSION_DETAIL_QUERY, { owner, repo, number });
      const discussionId = discussionData.repository?.discussion?.id;
      if (!discussionId) {
        throw new Error("Discussion node id was not returned.");
      }
      return transport.graphql(CLOSE_DISCUSSION_MUTATION, {
        discussionId,
        reason: reason.toUpperCase()
      });
    },

    async getDiscussionWithComments(owner: string, repo: string, number: number) {
      const data = await transport.graphql<{
        repository?: { discussion?: GraphQLDiscussionNode | null } | null;
      }>(DISCUSSION_DETAIL_QUERY, { owner, repo, number });
      const discussion = data.repository?.discussion;
      return {
        discussion: mapDiscussion(discussion),
        comments: mapDiscussionComments(discussion)
      };
    },

    getRelease(owner: string, repo: string, releaseId: number) {
      return transport.requestJson(
        `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/releases/${encodePathSegment(releaseId)}`,
        { method: "GET" }
      );
    },

    startDeviceFlow(input: DeviceFlowInput) {
      return transport.postOAuth<DeviceCodeResponse>("/login/device/code", new URLSearchParams({
        client_id: input.clientId,
        scope: input.scopes.join(" ")
      }));
    },

    // GitHub reports polling states (authorization_pending, slow_down, ...)
    // as HTTP 200 with an `error` field; callers must check it.
    pollDeviceFlow(input: PollDeviceFlowInput) {
      return transport.postOAuth<DeviceTokenResponse>("/login/oauth/access_token", new URLSearchParams({
        client_id: input.clientId,
        device_code: input.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code"
      }));
    }
  };
}

export type GitHubClient = ReturnType<typeof createGitHubClient>;
