import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGithubAuth } from "./useGithubAuth";
import { useGithubServers } from "./useGithubServers";

// The OAuth loopback flow opens a real browser; stub it with a canned token.
vi.mock("../services/oauth", () => ({
  loginWithOAuth: vi.fn(async () => "oauth-session-token")
}));

// First built-in default (selected on a fresh profile) and another default.
const NAVER_URL = "https://oss.navercorp.com/api/v3";
const GITHUB_URL = "https://api.github.com";

const personalTokensKey = "yonalist.github.personalTokens.v1";

function seedPersonalTokens(tokens: Record<string, string>) {
  window.localStorage.setItem(personalTokensKey, JSON.stringify(tokens));
}

/** Drives useGithubAuth through the real useGithubServers hook. */
function renderAuth() {
  return renderHook(() => {
    const servers = useGithubServers();
    const auth = useGithubAuth(servers);
    return { servers, auth };
  });
}

describe("useGithubAuth", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("signs in directly when the selected server has a saved personal token", () => {
    seedPersonalTokens({ [NAVER_URL]: "ghp_stored" });

    const { result } = renderAuth();

    expect(result.current.servers.selectedUrl).toBe(NAVER_URL);
    expect(result.current.auth.signedIn).toBe(true);
    expect(result.current.auth.authMethod).toBe("personal_token");
    expect(result.current.auth.connection.token).toBe("ghp_stored");
  });

  it("derives connection URLs from the selected server", () => {
    const { result } = renderAuth();

    expect(result.current.auth.connection.apiBaseUrl).toBe(NAVER_URL);
    // GHE-style URLs strip the /api/vN suffix for the web base.
    expect(result.current.auth.connection.webBaseUrl).toBe(
      "https://oss.navercorp.com"
    );

    act(() => {
      result.current.servers.select(GITHUB_URL);
    });

    expect(result.current.auth.connection.apiBaseUrl).toBe(GITHUB_URL);
    // api.github.com maps to the github.com web host.
    expect(result.current.auth.connection.webBaseUrl).toBe("https://github.com");
  });

  it("drops the in-memory OAuth session when the selected server changes", async () => {
    const { result } = renderAuth();

    expect(result.current.auth.signedIn).toBe(false);
    expect(result.current.auth.authMethod).toBe("oauth");

    await act(async () => {
      await result.current.auth.login();
    });
    expect(result.current.auth.signedIn).toBe(true);
    expect(result.current.auth.connection.token).toBe("oauth-session-token");

    act(() => {
      result.current.servers.select(GITHUB_URL);
    });

    // No personal token on the new server, so signedIn falls back to false.
    expect(result.current.auth.signedIn).toBe(false);
    expect(result.current.auth.connection.token).toBe("");
  });

  it("falls back to the new server's personal token after switching away from an OAuth session", async () => {
    seedPersonalTokens({ [GITHUB_URL]: "ghp_github" });

    const { result } = renderAuth();

    // Selected server (NAVER_URL) has no personal token; sign in via OAuth.
    await act(async () => {
      await result.current.auth.login();
    });
    expect(result.current.auth.connection.token).toBe("oauth-session-token");

    act(() => {
      result.current.servers.select(GITHUB_URL);
    });

    // The OAuth session is gone; the stored personal token takes over.
    expect(result.current.auth.signedIn).toBe(true);
    expect(result.current.auth.authMethod).toBe("personal_token");
    expect(result.current.auth.connection.token).toBe("ghp_github");
  });

  it("logout clears the OAuth session", async () => {
    const { result } = renderAuth();

    await act(async () => {
      await result.current.auth.login();
    });
    expect(result.current.auth.signedIn).toBe(true);

    act(() => {
      result.current.auth.logout();
    });

    expect(result.current.auth.signedIn).toBe(false);
    expect(result.current.auth.connection.token).toBe("");
  });

  it("logout does not sign out a personal-token server", () => {
    seedPersonalTokens({ [NAVER_URL]: "ghp_stored" });

    const { result } = renderAuth();
    expect(result.current.auth.signedIn).toBe(true);

    act(() => {
      result.current.auth.logout();
    });

    // Personal tokens live in the server store, not the session.
    expect(result.current.auth.signedIn).toBe(true);
    expect(result.current.auth.connection.token).toBe("ghp_stored");
  });
});
