import { describe, expect, it, vi } from "vitest";
import { createGitHubClient } from "./github";

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });

describe("GitHub client", () => {
  it("uses host-specific API base URLs for issue creation", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ number: 123 }));
    const client = createGitHubClient({
      token: "token",
      apiBaseUrl: "https://ghe.example.com/api/v3",
      webBaseUrl: "https://ghe.example.com",
      fetch: fetchMock
    });

    await client.createIssue("doortts", "yonalist", {
      title: "New issue",
      body: "Body"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://ghe.example.com/api/v3/repos/doortts/yonalist/issues",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ title: "New issue", body: "Body" })
      })
    );
  });

  it("posts regular issue comments for both issues and pulls", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 456 }));
    const client = createGitHubClient({
      token: "token",
      apiBaseUrl: "https://api.github.com",
      webBaseUrl: "https://github.com",
      fetch: fetchMock
    });

    await client.createIssueComment("openai", "codex", 7, "Comment");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/openai/codex/issues/7/comments",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ body: "Comment" })
      })
    );
  });

  it("closes issues through the shared issues endpoint", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ state: "closed" }));
    const client = createGitHubClient({
      token: "token",
      apiBaseUrl: "https://api.github.com",
      webBaseUrl: "https://github.com",
      fetch: fetchMock
    });

    await client.closeIssue("openai", "codex", 7);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/openai/codex/issues/7",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ state: "closed" })
      })
    );
  });

  it("closes issues with a GitHub state reason", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ state: "closed" }));
    const client = createGitHubClient({
      token: "token",
      apiBaseUrl: "https://api.github.com",
      webBaseUrl: "https://github.com",
      fetch: fetchMock
    });

    await client.closeIssue("openai", "codex", 7, {
      reason: "duplicate",
      duplicateIssueId: 123
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/openai/codex/issues/7",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          state: "closed",
          state_reason: "duplicate",
          duplicate_issue_id: 123
        })
      })
    );
  });

  it("closes pull requests through the pull request endpoint", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ state: "closed" }));
    const client = createGitHubClient({
      token: "token",
      apiBaseUrl: "https://api.github.com",
      webBaseUrl: "https://github.com",
      fetch: fetchMock
    });

    await client.closePullRequest("openai", "codex", 7);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/openai/codex/pulls/7",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ state: "closed" })
      })
    );
  });

  it("creates discussion comments through GraphQL", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      if (payload.query?.includes("discussion(number")) {
        return jsonResponse({
          data: {
            repository: {
              discussion: {
                id: "D_kwDO",
                title: "Weekly",
                comments: { nodes: [] }
              }
            }
          }
        });
      }
      return jsonResponse({
        data: {
          addDiscussionComment: {
            comment: {
              id: "DC_kwDO",
              databaseId: 123,
              body: payload.variables?.body,
              createdAt: "2026-07-02T00:00:00Z"
            }
          }
        }
      });
    });
    const client = createGitHubClient({
      token: "token",
      apiBaseUrl: "https://api.github.com",
      webBaseUrl: "https://github.com",
      fetch: fetchMock as unknown as typeof fetch
    });

    const created = await client.createDiscussionComment(
      "openai",
      "codex",
      7,
      "Discussion reply"
    );

    expect(created).toMatchObject({
      id: 123,
      node_id: "DC_kwDO",
      body: "Discussion reply"
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      variables: { discussionId: "D_kwDO", body: "Discussion reply" }
    });
  });

  it("creates discussion replies with replyToId through GraphQL", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      if (payload.query?.includes("discussion(number")) {
        return jsonResponse({
          data: {
            repository: {
              discussion: {
                id: "D_kwDO",
                title: "Weekly",
                comments: { nodes: [] }
              }
            }
          }
        });
      }
      return jsonResponse({
        data: {
          addDiscussionComment: {
            comment: {
              id: "DC_reply",
              databaseId: 124,
              body: payload.variables?.body,
              createdAt: "2026-07-02T00:00:00Z"
            }
          }
        }
      });
    });
    const client = createGitHubClient({
      token: "token",
      apiBaseUrl: "https://api.github.com",
      webBaseUrl: "https://github.com",
      fetch: fetchMock as unknown as typeof fetch
    });

    const created = await client.createDiscussionComment(
      "openai",
      "codex",
      7,
      "Nested reply",
      { replyToId: "DC_parent" }
    );

    expect(created).toMatchObject({ id: 124, node_id: "DC_reply" });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      variables: {
        discussionId: "D_kwDO",
        body: "Nested reply",
        replyToId: "DC_parent"
      }
    });
  });

  it("closes discussions with a GraphQL close reason", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      if (payload.query?.includes("discussion(number")) {
        return jsonResponse({
          data: {
            repository: {
              discussion: {
                id: "D_kwDO",
                title: "Weekly",
                comments: { nodes: [] }
              }
            }
          }
        });
      }
      return jsonResponse({
        data: {
          closeDiscussion: {
            discussion: {
              id: "D_kwDO",
              closed: true
            }
          }
        }
      });
    });
    const client = createGitHubClient({
      token: "token",
      apiBaseUrl: "https://api.github.com",
      webBaseUrl: "https://github.com",
      fetch: fetchMock as unknown as typeof fetch
    });

    await client.closeDiscussion("openai", "codex", 7, "outdated");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const closePayload = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(closePayload.query).toContain("closeDiscussion");
    expect(closePayload.variables).toEqual({
      discussionId: "D_kwDO",
      reason: "OUTDATED"
    });
  });

  it("starts OAuth device flow with the web base URL", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        device_code: "device",
        user_code: "ABCD",
        verification_uri: "https://github.com/login/device",
        interval: 5,
        expires_in: 900
      })
    );
    const client = createGitHubClient({
      token: "",
      apiBaseUrl: "https://api.github.com",
      webBaseUrl: "https://github.com",
      fetch: fetchMock
    });

    await client.startDeviceFlow({
      clientId: "client-id",
      scopes: ["repo"]
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://github.com/login/device/code",
      expect.objectContaining({ method: "POST" })
    );
  });
});
