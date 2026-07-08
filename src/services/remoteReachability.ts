import { trimTrailingSlash } from "./githubTransport";

/** Connection facts needed to probe a remote GitHub server. */
export interface RemoteReachabilityConnection {
  apiBaseUrl: string;
  token: string;
}

export interface RemoteReachabilityOptions {
  /** Abort the probe after this many milliseconds. Defaults to 4000. */
  timeoutMs?: number;
  /** Injectable fetch, primarily for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 4000;

/**
 * Confirms the configured GitHub server is actually reachable — not merely that
 * the OS reports connectivity. `navigator.onLine` only means a network exists;
 * an intranet GHE host can be unreachable even with a live internet connection
 * (and vice versa). We hit a deliberately cheap endpoint (`/rate_limit`) with
 * `cache: "no-store"` so a stale proxy hit cannot masquerade as reachability,
 * carry the auth header (intranet hosts often refuse anonymous probes), and
 * bound the wait with an AbortController. Any failure — HTTP error, timeout, or
 * network error — resolves to `false`; the caller then simply does not prompt.
 */
export async function isRemoteReachable(
  connection: RemoteReachabilityConnection,
  options: RemoteReachabilityOptions = {}
): Promise<boolean> {
  const base = trimTrailingSlash(connection.apiBaseUrl);
  if (!base) {
    return false;
  }

  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = new Headers();
    headers.set("Accept", "application/vnd.github+json");
    headers.set("X-GitHub-Api-Version", "2022-11-28");
    const token = connection.token.trim();
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }

    const response = await fetcher(`${base}/rate_limit`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      headers
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
