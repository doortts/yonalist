import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubConnection } from "../hooks/useGithubAuth";
import {
  clearItemThreadCache,
  deleteCachedItemThread,
  fetchItemThread,
  getItemThreadCacheStats
} from "./itemThread";

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
  beforeEach(() => {
    clearItemThreadCache();
  });

  it("marks merged draft pulls and returns the comment thread", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/comments")) {
        return jsonResponse([
          {
            id: 1,
            body: "First!",
            user: {
              login: "mona",
              avatar_url: "https://avatars.example.com/mona.png"
            },
            created_at: "2026-07-02T00:00:00Z"
          }
        ]);
      }
      if (target.includes("/users/mona")) {
        return jsonResponse({
          login: "mona",
          name: "Mona Lisa",
          avatar_url: "https://avatars.example.com/mona.png"
        });
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
          authorName: "Mona Lisa",
          avatarUrl: "https://avatars.example.com/mona.png",
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
      // The failure must be visible, not disguised as "no comments".
      expect(thread.commentsError).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports commentsError false when the comment fetch succeeds", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/comments")) {
        return jsonResponse([]);
      }
      return jsonResponse({ state: "open" });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const thread = await fetchItemThread(connection, {
        kind: "issue",
        owner: "acme",
        repo: "app",
        number: 42
      });

      expect(thread.commentsError).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("serves repeat requests for the same version from the cache", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/comments")) {
        return jsonResponse([]);
      }
      return jsonResponse({ state: "open" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const target = { kind: "issue" as const, owner: "acme", repo: "app", number: 42 };
    try {
      await fetchItemThread(connection, target, { version: "2026-07-01T00:00:00Z" });
      const callsAfterFirst = fetchMock.mock.calls.length;
      const cached = await fetchItemThread(connection, target, {
        version: "2026-07-01T00:00:00Z"
      });

      expect(cached.state).toBe("open");
      expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports the current thread cache entry count and approximate size", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/comments")) {
        return jsonResponse([
          {
            id: 1,
            body: "Cached comment",
            user: { login: "mona" },
            created_at: "2026-07-02T00:00:00Z"
          }
        ]);
      }
      if (String(url).includes("/users/mona")) {
        return jsonResponse({ login: "mona", name: "Mona Lisa" });
      }
      return jsonResponse({ state: "open" });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      await fetchItemThread(
        connection,
        { kind: "issue", owner: "acme", repo: "app", number: 42 },
        { version: "v1" }
      );

      const stats = getItemThreadCacheStats();
      expect(stats.entries).toBe(1);
      expect(stats.bytes).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refetches when the item's version changes", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/comments")) {
        return jsonResponse([]);
      }
      return jsonResponse({ state: "open" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const target = { kind: "issue" as const, owner: "acme", repo: "app", number: 42 };
    try {
      await fetchItemThread(connection, target, { version: "v1" });
      const callsAfterFirst = fetchMock.mock.calls.length;
      await fetchItemThread(connection, target, { version: "v2" });

      expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("can evict one cached thread without clearing the whole thread cache", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/comments")) {
        return jsonResponse([]);
      }
      return jsonResponse({ state: "open" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = { kind: "issue" as const, owner: "acme", repo: "app", number: 1 };
    const second = { kind: "issue" as const, owner: "acme", repo: "app", number: 2 };
    try {
      await fetchItemThread(connection, first, { version: "v1" });
      await fetchItemThread(connection, second, { version: "v1" });
      const callsAfterWarmup = fetchMock.mock.calls.length;

      deleteCachedItemThread(connection, first, "v1");
      await fetchItemThread(connection, first, { version: "v1" });
      await fetchItemThread(connection, second, { version: "v1" });

      expect(fetchMock.mock.calls.length).toBe(callsAfterWarmup + 2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not cache threads whose comments failed to load", async () => {
    let commentCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/comments")) {
        commentCalls += 1;
        return commentCalls === 1
          ? new Response("{}", { status: 500 })
          : jsonResponse([]);
      }
      return jsonResponse({ state: "open" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const target = { kind: "issue" as const, owner: "acme", repo: "app", number: 42 };
    try {
      const first = await fetchItemThread(connection, target, { version: "v1" });
      const second = await fetchItemThread(connection, target, { version: "v1" });

      expect(first.commentsError).toBe(true);
      expect(second.commentsError).toBe(false);
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
                    author: { login: "mona", name: "Mona Lisa" },
                    createdAt: "2026-07-02T00:00:00Z",
                    replies: {
                      nodes: [
                        {
                          databaseId: 3,
                          body: "Nested reply",
                          author: { login: "octocat", name: "The Octocat" },
                          createdAt: "2026-07-02T01:00:00Z"
                        }
                      ]
                    }
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
      expect(thread.comments[0].authorName).toBe("Mona Lisa");
      expect(thread.comments[0].replies?.[0]).toMatchObject({
        body: "Nested reply",
        authorName: "The Octocat"
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("hydrates opening post and comment display names from user profiles", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/comments")) {
        return jsonResponse([
          {
            id: 9,
            body: "Named reply",
            user: { login: "mona" },
            created_at: "2026-07-02T00:00:00Z"
          }
        ]);
      }
      if (target.includes("/users/doortts")) {
        return jsonResponse({ login: "doortts", name: "Doortts Kim" });
      }
      if (target.includes("/users/mona")) {
        return jsonResponse({ login: "mona", name: "Mona Lisa" });
      }
      return jsonResponse({
        state: "open",
        user: { login: "doortts" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const thread = await fetchItemThread(connection, {
        kind: "issue",
        owner: "acme",
        repo: "app",
        number: 42
      });

      expect(thread.authorName).toBe("Doortts Kim");
      expect(thread.comments[0].authorName).toBe("Mona Lisa");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
