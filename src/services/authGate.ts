import type { GithubConnection } from "../hooks/useGithubAuth";

const lastAuthenticatedKey = "yonalist.github.lastAuthenticatedUrl.v1";
const skipLoginKey = "yonalist.auth.skipLogin.v1";

/** The API base URL that last passed authentication; assumed at startup. */
export function loadLastAuthenticatedUrl(): string | null {
  try {
    return window.localStorage.getItem(lastAuthenticatedKey);
  } catch {
    return null;
  }
}

export function persistLastAuthenticatedUrl(url: string) {
  try {
    window.localStorage.setItem(lastAuthenticatedKey, url);
  } catch {
    // Startup simply falls back to the selected server without persistence.
  }
}

/** Remembers that the user chose to browse sample data without signing in. */
export function loadSkipLogin(): boolean {
  try {
    return window.localStorage.getItem(skipLoginKey) === "true";
  } catch {
    return false;
  }
}

export function persistSkipLogin(skip: boolean) {
  try {
    if (skip) {
      window.localStorage.setItem(skipLoginKey, "true");
    } else {
      window.localStorage.removeItem(skipLoginKey);
    }
  } catch {
    // The choice still applies for this session.
  }
}

/**
 * Distinguishes "the token is definitively rejected" from "the server just
 * could not be reached" so the offline-first gate only kicks the user back to
 * the login page for real auth failures.
 */
export type ConnectionCheck = "ok" | "invalid" | "unreachable";

/** Verifies the stored credentials by asking GitHub for the current user. */
export async function checkConnection(
  connection: GithubConnection,
  fetchImpl: typeof fetch = fetch
): Promise<ConnectionCheck> {
  try {
    const base = connection.apiBaseUrl.replace(/\/+$/, "");
    const response = await fetchImpl(`${base}/user`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${connection.token}`,
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
    if (response.ok) {
      return "ok";
    }
    // 401/403 mean the credentials themselves were rejected; anything else
    // (5xx, proxies, rate limits) should not sign the user out.
    return response.status === 401 || response.status === 403
      ? "invalid"
      : "unreachable";
  } catch {
    return "unreachable";
  }
}

export async function validateConnection(
  connection: GithubConnection,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  return (await checkConnection(connection, fetchImpl)) === "ok";
}
