import { useCallback, useEffect, useState } from "react";
import { githubOAuthCredentialsFor, githubScopes } from "../githubAuthConfig";
import { deriveHostUrl } from "../services/githubServers";
import { loginWithOAuth } from "../services/oauth";
import {
  clearSessionToken,
  loadSessionToken,
  saveSessionToken
} from "../services/sessionTokens";
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
  restoringSession: boolean;
  loggingIn: boolean;
  error: string | null;
  login: () => Promise<void>;
  logout: () => void;
}

/**
 * Authentication for the selected GitHub server, mirroring the Flutter
 * client: a saved personal token signs in directly and skips OAuth; servers
 * with registered OAuth credentials use the loopback browser flow. OAuth
 * session tokens persist (OS keychain on desktop) and restore on startup or
 * when switching back to a server, so a restart does not ask to log in again.
 */
export function useGithubAuth(servers: UseGithubServersResult): UseGithubAuthResult {
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [restoringSession, setRestoringSession] = useState(true);
  const [loggingIn, setLoggingIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const personalToken = servers.tokenOf(servers.selectedUrl);

  useEffect(() => {
    setSessionToken(null);
    setError(null);
    if (personalToken) {
      setRestoringSession(false);
      return;
    }
    setRestoringSession(true);
    // Restore the persisted session for this server, if one exists.
    let cancelled = false;
    void loadSessionToken(servers.selectedUrl).then((stored) => {
      if (!cancelled && stored) {
        setSessionToken(stored);
      }
      if (!cancelled) {
        setRestoringSession(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [servers.selectedUrl, personalToken]);

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
      // Persisted so the next launch signs in without asking. A failed write
      // (e.g. a denied keychain prompt) must be visible, not silent.
      void saveSessionToken(servers.selectedUrl, accessToken).catch((cause) => {
        console.error("Failed to persist the OAuth session token", cause);
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoggingIn(false);
    }
  }, [personalToken, servers.selectedUrl]);

  const logout = useCallback(() => {
    setSessionToken(null);
    void clearSessionToken(servers.selectedUrl);
  }, [servers.selectedUrl]);

  return {
    connection: {
      apiBaseUrl: servers.selectedUrl,
      webBaseUrl: deriveHostUrl(servers.selectedUrl),
      token
    },
    authMethod,
    signedIn: token !== "",
    restoringSession,
    loggingIn,
    error,
    login,
    logout
  };
}
