import { describe, expect, it, vi } from "vitest";
import {
  createCommentOutboxOperation,
  createIssueOutboxOperation
} from "../domain/outbox";
import type { ItemDocument } from "../domain/types";
import { createGitHubClient } from "./github";
import { syncOutboxOperations } from "./sync";

const draftItem: ItemDocument = {
  path: "/vault/github.com/acme/app/issues/_drafts/issue-1/issue.md",
  body: "Draft body",
  frontMatter: {
    kind: "issue",
    host: "github.com",
    owner: "acme",
    repo: "app",
    number: 0,
    title: "Draft title",
    state: "open",
    author: "local",
    labels: [],
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    local: { favorite: false },
    sync: { status: "pending" }
  }
};

function client(fetchMock: typeof fetch) {
  return createGitHubClient({
    token: "token",
    apiBaseUrl: "https://api.github.com",
    webBaseUrl: "https://github.com",
    fetch: fetchMock
  });
}

describe("syncOutboxOperations", () => {
  it("creates issues from drafts and comments from operation bodies", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/issues")) {
        return new Response(
          JSON.stringify({
            number: 100,
            node_id: "I_100",
            html_url: "https://github.com/acme/app/issues/100",
            created_at: "2026-07-02T00:00:00Z",
            updated_at: "2026-07-02T00:00:00Z"
          }),
          { status: 201 }
        );
      }
      return new Response(
        JSON.stringify({
          id: 456,
          node_id: "IC_456",
          html_url: "https://github.com/acme/app/issues/42#issuecomment-456",
          created_at: "2026-07-02T01:00:00Z",
          updated_at: "2026-07-02T01:00:00Z",
          body: "Queued comment"
        }),
        { status: 201 }
      );
    });

    const issueOperation = createIssueOutboxOperation({
      id: "issue-1",
      host: "github.com",
      owner: "acme",
      repo: "app",
      localFilePath: draftItem.path,
      createdAt: "2026-07-01T00:00:00Z"
    });
    const commentOperation = {
      ...createCommentOutboxOperation({
        id: "comment-1",
        host: "github.com",
        owner: "acme",
        repo: "app",
        itemKind: "issue",
        number: 42,
        localFilePath: "/vault/github.com/acme/app/issues/42/comments/x.md",
        createdAt: "2026-07-01T00:00:00Z"
      }),
      body: "Queued comment"
    };

    const results = await syncOutboxOperations(
      client(fetchMock as unknown as typeof fetch),
      [issueOperation, commentOperation],
      [draftItem]
    );

    expect(results.map((result) => result.ok)).toEqual([true, true]);
    expect(results[0].remote).toMatchObject({
      type: "issue",
      number: 100,
      node_id: "I_100"
    });
    expect(results[1].remote).toMatchObject({
      type: "comment",
      id: 456,
      node_id: "IC_456"
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/app/issues",
      expect.objectContaining({
        body: JSON.stringify({ title: "Draft title", body: "Draft body" })
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/app/issues/42/comments",
      expect.objectContaining({
        body: JSON.stringify({ body: "Queued comment" })
      })
    );
  });

  it("keeps syncing after failures and reports each error", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 1 }), { status: 201 })
    );

    function comment(id: string) {
      return {
        ...createCommentOutboxOperation({
          id,
          host: "github.com",
          owner: "acme",
          repo: "app",
          itemKind: "issue" as const,
          number: 42,
          localFilePath: "/vault/x.md",
          createdAt: "2026-07-01T00:00:00Z"
        }),
        body: "Queued"
      };
    }
    // The missing-draft issue fails before any request is made.
    const missingDraft = createIssueOutboxOperation({
      id: "issue-x",
      host: "github.com",
      owner: "acme",
      repo: "app",
      localFilePath: "/missing/draft.md",
      createdAt: "2026-07-01T00:00:00Z"
    });

    const results = await syncOutboxOperations(
      client(fetchMock as unknown as typeof fetch),
      [missingDraft, comment("comment-rejected"), comment("comment-accepted")],
      []
    );

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain("Draft issue file is missing");
    expect(results[1].ok).toBe(false);
    expect(results[1].error).toContain("422");
    expect(results[2].ok).toBe(true);
  });

  it("closes an issue after its comment is created when requested", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 456,
          node_id: "IC_456",
          body: "Done",
          created_at: "2026-07-02T01:00:00Z"
        }),
        { status: 201 }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ state: "closed" }), { status: 200 })
    );

    const operation = {
      ...createCommentOutboxOperation({
        id: "comment-close",
        host: "github.com",
        owner: "acme",
        repo: "app",
        itemKind: "issue",
        number: 42,
        closeAfterComment: true,
        localFilePath: "/vault/x.md",
        createdAt: "2026-07-01T00:00:00Z"
      }),
      body: "Done"
    };

    const results = await syncOutboxOperations(
      client(fetchMock as unknown as typeof fetch),
      [operation],
      [],
      { retryDelays: [] }
    );

    expect(results[0]).toMatchObject({
      ok: true,
      remote: { type: "comment", id: 456, closedIssue: true }
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/repos/acme/app/issues/42/comments",
      expect.objectContaining({ method: "POST" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/repos/acme/app/issues/42",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          state: "closed",
          state_reason: "completed"
        })
      })
    );
  });

  it("closes an issue with the queued GitHub state reason", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 456,
          node_id: "IC_456",
          body: "Won't do",
          created_at: "2026-07-02T01:00:00Z"
        }),
        { status: 201 }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ state: "closed" }), { status: 200 })
    );

    const operation = {
      ...createCommentOutboxOperation({
        id: "comment-close-reason",
        host: "github.com",
        owner: "acme",
        repo: "app",
        itemKind: "issue",
        number: 42,
        closeAfterComment: { kind: "issue", reason: "not_planned" },
        localFilePath: "/vault/x.md",
        createdAt: "2026-07-01T00:00:00Z"
      }),
      body: "Won't do"
    };

    const results = await syncOutboxOperations(
      client(fetchMock as unknown as typeof fetch),
      [operation],
      [],
      { retryDelays: [] }
    );

    expect(results[0]).toMatchObject({
      ok: true,
      remote: { type: "comment", id: 456, closedIssue: true }
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/repos/acme/app/issues/42",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          state: "closed",
          state_reason: "not_planned"
        })
      })
    );
  });

  it("closes an issue without creating a blank comment when the operation body is empty", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ state: "closed" }), { status: 200 })
    );

    const operation = {
      ...createCommentOutboxOperation({
        id: "issue-close-only",
        host: "github.com",
        owner: "acme",
        repo: "app",
        itemKind: "issue",
        number: 42,
        closeAfterComment: { kind: "issue", reason: "completed" },
        localFilePath: "/vault/x.md",
        createdAt: "2026-07-01T00:00:00Z"
      }),
      body: ""
    };

    const results = await syncOutboxOperations(
      client(fetchMock as unknown as typeof fetch),
      [operation],
      [],
      { retryDelays: [] }
    );

    expect(results[0]).toMatchObject({
      ok: true,
      remote: { type: "close", closedIssue: true }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/repos/acme/app/issues/42",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          state: "closed",
          state_reason: "completed"
        })
      })
    );
  });

  it("closes a pull request after its comment is created when requested", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 457,
          node_id: "IC_457",
          body: "Closing PR",
          created_at: "2026-07-02T01:00:00Z"
        }),
        { status: 201 }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ state: "closed" }), { status: 200 })
    );

    const operation = {
      ...createCommentOutboxOperation({
        id: "pull-close",
        host: "github.com",
        owner: "acme",
        repo: "app",
        itemKind: "pull",
        number: 43,
        closeAfterComment: { kind: "pull" },
        localFilePath: "/vault/x.md",
        createdAt: "2026-07-01T00:00:00Z"
      }),
      body: "Closing PR"
    };

    const results = await syncOutboxOperations(
      client(fetchMock as unknown as typeof fetch),
      [operation],
      [],
      { retryDelays: [] }
    );

    expect(results[0]).toMatchObject({
      ok: true,
      remote: { type: "comment", id: 457, closedPullRequest: true }
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/repos/acme/app/pulls/43",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ state: "closed" })
      })
    );
  });

  it("closes a pull request without creating a blank comment when the operation body is empty", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ state: "closed" }), { status: 200 })
    );

    const operation = {
      ...createCommentOutboxOperation({
        id: "pull-close-only",
        host: "github.com",
        owner: "acme",
        repo: "app",
        itemKind: "pull",
        number: 43,
        closeAfterComment: { kind: "pull" },
        localFilePath: "/vault/x.md",
        createdAt: "2026-07-01T00:00:00Z"
      }),
      body: ""
    };

    const results = await syncOutboxOperations(
      client(fetchMock as unknown as typeof fetch),
      [operation],
      [],
      { retryDelays: [] }
    );

    expect(results[0]).toMatchObject({
      ok: true,
      remote: { type: "close", closedPullRequest: true }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/repos/acme/app/pulls/43",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ state: "closed" })
      })
    );
  });

  it("closes a discussion with its queued reason after the comment is created", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      if (payload.query?.includes("discussion(number")) {
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                discussion: {
                  id: "D_kwDO",
                  title: "Weekly",
                  comments: { nodes: [] }
                }
              }
            }
          }),
          { status: 200 }
        );
      }
      if (payload.query?.includes("closeDiscussion")) {
        return new Response(
          JSON.stringify({
            data: {
              closeDiscussion: {
                discussion: { id: "D_kwDO", closed: true }
              }
            }
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            addDiscussionComment: {
              comment: {
                id: "DC_kwDO",
                databaseId: 789,
                body: payload.variables?.body,
                createdAt: "2026-07-02T00:00:00Z"
              }
            }
          }
        }),
        { status: 200 }
      );
    });
    const operation = {
      ...createCommentOutboxOperation({
        id: "discussion-close",
        host: "github.com",
        owner: "acme",
        repo: "app",
        itemKind: "discussion",
        number: 5,
        closeAfterComment: { kind: "discussion", reason: "outdated" },
        localFilePath: "/vault/x.md",
        createdAt: "2026-07-01T00:00:00Z"
      }),
      body: "Discussion reply"
    };

    const results = await syncOutboxOperations(
      client(fetchMock as unknown as typeof fetch),
      [operation],
      [],
      { retryDelays: [] }
    );

    expect(results[0]).toMatchObject({
      ok: true,
      remote: { type: "comment", id: 789, closedDiscussion: true }
    });
    const closePayload = JSON.parse(String(fetchMock.mock.calls[3][1]?.body));
    expect(closePayload.variables).toEqual({
      discussionId: "D_kwDO",
      reason: "OUTDATED"
    });
  });

  it("closes a discussion without creating a blank comment when the operation body is empty", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      if (payload.query?.includes("discussion(number")) {
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                discussion: {
                  id: "D_kwDO",
                  title: "Weekly",
                  comments: { nodes: [] }
                }
              }
            }
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            closeDiscussion: {
              discussion: { id: "D_kwDO", closed: true }
            }
          }
        }),
        { status: 200 }
      );
    });
    const operation = {
      ...createCommentOutboxOperation({
        id: "discussion-close-only",
        host: "github.com",
        owner: "acme",
        repo: "app",
        itemKind: "discussion",
        number: 5,
        closeAfterComment: { kind: "discussion", reason: "resolved" },
        localFilePath: "/vault/x.md",
        createdAt: "2026-07-01T00:00:00Z"
      }),
      body: ""
    };

    const results = await syncOutboxOperations(
      client(fetchMock as unknown as typeof fetch),
      [operation],
      [],
      { retryDelays: [] }
    );

    expect(results[0]).toMatchObject({
      ok: true,
      remote: { type: "close", closedDiscussion: true }
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const closePayload = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(closePayload.query).toContain("closeDiscussion");
    expect(closePayload.variables).toEqual({
      discussionId: "D_kwDO",
      reason: "RESOLVED"
    });
  });

  it("uses discussion comment sync for discussion targets", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      if (payload.query?.includes("discussion(number")) {
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                discussion: {
                  id: "D_kwDO",
                  title: "Weekly",
                  comments: { nodes: [] }
                }
              }
            }
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            addDiscussionComment: {
              comment: {
                id: "DC_kwDO",
                databaseId: 789,
                body: payload.variables?.body,
                createdAt: "2026-07-02T00:00:00Z"
              }
            }
          }
        }),
        { status: 200 }
      );
    });
    const operation = {
      ...createCommentOutboxOperation({
        id: "discussion-comment",
        host: "github.com",
        owner: "acme",
        repo: "app",
        itemKind: "discussion",
        number: 5,
        localFilePath: "/vault/x.md",
        createdAt: "2026-07-01T00:00:00Z"
      }),
      body: "Discussion reply"
    };

    const results = await syncOutboxOperations(
      client(fetchMock as unknown as typeof fetch),
      [operation],
      [],
      { retryDelays: [] }
    );

    expect(results[0]).toMatchObject({
      ok: true,
      remote: { type: "comment", id: 789 }
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("passes parent comment node ids when syncing discussion replies", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      if (payload.query?.includes("discussion(number")) {
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                discussion: {
                  id: "D_kwDO",
                  title: "Weekly",
                  comments: { nodes: [] }
                }
              }
            }
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            addDiscussionComment: {
              comment: {
                id: "DC_reply",
                databaseId: 790,
                body: payload.variables?.body,
                createdAt: "2026-07-02T00:00:00Z"
              }
            }
          }
        }),
        { status: 200 }
      );
    });
    const operation = {
      ...createCommentOutboxOperation({
        id: "discussion-reply",
        host: "github.com",
        owner: "acme",
        repo: "app",
        itemKind: "discussion",
        number: 5,
        parentCommentNodeId: "DC_parent",
        localFilePath: "/vault/x.md",
        createdAt: "2026-07-01T00:00:00Z"
      }),
      body: "Nested discussion reply"
    };

    const results = await syncOutboxOperations(
      client(fetchMock as unknown as typeof fetch),
      [operation],
      [],
      { retryDelays: [] }
    );

    expect(results[0]).toMatchObject({
      ok: true,
      remote: { type: "comment", id: 790 }
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      variables: { replyToId: "DC_parent" }
    });
  });

  function commentOperation(id = "comment-1") {
    return {
      ...createCommentOutboxOperation({
        id,
        host: "github.com",
        owner: "acme",
        repo: "app",
        itemKind: "issue" as const,
        number: 42,
        localFilePath: "/vault/x.md",
        createdAt: "2026-07-01T00:00:00Z"
      }),
      body: "Queued"
    };
  }

  it("marks 404/410/422 failures as permanent and does not retry them", async () => {
    for (const status of [404, 410, 422]) {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ message: "Not Found" }), { status })
      );

      const results = await syncOutboxOperations(
        client(fetchMock as unknown as typeof fetch),
        [commentOperation()],
        [],
        { retryDelays: [0, 0] }
      );

      expect(results[0].ok, String(status)).toBe(false);
      expect(results[0].permanent, String(status)).toBe(true);
      expect(fetchMock, String(status)).toHaveBeenCalledTimes(1);
    }
  });

  it("retries transient 5xx failures and recovers", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "boom" }), { status: 502 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 9 }), { status: 201 })
    );

    const results = await syncOutboxOperations(
      client(fetchMock as unknown as typeof fetch),
      [commentOperation()],
      [],
      { retryDelays: [0, 0] }
    );

    expect(results[0].ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retry budget and reports a transient failure", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ message: "boom" }), { status: 500 })
    );

    const results = await syncOutboxOperations(
      client(fetchMock as unknown as typeof fetch),
      [commentOperation()],
      [],
      { retryDelays: [0, 0] }
    );

    expect(results[0].ok).toBe(false);
    expect(results[0].permanent).toBe(false);
    // initial attempt + 2 retries
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("treats rate-limited 403s as transient and other 403s as permanent", async () => {
    const rateLimited = vi.fn(async () =>
      new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
        status: 403
      })
    );
    const forbidden = vi.fn(async () =>
      new Response(JSON.stringify({ message: "Issue is locked" }), { status: 403 })
    );

    const [rateResult] = await syncOutboxOperations(
      client(rateLimited as unknown as typeof fetch),
      [commentOperation()],
      [],
      { retryDelays: [0] }
    );
    const [lockedResult] = await syncOutboxOperations(
      client(forbidden as unknown as typeof fetch),
      [commentOperation()],
      [],
      { retryDelays: [0] }
    );

    expect(rateResult.permanent).toBe(false);
    expect(rateLimited).toHaveBeenCalledTimes(2);
    expect(lockedResult.permanent).toBe(true);
    expect(forbidden).toHaveBeenCalledTimes(1);
  });

  it("retries network errors as transient", async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>();
    fetchMock.mockRejectedValueOnce(new TypeError("network down"));
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 3 }), { status: 201 })
    );

    const results = await syncOutboxOperations(
      client(fetchMock as unknown as typeof fetch),
      [commentOperation()],
      [],
      { retryDelays: [0, 0] }
    );

    expect(results[0].ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
