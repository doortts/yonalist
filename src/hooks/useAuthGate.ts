import { useEffect, useRef, useState } from "react";
import {
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
    if (!online) {
      setState("passed");
      return;
    }

    void validateConnection({
      apiBaseUrl: url,
      webBaseUrl: auth.connection.webBaseUrl,
      token
    }).then((ok) => {
      if (ok) {
        persistLastAuthenticatedUrl(url);
      }
      setState(ok ? "passed" : "required");
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
