import { useEffect, useRef, useState } from "react";
import {
  checkConnectionWithIdentity,
  loadLastAuthenticatedUrl,
  loadSkipLogin,
  persistLastAuthenticatedUrl,
  persistSkipLogin
} from "../services/authGate";
import {
  clearGithubAccountBinding,
  loadGithubAccountBinding,
  persistGithubAccountBinding,
  type GithubAccountIdentity
} from "../services/githubAccountIdentity";
import { clearSessionToken } from "../services/sessionTokens";
import { tracePerf } from "../services/perfTrace";
import type { UseGithubAuthResult } from "./useGithubAuth";
import type { UseGithubServersResult } from "./useGithubServers";

export type AuthGateState = "checking" | "required" | "passed";

interface UseAuthGateInput {
  auth: UseGithubAuthResult;
  servers: UseGithubServersResult;
  online: boolean;
}

interface ScopedGithubAccountIdentity {
  apiBaseUrl: string;
  token: string;
  account: GithubAccountIdentity;
}

export function useAuthGate({ auth, servers, online }: UseAuthGateInput) {
  const [state, setState] = useState<AuthGateState>(() =>
    loadSkipLogin() ? "passed" : "checking"
  );
  const [error, setError] = useState<string | null>(null);
  const [accountScope, setAccountScope] =
    useState<ScopedGithubAccountIdentity | null>(null);
  const stateRef = useRef(state);
  const validationGeneration = useRef(0);
  const previousCredential = useRef<{
    apiBaseUrl: string;
    token: string;
  } | null>(null);
  stateRef.current = state;
  const lastAuthenticated = loadLastAuthenticatedUrl();
  const selectingLastAuthenticated = Boolean(
    state === "checking" &&
      lastAuthenticated &&
      lastAuthenticated !== servers.selectedUrl &&
      servers.urls.includes(lastAuthenticated)
  );
  const selectServer = servers.select;

  useEffect(() => {
    if (state !== "checking") {
      return;
    }

    if (selectingLastAuthenticated && lastAuthenticated) {
      selectServer(lastAuthenticated);
      return;
    }

    if (auth.restoringSession) {
      return;
    }

    const token = auth.connection.token.trim();
    if (!token) {
      setState("required");
      return;
    }

    // Restored credentials enter optimistically; identity validation runs in
    // the credential-scoped effect below without issuing a second /user call.
    setState("passed");
  }, [
    state,
    auth.connection.token,
    auth.restoringSession,
    lastAuthenticated,
    selectServer,
    selectingLastAuthenticated
  ]);

  useEffect(() => {
    const apiBaseUrl = auth.connection.apiBaseUrl;
    const rawToken = auth.connection.token;
    const token = rawToken.trim();
    const generation = ++validationGeneration.current;
    const currentCredential =
      auth.signedIn && token ? { apiBaseUrl, token: rawToken } : null;
    const previous = previousCredential.current;
    const credentialChanged = Boolean(
      previous &&
        (!currentCredential ||
          previous.apiBaseUrl !== currentCredential.apiBaseUrl ||
          previous.token !== currentCredential.token)
    );

    if (credentialChanged && previous) {
      clearGithubAccountBinding(previous.apiBaseUrl);
      setAccountScope(null);
    }
    previousCredential.current = currentCredential;

    if (!currentCredential || auth.restoringSession || loadSkipLogin()) {
      if (!currentCredential) {
        setAccountScope(null);
      }
      return;
    }

    if (selectingLastAuthenticated) {
      return;
    }

    const optimistic = stateRef.current !== "required";
    const isCurrent = () => validationGeneration.current === generation;

    void (async () => {
      const provisional = await loadGithubAccountBinding(apiBaseUrl, token);
      if (!isCurrent()) {
        return;
      }
      if (provisional) {
        setAccountScope({ apiBaseUrl, token: rawToken, account: provisional });
      }

      if (!online) {
        if (!optimistic) {
          persistLastAuthenticatedUrl(apiBaseUrl);
          setState("passed");
        }
        return;
      }

      const startedAt = performance.now();
      tracePerf("auth_check_start", { apiBaseUrl });
      const result = await checkConnectionWithIdentity({
        apiBaseUrl,
        webBaseUrl: auth.connection.webBaseUrl,
        token
      });
      if (!isCurrent()) {
        return;
      }
      tracePerf("auth_check_done", {
        result: result.status,
        durationMs: performance.now() - startedAt
      });

      if (result.status === "ok") {
        await persistGithubAccountBinding(apiBaseUrl, token, result.account);
        if (!isCurrent()) {
          return;
        }
        setAccountScope({ apiBaseUrl, token: rawToken, account: result.account });
        persistLastAuthenticatedUrl(apiBaseUrl);
        setError(null);
        setState("passed");
      } else if (result.status === "invalid") {
        clearGithubAccountBinding(apiBaseUrl);
        setAccountScope(null);
        if (auth.authMethod === "oauth") {
          void clearSessionToken(apiBaseUrl);
        }
        setError(
          "인증에 실패했습니다. 토큰을 확인하거나 다른 서버로 로그인하세요."
        );
        setState("required");
      } else if (!optimistic) {
        setError(
          "인증에 실패했습니다. 토큰을 확인하거나 다른 서버로 로그인하세요."
        );
      }
    })();

    return () => {
      if (validationGeneration.current === generation) {
        validationGeneration.current += 1;
      }
    };
  }, [
    auth.authMethod,
    auth.connection.apiBaseUrl,
    auth.connection.token,
    auth.connection.webBaseUrl,
    auth.restoringSession,
    auth.signedIn,
    online,
    selectingLastAuthenticated
  ]);

  useEffect(() => {
    if (
      state === "passed" &&
      !auth.signedIn &&
      !auth.restoringSession &&
      !loadSkipLogin()
    ) {
      setState("required");
    }
  }, [state, auth.signedIn, auth.restoringSession]);

  function skipLogin() {
    persistSkipLogin(true);
    setState("passed");
  }

  const account =
    auth.signedIn &&
    accountScope?.apiBaseUrl === auth.connection.apiBaseUrl &&
    accountScope.token === auth.connection.token
      ? accountScope.account
      : null;

  return { state, error, account, skipLogin };
}
