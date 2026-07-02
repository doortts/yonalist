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

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, "");
}

function encodePathSegment(value: string | number): string {
  return encodeURIComponent(String(value));
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
    headers.set("Content-Type", "application/json");
    headers.set("X-GitHub-Api-Version", "2022-11-28");
    if (options.token) {
      headers.set("Authorization", `Bearer ${options.token}`);
    }

    const response = await fetcher(`${apiBaseUrl}${path}`, {
      ...init,
      headers
    });

    if (!response.ok) {
      throw new Error(`GitHub request failed with ${response.status}.`);
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
      throw new Error(`GitHub OAuth request failed with ${response.status}.`);
    }

    return (await response.json()) as TResponse;
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

    listIssueComments(owner: string, repo: string, number: number) {
      return requestJson(
        `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues/${encodePathSegment(number)}/comments`,
        { method: "GET" }
      );
    },

    startDeviceFlow(input: DeviceFlowInput) {
      return postOAuth("/login/device/code", new URLSearchParams({
        client_id: input.clientId,
        scope: input.scopes.join(" ")
      }));
    },

    pollDeviceFlow(input: PollDeviceFlowInput) {
      return postOAuth("/login/oauth/access_token", new URLSearchParams({
        client_id: input.clientId,
        device_code: input.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code"
      }));
    }
  };
}
