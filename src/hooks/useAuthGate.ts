import { useEffect, useRef, useState } from "react";
import {
  checkConnection,
  loadLastAuthenticatedUrl,
  loadSkipLogin,
  persistLastAuthenticatedUrl,
  persistSkipLogin,
  validateConnection
} from "../services/authGate";
import type { UseGithubAuthResult } from "./useGithubAuth";
import type { UseGithubServersResult } from "./useGithubServers";

export type AuthGateState = "checking" | "required" | "passed";

interface UseAuthGateInput {
  auth: UseGithubAuthResult;
  servers: UseGithubServersResult;
  online: boolean;
}

export function useAuthGate({ auth, servers, online }: UseAuthGateInput) {
  const [state, setState] = useState<AuthGateState>(() =>
    loadSkipLogin() ? "passed" : "checking"
  );
  const [error, setError] = useState<string | null>(null);
  const gateStarted = useRef(false);
  const gateValidating = useRef(false);

  useEffect(() => {
    if (state !== "checking" || gateStarted.current) {
      return;
    }
    gateStarted.current = true;

    const lastAuthenticated = loadLastAuthenticatedUrl();
    if (
      lastAuthenticated &&
      lastAuthenticated !== servers.selectedUrl &&
      servers.urls.includes(lastAuthenticated)
    ) {
      servers.select(lastAuthenticated);
    }

    const url = lastAuthenticated ?? servers.selectedUrl;
    const token = servers.tokenOf(url);
    if (!token) {
      setState("required");
      return;
    }

    // Optimistic gate: a stored token renders the app immediately (local
    // vault data works offline anyway); the credentials are verified in the
    // background and only a definitive rejection returns to the login page.
    setState("passed");
    if (!online) {
      return;
    }

    void checkConnection({
      apiBaseUrl: url,
      webBaseUrl: auth.connection.webBaseUrl,
      token
    }).then((result) => {
      if (result === "ok") {
        persistLastAuthenticatedUrl(url);
      } else if (result === "invalid") {
        setError(
          "저장된 인증 정보가 더 이상 유효하지 않습니다. 다시 로그인하세요."
        );
        setState("required");
      }
      // "unreachable" keeps the optimistic pass — offline-first.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  useEffect(() => {
    if (state !== "required" || !auth.signedIn || gateValidating.current) {
      return;
    }
    if (!online) {
      persistLastAuthenticatedUrl(servers.selectedUrl);
      setState("passed");
      return;
    }

    gateValidating.current = true;
    void validateConnection(auth.connection).then((ok) => {
      gateValidating.current = false;
      if (ok) {
        persistLastAuthenticatedUrl(servers.selectedUrl);
        setError(null);
        setState("passed");
      } else {
        setError(
          "인증에 실패했습니다. 토큰을 확인하거나 다른 서버로 로그인하세요."
        );
      }
    });
  }, [state, auth.signedIn, auth.connection, online, servers.selectedUrl]);

  function skipLogin() {
    persistSkipLogin(true);
    setState("passed");
  }

  return { state, error, skipLogin };
}
