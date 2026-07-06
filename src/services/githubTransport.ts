export interface GitHubTransportOptions {
  token: string;
  apiBaseUrl: string;
  webBaseUrl: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
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

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, "");
}

export function encodePathSegment(value: string | number): string {
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

export function graphqlUrl(apiBaseUrl: string): string {
  const base = trimTrailingSlash(apiBaseUrl);
  if (/\/api\/v\d+$/.test(base)) {
    return base.replace(/\/api\/v\d+$/, "/api/graphql");
  }
  return `${base}/graphql`;
}

export function createGitHubTransport(options: GitHubTransportOptions) {
  const fetcher = options.fetch ?? fetch;
  const apiBaseUrl = trimTrailingSlash(options.apiBaseUrl);
  const webBaseUrl = trimTrailingSlash(options.webBaseUrl);

  async function request(
    path: string,
    init: RequestInit = {}
  ): Promise<Response> {
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
      signal: init.signal ?? options.signal,
      headers
    });

    if (!response.ok) {
      throw new GitHubRequestError(
        response.status,
        await extractErrorDetail(response)
      );
    }

    return response;
  }

  async function requestJson<TResponse>(
    path: string,
    init: RequestInit = {}
  ): Promise<TResponse> {
    const response = await request(path, init);
    return (await response.json()) as TResponse;
  }

  async function postOAuth<TResponse>(
    path: string,
    body: URLSearchParams
  ): Promise<TResponse> {
    const response = await fetcher(`${webBaseUrl}${path}`, {
      method: "POST",
      signal: options.signal,
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

  async function graphql<TResponse>(
    query: string,
    variables: Record<string, unknown>
  ): Promise<TResponse> {
    const response = await fetcher(graphqlUrl(apiBaseUrl), {
      method: "POST",
      signal: options.signal,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: options.token ? `Bearer ${options.token}` : "",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      body: JSON.stringify({ query, variables })
    });

    if (!response.ok) {
      throw new GitHubRequestError(
        response.status,
        await extractErrorDetail(response)
      );
    }

    const payload = (await response.json()) as {
      data?: TResponse;
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

  return { apiBaseUrl, webBaseUrl, request, requestJson, postOAuth, graphql };
}
