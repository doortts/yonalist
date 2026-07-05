import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubConnection } from "../hooks/useGithubAuth";
import {
  checkConnection,
  loadLastAuthenticatedUrl,
  loadSkipLogin,
  persistLastAuthenticatedUrl,
  persistSkipLogin,
  validateConnection
} from "./authGate";

const connection: GithubConnection = {
  apiBaseUrl: "https://api.github.com/",
  webBaseUrl: "https://github.com",
  token: "token-123"
};

function fetchWithStatus(status: number) {
  return vi.fn(async () => new Response(null, { status }));
}

describe("checkConnection", () => {
  it("asks GitHub for the current user with auth headers", async () => {
    const fetchMock = fetchWithStatus(200);

    const result = await checkConnection(
      connection,
      fetchMock as unknown as typeof fetch
    );

    expect(result).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The trailing slash of the base URL must not double up in the path.
    expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer token-123",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
  });

  it("treats 401 and 403 as rejected credentials", async () => {
    for (const status of [401, 403]) {
      const result = await checkConnection(
        connection,
        fetchWithStatus(status) as unknown as typeof fetch
      );
      expect(result, String(status)).toBe("invalid");
    }
  });

  it("treats server errors as unreachable, not as an auth failure", async () => {
    const result = await checkConnection(
      connection,
      fetchWithStatus(503) as unknown as typeof fetch
    );
    expect(result).toBe("unreachable");
  });

  it("treats network failures as unreachable", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("network down");
    });

    const result = await checkConnection(
      connection,
      fetchMock as unknown as typeof fetch
    );
    expect(result).toBe("unreachable");
  });
});

describe("validateConnection", () => {
  it("is true only when the check answers ok", async () => {
    await expect(
      validateConnection(connection, fetchWithStatus(200) as unknown as typeof fetch)
    ).resolves.toBe(true);
    await expect(
      validateConnection(connection, fetchWithStatus(401) as unknown as typeof fetch)
    ).resolves.toBe(false);
    await expect(
      validateConnection(connection, fetchWithStatus(503) as unknown as typeof fetch)
    ).resolves.toBe(false);
  });
});

describe("last authenticated URL persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns null when nothing was persisted", () => {
    expect(loadLastAuthenticatedUrl()).toBeNull();
  });

  it("round-trips the persisted URL", () => {
    persistLastAuthenticatedUrl("https://ghe.example.com/api/v3");
    expect(loadLastAuthenticatedUrl()).toBe("https://ghe.example.com/api/v3");
  });
});

describe("skip-login persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to false when nothing was persisted", () => {
    expect(loadSkipLogin()).toBe(false);
  });

  it("round-trips the skip choice", () => {
    persistSkipLogin(true);
    expect(loadSkipLogin()).toBe(true);
  });

  it("removes the key when skipping is turned off", () => {
    persistSkipLogin(true);
    persistSkipLogin(false);
    expect(loadSkipLogin()).toBe(false);
    expect(window.localStorage.getItem("yonalist.auth.skipLogin.v1")).toBeNull();
  });
});
