import { useCallback, useEffect, useState } from "react";
import { githubOAuthCredentialsFor, githubScopes } from "../githubAuthConfig";
import { deriveHostUrl } from "../services/githubServers";
import { loginWithOAuth } from "../services/oauth";
import type { UseGithubServersResult } from "./useGithubServers";

/** Connection facts the API-consuming features need. */
export interface GithubConnection {
  apiBaseUrl: string;
  webBaseUrl: string;
  token: string;
}

export type GithubAuthMethod = "personal_token" | "oauth";

export interface UseGithubAuthResult {
  connection: GithubConnection;
  authMethod: GithubAuthMethod;
  signedIn: boolean;
  loggingIn: boolean;
  error: string | null;
  login: () => Promise<void>;
  logout: () => void;
}

/**
 * Authentication for the selected GitHub server, mirroring the Flutter
 * client: a saved personal token signs in directly and skips OAuth; servers
 * with registered OAuth credentials use the loopback browser flow. Switching
 * servers drops the in-memory OAuth session so the user logs in again.
 */
export function useGithubAuth(servers: UseGithubServersResult): UseGithubAuthResult {
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSessionToken(null);
    setError(null);
  }, [servers.selectedUrl]);

  const personalToken = servers.tokenOf(servers.selectedUrl);
  const token = personalToken ?? sessionToken ?? "";
  const authMethod: GithubAuthMethod = personalToken ? "personal_token" : "oauth";

  const login = useCallback(async () => {
    setError(null);
    if (personalToken) {
      // Personal-token servers are signed in as soon as the token is stored.
      return;
    }

    const credentials = githubOAuthCredentialsFor(servers.selectedUrl);
    if (!credentials) {
      setError(
        `OAuth credentials are not registered for ${servers.selectedUrl}. ` +
          "Edit the server and save a personal access token instead."
      );
      return;
    }

    setLoggingIn(true);
    try {
      const accessToken = await loginWithOAuth({
        apiBaseUrl: servers.selectedUrl,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        scopes: githubScopes
      });
      setSessionToken(accessToken);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoggingIn(false);
    }
  }, [personalToken, servers.selectedUrl]);

  const logout = useCallback(() => {
    setSessionToken(null);
  }, []);

  return {
    connection: {
      apiBaseUrl: servers.selectedUrl,
      webBaseUrl: deriveHostUrl(servers.selectedUrl),
      token
    },
    authMethod,
    signedIn: token !== "",
    loggingIn,
    error,
    login,
    logout
  };
}
