interface GitHubClientOptions {
  token: string;
  apiBaseUrl: string;
  webBaseUrl: string;
  fetch?: typeof fetch;
}

interface CreateIssueInput {
  title: string;
  body: string;
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

export class GitHubRequestError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(
      detail
        ? `GitHub request failed with ${status}: ${detail}`
        : `GitHub request failed with ${status}.`
    );
    this.name = "GitHubRequestError";
    this.status = status;
    this.detail = detail;
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, "");
}

function encodePathSegment(value: string | number): string {
  return encodeURIComponent(String(value));
}

async function extractErrorDetail(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { message?: string };
    return payload.message ?? "";
  } catch {
    return "";
  }
}

export function createGitHubClient(options: GitHubClientOptions) {
  const fetcher = options.fetch ?? fetch;
  const apiBaseUrl = trimTrailingSlash(options.apiBaseUrl);
  const webBaseUrl = trimTrailingSlash(options.webBaseUrl);

  async function requestJson<TResponse>(
    path: string,
    init: RequestInit
  ): Promise<TResponse> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/vnd.github+json");
    headers.set("X-GitHub-Api-Version", "2022-11-28");
    if (init.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    if (options.token) {
      headers.set("Authorization", `Bearer ${options.token}`);
    }

    const response = await fetcher(`${apiBaseUrl}${path}`, {
      ...init,
      headers
    });

    if (!response.ok) {
      throw new GitHubRequestError(
        response.status,
        await extractErrorDetail(response)
      );
    }

    return (await response.json()) as TResponse;
  }

  async function postOAuth<TResponse>(
    path: string,
    body: URLSearchParams
  ): Promise<TResponse> {
    const response = await fetcher(`${webBaseUrl}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });

    if (!response.ok) {
      throw new GitHubRequestError(
        response.status,
        await extractErrorDetail(response)
      );
    }

    return (await response.json()) as TResponse;
  }

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
      return requestJson(`/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues`, {
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
      return requestJson(
        `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues/${encodePathSegment(number)}/comments`,
        {
          method: "POST",
          body: JSON.stringify({ body })
        }
      );
    },

    getIssue(owner: string, repo: string, number: number) {
      return requestJson(
        `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues/${encodePathSegment(number)}`,
        { method: "GET" }
      );
    },

    getPull(owner: string, repo: string, number: number) {
      return requestJson(
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
      return requestJson(
        `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues/${encodePathSegment(number)}/comments${listQuery(options)}`,
        { method: "GET" }
      );
    },

    getDiscussion(owner: string, repo: string, number: number) {
      return requestJson(
        `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/discussions/${encodePathSegment(number)}`,
        { method: "GET" }
      );
    },

    listDiscussionComments(
      owner: string,
      repo: string,
      number: number,
      options: ListOptions = {}
    ) {
      return requestJson(
        `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/discussions/${encodePathSegment(number)}/comments${listQuery(options)}`,
        { method: "GET" }
      );
    },

    getRelease(owner: string, repo: string, releaseId: number) {
      return requestJson(
        `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/releases/${encodePathSegment(releaseId)}`,
        { method: "GET" }
      );
    },

    startDeviceFlow(input: DeviceFlowInput) {
      return postOAuth<DeviceCodeResponse>("/login/device/code", new URLSearchParams({
        client_id: input.clientId,
        scope: input.scopes.join(" ")
      }));
    },

    // GitHub reports polling states (authorization_pending, slow_down, ...)
    // as HTTP 200 with an `error` field; callers must check it.
    pollDeviceFlow(input: PollDeviceFlowInput) {
      return postOAuth<DeviceTokenResponse>("/login/oauth/access_token", new URLSearchParams({
        client_id: input.clientId,
        device_code: input.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code"
      }));
    }
  };
}

export type GitHubClient = ReturnType<typeof createGitHubClient>;
