import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadGithubAccountBinding,
  persistGithubAccountBinding
} from "../services/githubAccountIdentity";
import type { UseGithubAuthResult } from "./useGithubAuth";
import type { UseGithubServersResult } from "./useGithubServers";
import { useAuthGate } from "./useAuthGate";

const API_URL = "https://api.github.com";
const ACCOUNT = { id: "42", login: "octocat" };

function userResponse(account = ACCOUNT) {
  return new Response(JSON.stringify(account), { status: 200 });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function makeServers(overrides: Partial<UseGithubServersResult> = {}): UseGithubServersResult {
  return {
    state: { servers: [], selectedUrl: API_URL, personalTokens: {} } as never,
    urls: [API_URL],
    selectedUrl: API_URL,
    labelOf: () => "GitHub",
    isDefault: () => true,
    tokenOf: () => "stored-token",
    usesToken: () => true,
    select: vi.fn(),
    upsert: vi.fn(),
    remove: vi.fn(),
    reset: vi.fn(),
    ...overrides
  };
}

function makeAuth(overrides: Partial<UseGithubAuthResult> = {}): UseGithubAuthResult {
  return {
    connection: { apiBaseUrl: API_URL, webBaseUrl: "https://github.com", token: "stored-token" },
    authMethod: "personal_token",
    signedIn: true,
    restoringSession: false,
    loggingIn: false,
    error: null,
    login: vi.fn(),
    logout: vi.fn(),
    ...overrides
  };
}

describe("useAuthGate", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("requires login when no token is stored", async () => {
    const { result } = renderHook(() =>
      useAuthGate({
        auth: makeAuth({
          connection: { apiBaseUrl: API_URL, webBaseUrl: "https://github.com", token: "" },
          signedIn: false
        }),
        servers: makeServers({ tokenOf: () => null }),
        online: true
      })
    );

    // The gate first checks the persisted session store, so this is async.
    await waitFor(() => expect(result.current.state).toBe("required"));
  });

  it("passes with a stored OAuth session token and no personal token", async () => {
    window.localStorage.setItem(
      "yonalist.github.sessionTokens.v1",
      JSON.stringify({ [API_URL]: "gho_saved" })
    );
    const fetchMock = vi.fn(async () => userResponse());
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useAuthGate({
        auth: makeAuth({
          connection: {
            apiBaseUrl: API_URL,
            webBaseUrl: "https://github.com",
            token: "gho_saved"
          },
          authMethod: "oauth"
        }),
        servers: makeServers({ tokenOf: () => null }),
        online: true
      })
    );

    await waitFor(() => expect(result.current.state).toBe("passed"));
    // The background validation used the restored session token.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer gho_saved"
    );
  });

  it("clears a rejected session token and returns to the login page", async () => {
    window.localStorage.setItem(
      "yonalist.github.sessionTokens.v1",
      JSON.stringify({ [API_URL]: "gho_expired" })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 }))
    );

    const { result } = renderHook(() =>
      useAuthGate({
        auth: makeAuth({
          connection: {
            apiBaseUrl: API_URL,
            webBaseUrl: "https://github.com",
            token: "gho_expired"
          },
          authMethod: "oauth"
        }),
        servers: makeServers({ tokenOf: () => null }),
        online: true
      })
    );

    await waitFor(() => expect(result.current.state).toBe("required"));
    expect(result.current.error).toBeTruthy();
    const stored = JSON.parse(
      window.localStorage.getItem("yonalist.github.sessionTokens.v1") ?? "{}"
    ) as Record<string, string>;
    expect(stored[API_URL]).toBeUndefined();
  });

  it("passes optimistically with a stored token before validation resolves", () => {
    // fetch never resolves — the gate must not wait for it.
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    const { result } = renderHook(() =>
      useAuthGate({ auth: makeAuth(), servers: makeServers(), online: true })
    );

    expect(result.current.state).toBe("passed");
  });

  it("falls back to the login page when the stored token is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 }))
    );

    const { result } = renderHook(() =>
      useAuthGate({ auth: makeAuth(), servers: makeServers(), online: true })
    );

    expect(result.current.state).toBe("passed");
    await waitFor(() => expect(result.current.state).toBe("required"));
    expect(result.current.error).toBeTruthy();
  });

  it("stays passed when validation is unreachable (offline-first)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      })
    );

    const { result } = renderHook(() =>
      useAuthGate({ auth: makeAuth(), servers: makeServers(), online: true })
    );

    // Give the background validation a chance to settle.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.state).toBe("passed");
  });

  it("stays passed on server errors (5xx is not an auth rejection)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 }))
    );

    const { result } = renderHook(() =>
      useAuthGate({ auth: makeAuth(), servers: makeServers(), online: true })
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.state).toBe("passed");
  });

  it("persists the URL after a successful background validation", async () => {
    const fetchMock = vi.fn(async () => userResponse());
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() =>
      useAuthGate({ auth: makeAuth(), servers: makeServers(), online: true })
    );

    await waitFor(() =>
      expect(
        window.localStorage.getItem("yonalist.github.lastAuthenticatedUrl.v1")
      ).toBe(API_URL)
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes without validating when offline", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useAuthGate({ auth: makeAuth(), servers: makeServers(), online: false })
    );

    expect(result.current.state).toBe("passed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("restores only the matching credential binding when offline", async () => {
    await persistGithubAccountBinding(API_URL, "stored-token", ACCOUNT);

    const { result, rerender } = renderHook(
      ({ token }) =>
        useAuthGate({
          auth: makeAuth({
            connection: {
              apiBaseUrl: API_URL,
              webBaseUrl: "https://github.com",
              token
            }
          }),
          servers: makeServers(),
          online: false
        }),
      { initialProps: { token: "stored-token" } }
    );

    await waitFor(() => expect(result.current.account).toEqual(ACCOUNT));

    rerender({ token: "different-token" });
    expect(result.current.account).toBeNull();
    await act(async () => Promise.resolve());
    expect(result.current.account).toBeNull();
  });

  it("returns null on a credential switch and ignores the late previous response", async () => {
    await persistGithubAccountBinding(API_URL, "stored-token", ACCOUNT);
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ apiBaseUrl, token }) =>
        useAuthGate({
          auth: makeAuth({
            connection: {
              apiBaseUrl,
              webBaseUrl: apiBaseUrl,
              token
            }
          }),
          servers: makeServers({ selectedUrl: apiBaseUrl }),
          online: true
        }),
      { initialProps: { apiBaseUrl: API_URL, token: "stored-token" } }
    );

    await waitFor(() => expect(result.current.account).toEqual(ACCOUNT));
    rerender({
      apiBaseUrl: "https://ghe.example.com/api/v3",
      token: "new-token"
    });
    expect(result.current.account).toBeNull();
    await expect(
      loadGithubAccountBinding(API_URL, "stored-token")
    ).resolves.toBeNull();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      second.resolve(userResponse({ id: "84", login: "monalisa" }));
      await second.promise;
    });
    await waitFor(() =>
      expect(result.current.account).toEqual({ id: "84", login: "monalisa" })
    );

    await act(async () => {
      first.resolve(userResponse());
      await first.promise;
    });
    expect(result.current.account).toEqual({ id: "84", login: "monalisa" });
  });

  it.each([
    ["network failure", () => Promise.reject(new TypeError("network down"))],
    ["server failure", () => Promise.resolve(new Response(null, { status: 503 }))]
  ])("keeps a provisional account after %s", async (_label, response) => {
    await persistGithubAccountBinding(API_URL, "stored-token", ACCOUNT);
    vi.stubGlobal("fetch", vi.fn(response));

    const { result } = renderHook(() =>
      useAuthGate({ auth: makeAuth(), servers: makeServers(), online: true })
    );

    await waitFor(() => expect(result.current.account).toEqual(ACCOUNT));
  });

  it.each([401, 403])(
    "removes a provisional account and binding after a %s response",
    async (status) => {
      await persistGithubAccountBinding(API_URL, "stored-token", ACCOUNT);
      const response = deferred<Response>();
      vi.stubGlobal("fetch", vi.fn(() => response.promise));

      const { result } = renderHook(() =>
        useAuthGate({ auth: makeAuth(), servers: makeServers(), online: true })
      );

      await waitFor(() => expect(result.current.account).toEqual(ACCOUNT));
      await act(async () => {
        response.resolve(new Response(null, { status }));
        await response.promise;
      });

      await waitFor(() => expect(result.current.account).toBeNull());
      await expect(
        loadGithubAccountBinding(API_URL, "stored-token")
      ).resolves.toBeNull();
    }
  );

  it("keeps an unbound account null until one user request verifies it", async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn(() => response.promise);
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useAuthGate({ auth: makeAuth(), servers: makeServers(), online: true })
    );

    expect(result.current.account).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      response.resolve(userResponse());
      await response.promise;
    });

    await waitFor(() => expect(result.current.account).toEqual(ACCOUNT));
    await expect(
      loadGithubAccountBinding(API_URL, "stored-token")
    ).resolves.toEqual(ACCOUNT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hides and clears the current binding on logout", async () => {
    await persistGithubAccountBinding(API_URL, "stored-token", ACCOUNT);

    const { result, rerender } = renderHook(
      ({ signedIn }) =>
        useAuthGate({
          auth: makeAuth({ signedIn }),
          servers: makeServers(),
          online: false
        }),
      { initialProps: { signedIn: true } }
    );
    await waitFor(() => expect(result.current.account).toEqual(ACCOUNT));

    rerender({ signedIn: false });
    expect(result.current.account).toBeNull();
    await expect(
      loadGithubAccountBinding(API_URL, "stored-token")
    ).resolves.toBeNull();
  });

  it("selects the last authenticated server on startup", () => {
    const ghe = "https://ghe.example.com/api/v3";
    window.localStorage.setItem("yonalist.github.lastAuthenticatedUrl.v1", ghe);
    const select = vi.fn();
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    renderHook(() =>
      useAuthGate({
        auth: makeAuth(),
        servers: makeServers({ urls: [API_URL, ghe], select }),
        online: true
      })
    );

    expect(select).toHaveBeenCalledWith(ghe);
  });

  it("passes when the user chose to skip login", () => {
    window.localStorage.setItem("yonalist.auth.skipLogin.v1", "true");

    const { result } = renderHook(() =>
      useAuthGate({
        auth: makeAuth({
          connection: {
            apiBaseUrl: API_URL,
            webBaseUrl: "https://github.com",
            token: ""
          },
          signedIn: false
        }),
        servers: makeServers({ tokenOf: () => null }),
        online: true
      })
    );

    expect(result.current.state).toBe("passed");
  });

  it("clears skipped login and verifies a credential added later", async () => {
    window.localStorage.setItem("yonalist.auth.skipLogin.v1", "true");
    const fetchMock = vi.fn(async () => userResponse());
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ token }) =>
        useAuthGate({
          auth: makeAuth({
            connection: {
              apiBaseUrl: API_URL,
              webBaseUrl: "https://github.com",
              token
            },
            signedIn: Boolean(token)
          }),
          servers: makeServers(),
          online: true
        }),
      { initialProps: { token: "" } }
    );

    expect(result.current.state).toBe("passed");
    expect(fetchMock).not.toHaveBeenCalled();

    rerender({ token: "stored-token" });

    await waitFor(() => expect(result.current.account).toEqual(ACCOUNT));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem("yonalist.auth.skipLogin.v1")).toBeNull();
  });
});
