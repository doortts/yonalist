import { describe, expect, it, vi } from "vitest";
import {
  GitHubRequestError,
  createGitHubTransport,
  encodePathSegment,
  graphqlUrl,
  trimTrailingSlash
} from "./githubTransport";

describe("trimTrailingSlash", () => {
  it("removes every trailing slash", () => {
    expect(trimTrailingSlash("https://api.github.com/")).toBe(
      "https://api.github.com"
    );
    expect(trimTrailingSlash("https://ghe.example.com/api/v3///")).toBe(
      "https://ghe.example.com/api/v3"
    );
  });

  it("leaves URLs without a trailing slash untouched", () => {
    expect(trimTrailingSlash("https://api.github.com")).toBe(
      "https://api.github.com"
    );
  });
});

describe("encodePathSegment", () => {
  it("escapes characters that would break the path", () => {
    expect(encodePathSegment("feature/branch")).toBe("feature%2Fbranch");
    expect(encodePathSegment("a b#c")).toBe("a%20b%23c");
  });

  it("stringifies numbers", () => {
    expect(encodePathSegment(42)).toBe("42");
  });
});

describe("graphqlUrl", () => {
  it("maps a GHE REST base to its /api/graphql endpoint", () => {
    expect(graphqlUrl("https://ghe.example.com/api/v3")).toBe(
      "https://ghe.example.com/api/graphql"
    );
    expect(graphqlUrl("https://ghe.example.com/api/v3/")).toBe(
      "https://ghe.example.com/api/graphql"
    );
  });

  it("appends /graphql for github.com", () => {
    expect(graphqlUrl("https://api.github.com")).toBe(
      "https://api.github.com/graphql"
    );
  });
});

describe("GitHubRequestError", () => {
  it("includes the detail in the message when present", () => {
    const error = new GitHubRequestError(422, "Validation Failed");
    expect(error.message).toBe(
      "GitHub request failed with 422: Validation Failed"
    );
    expect(error.status).toBe(422);
    expect(error.detail).toBe("Validation Failed");
    expect(error.name).toBe("GitHubRequestError");
  });

  it("falls back to a status-only message without detail", () => {
    const error = new GitHubRequestError(500, "");
    expect(error.message).toBe("GitHub request failed with 500.");
    expect(error.detail).toBe("");
  });
});

describe("createGitHubTransport().requestJson", () => {
  function transport(fetchMock: unknown) {
    return createGitHubTransport({
      token: "token-123",
      apiBaseUrl: "https://api.github.com/",
      webBaseUrl: "https://github.com/",
      fetch: fetchMock as typeof fetch
    });
  }

  it("sends the GitHub API headers and returns the parsed JSON", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ login: "octocat" }), { status: 200 })
    );

    const result = await transport(fetchMock).requestJson<{ login: string }>(
      "/user"
    );

    expect(result).toEqual({ login: "octocat" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The trailing slash of the base URL is trimmed before joining paths.
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(
      "https://api.github.com/user"
    );
    const headers = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    const sent = new Headers(headers.headers);
    expect(sent.get("Accept")).toBe("application/vnd.github+json");
    expect(sent.get("X-GitHub-Api-Version")).toBe("2022-11-28");
    expect(sent.get("Authorization")).toBe("Bearer token-123");
  });

  it("marks JSON bodies with a Content-Type header", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 201 })
    );

    await transport(fetchMock).requestJson("/repos/acme/app/issues", {
      method: "POST",
      body: JSON.stringify({ title: "t" })
    });

    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(new Headers(init.headers).get("Content-Type")).toBe(
      "application/json"
    );
    expect(init.method).toBe("POST");
  });

  it("throws a GitHubRequestError carrying status and message detail", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401
      })
    );

    const failure = transport(fetchMock).requestJson("/user");

    await expect(failure).rejects.toBeInstanceOf(GitHubRequestError);
    await expect(failure).rejects.toMatchObject({
      status: 401,
      detail: "Bad credentials",
      message: "GitHub request failed with 401: Bad credentials"
    });
  });

  it("still reports the status when the error body is not JSON", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("<html>oops</html>", { status: 502 })
    );

    await expect(transport(fetchMock).requestJson("/user")).rejects.toMatchObject(
      {
        status: 502,
        detail: "",
        message: "GitHub request failed with 502."
      }
    );
  });
});

describe("createGitHubTransport() conditional metadata requests", () => {
  function transport(fetchMock: unknown) {
    return createGitHubTransport({
      token: "token-123",
      apiBaseUrl: "https://api.github.com/",
      webBaseUrl: "https://github.com/",
      fetch: fetchMock as typeof fetch
    });
  }

  it("returns response validators with parsed JSON", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ state: "open" }), {
        status: 200,
        headers: {
          ETag: 'W/"issue-1"',
          "Last-Modified": "Thu, 09 Jul 2026 01:00:00 GMT"
        }
      })
    );

    const result = await transport(fetchMock).requestJsonWithMeta<{
      state: string;
    }>("/repos/acme/app/issues/1");

    expect(result.data).toEqual({ state: "open" });
    expect(result.meta).toEqual({
      etag: 'W/"issue-1"',
      lastModified: "Thu, 09 Jul 2026 01:00:00 GMT"
    });
  });

  it("sends conditional HEAD headers and returns unchanged on 304", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 304 }));

    const result = await transport(fetchMock).conditionalHead(
      "/repos/acme/app/issues/1",
      {
        etag: 'W/"issue-1"',
        lastModified: "Thu, 09 Jul 2026 01:00:00 GMT"
      }
    );

    expect(result).toEqual({
      unchanged: true,
      meta: { etag: null, lastModified: null }
    });
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(init.method).toBe("HEAD");
    expect(headers.get("If-None-Match")).toBe('W/"issue-1"');
    expect(headers.get("If-Modified-Since")).toBe(
      "Thu, 09 Jul 2026 01:00:00 GMT"
    );
  });

  it("returns changed metadata when a conditional HEAD gets 200", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, {
        status: 200,
        headers: {
          ETag: 'W/"issue-2"',
          "Last-Modified": "Thu, 09 Jul 2026 02:00:00 GMT"
        }
      })
    );

    const result = await transport(fetchMock).conditionalHead(
      "/repos/acme/app/issues/1",
      {
        etag: 'W/"issue-1"',
        lastModified: "Thu, 09 Jul 2026 01:00:00 GMT"
      }
    );

    expect(result).toEqual({
      unchanged: false,
      meta: {
        etag: 'W/"issue-2"',
        lastModified: "Thu, 09 Jul 2026 02:00:00 GMT"
      }
    });
  });
});
