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

export interface GitHubResponseMeta {
  etag: string | null;
  lastModified: string | null;
}

export interface ConditionalHeadResult {
  unchanged: boolean;
  meta: GitHubResponseMeta;
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

  function responseMeta(response: Response): GitHubResponseMeta {
    return {
      etag: response.headers.get("ETag"),
      lastModified: response.headers.get("Last-Modified")
    };
  }

  async function rawRequest(
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
      // Bypass the WebView HTTP cache: the app caches results itself, and a
      // stale proxy 304 surfaced as a fresh 200 body is the same staleness
      // hazard that affects notifications. Applies to work-item reads too.
      cache: "no-store",
      signal: init.signal ?? options.signal,
      headers
    });
    return response;
  }

  async function request(
    path: string,
    init: RequestInit = {}
  ): Promise<Response> {
    const response = await rawRequest(path, init);

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

  async function requestJsonWithMeta<TResponse>(
    path: string,
    init: RequestInit = {}
  ): Promise<{ data: TResponse; meta: GitHubResponseMeta }> {
    const response = await request(path, init);
    return {
      data: (await response.json()) as TResponse,
      meta: responseMeta(response)
    };
  }

  async function conditionalHead(
    path: string,
    validators: GitHubResponseMeta
  ): Promise<ConditionalHeadResult> {
    const headers = new Headers();
    if (validators.etag) {
      headers.set("If-None-Match", validators.etag);
    }
    if (validators.lastModified) {
      headers.set("If-Modified-Since", validators.lastModified);
    }
    const response = await rawRequest(path, { method: "HEAD", headers });
    if (response.status === 304) {
      return { unchanged: true, meta: responseMeta(response) };
    }
    if (!response.ok) {
      throw new GitHubRequestError(
        response.status,
        await extractErrorDetail(response)
      );
    }
    return { unchanged: false, meta: responseMeta(response) };
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
      cache: "no-store",
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

  return {
    apiBaseUrl,
    webBaseUrl,
    request,
    requestJson,
    requestJsonWithMeta,
    conditionalHead,
    postOAuth,
    graphql
  };
}
