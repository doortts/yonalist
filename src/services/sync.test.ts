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
