import { afterEach, describe, expect, it, vi } from "vitest";
import type { GithubConnection } from "../hooks/useGithubAuth";
import {
  needsAuthenticatedFetch,
  resolveAuthenticatedImage
} from "./imageProxy";

const connection: GithubConnection = {
  apiBaseUrl: "https://oss.navercorp.com/api/v3",
  webBaseUrl: "https://oss.navercorp.com",
  token: "ghp_token"
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("needsAuthenticatedFetch", () => {
  it("matches the GitHub host and its subdomains only", () => {
    expect(
      needsAuthenticatedFetch("https://oss.navercorp.com/storage/user/1/a.png", connection)
    ).toBe(true);
    expect(
      needsAuthenticatedFetch("https://media.oss.navercorp.com/a.png", connection)
    ).toBe(true);
    expect(
      needsAuthenticatedFetch("https://evil.example.com/a.png", connection)
    ).toBe(false);
    expect(needsAuthenticatedFetch("data:image/png;base64,AA", connection)).toBe(false);
  });

  it("does nothing without a token", () => {
    expect(
      needsAuthenticatedFetch("https://oss.navercorp.com/a.png", {
        ...connection,
        token: ""
      })
    ).toBe(false);
  });
});

describe("resolveAuthenticatedImage", () => {
  it("fetches with the token and returns a data URL (cached afterwards)", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer ghp_token"
      );
      return new Response(bytes, {
        status: 200,
        headers: { "content-type": "image/png" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const url = `https://oss.navercorp.com/storage/user/${Math.random()}/a.png`;
    const first = await resolveAuthenticatedImage(url, connection);

    expect(first).toMatch(/^data:image\/png;base64,/);

    const second = await resolveAuthenticatedImage(url, connection);
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries with GitHub's token auth scheme when bearer auth returns a login page", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("<html>login</html>", {
          status: 200,
          headers: { "content-type": "text/html" }
        })
      )
      .mockResolvedValueOnce(
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "image/png" }
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const resolved = await resolveAuthenticatedImage(
      `https://oss.navercorp.com/avatars/u/${Math.random()}.png`,
      connection
    );

    expect(resolved).toMatch(/^data:image\/png;base64,/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({
      Authorization: "Bearer ghp_token"
    });
    expect(fetchMock.mock.calls[1][1]?.headers).toEqual({
      Authorization: "token ghp_token"
    });
  });

  it("returns null for non-image responses", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("<html>login</html>", {
          status: 200,
          headers: { "content-type": "text/html" }
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const resolved = await resolveAuthenticatedImage(
      `https://oss.navercorp.com/login-${Math.random()}`,
      connection
    );

    expect(resolved).toBeNull();
  });

  it("caches failed authenticated image lookups for the session", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("<html>rate limited</html>", {
          status: 429,
          headers: { "content-type": "text/html" }
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const url = `https://oss.navercorp.com/sessions/_auth_request_bounce?${Math.random()}`;
    const first = await resolveAuthenticatedImage(url, connection);
    const second = await resolveAuthenticatedImage(url, connection);

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
