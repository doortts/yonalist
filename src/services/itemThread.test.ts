import { describe, expect, it, vi } from "vitest";
import type { GithubConnection } from "../hooks/useGithubAuth";
import { fetchItemThread } from "./itemThread";

const connection: GithubConnection = {
  apiBaseUrl: "https://api.github.com",
  webBaseUrl: "https://github.com",
  token: "token"
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("fetchItemThread", () => {
  it("marks merged draft pulls and returns the comment thread", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/comments")) {
        return jsonResponse([
          { id: 1, body: "First!", user: { login: "mona" }, created_at: "2026-07-02T00:00:00Z" }
        ]);
      }
      expect(target).toContain("/pulls/17");
      return jsonResponse({
        state: "closed",
        merged_at: "2026-07-01T00:00:00Z",
        draft: false
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const thread = await fetchItemThread(connection, {
        kind: "pull",
        owner: "acme",
        repo: "app",
        number: 17
      });

      expect(thread.state).toBe("merged");
      expect(thread.comments).toEqual([
        {
          id: "1",
          author: "mona",
          avatarUrl: undefined,
          authorAssociation: undefined,
          created_at: "2026-07-02T00:00:00Z",
          body: "First!",
          reactions: []
        }
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("loads issue state and keeps going when comments fail", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/comments")) {
        return new Response("{}", { status: 500 });
      }
      return jsonResponse({ state: "closed" });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const thread = await fetchItemThread(connection, {
        kind: "issue",
        owner: "acme",
        repo: "app",
        number: 42
      });

      expect(thread.state).toBe("closed");
      expect(thread.comments).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("loads discussion comments through GraphQL", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      expect(target).toContain("/graphql");
      return jsonResponse({
        data: {
          repository: {
            discussion: {
              closed: false,
              comments: {
                nodes: [
                  {
                    databaseId: 2,
                    body: "Reply",
                    author: { login: "mona" },
                    createdAt: "2026-07-02T00:00:00Z"
                  }
                ]
              }
            }
          }
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const thread = await fetchItemThread(connection, {
        kind: "discussion",
        owner: "acme",
        repo: "app",
        number: 5
      });

      expect(thread.state).toBe("open");
      expect(thread.comments).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
