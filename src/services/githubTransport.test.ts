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
