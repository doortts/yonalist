/**
 * GitHub OAuth App credentials and built-in server list, mirrored from the
 * Flutter github_client (lib/github_oauth_credentials.dart).
 */

export interface GithubOAuthCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * OAuth App credentials per GitHub API base URL. Switching the base API
 * injects the matching entry into the OAuth flow; unregistered URLs (e.g. a
 * custom GHE instance) return null and are guided to personal-token login.
 */
const credentialsByBaseUrl: Record<string, GithubOAuthCredentials> = {
  "https://oss.navercorp.com/api/v3": {
    clientId: "d7165a7a207606b3a1c7",
    clientSecret: "5129e0384f21e8be2f1030caf6298d5c62fd1cfa"
  },
  "https://es.naverlabs.com/api/v3": {
    clientId: "ab75d9083489cf8666bf",
    clientSecret: "e1441e9e88d994a259138c7e494872f9c1bfd590"
  },
  "https://api.github.com": {
    clientId: "Ov23liYSh18IFNEqCz4v",
    clientSecret: "77acb5fd6a20636a5e2934180dfe89dd779541ed"
  }
};

export function githubOAuthCredentialsFor(
  apiBaseUrl: string
): GithubOAuthCredentials | null {
  const normalized = apiBaseUrl.trim().replace(/\/+$/, "");
  return credentialsByBaseUrl[normalized] ?? null;
}

export const githubScopes = ["repo", "read:org"];

/** Built-in default GitHub API base URLs; the first entry is the default. */
export const defaultGithubApiBaseUrls: string[] = [
  "https://oss.navercorp.com/api/v3",
  "https://es.naverlabs.com/api/v3",
  "https://api.github.com"
];

/** Aliases pre-seeded for the default URLs. */
export const defaultGithubApiBaseAliases: Record<string, string> = {
  "https://oss.navercorp.com/api/v3": "네이버",
  "https://es.naverlabs.com/api/v3": "네이버 랩스",
  "https://api.github.com": "Github"
};
