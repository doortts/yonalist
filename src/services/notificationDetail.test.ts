import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubNotification } from "../domain/notifications";
import {
  clearNotificationDetailCache,
  fetchNotificationDetail
} from "./notificationDetail";

function notification(
  type: string,
  url: string
): GitHubNotification {
  return {
    id: "1",
    unread: true,
    reason: "mention",
    updated_at: "2026-07-02T10:00:00Z",
    last_read_at: null,
    subject: { title: "Subject", url, type },
    repository: { full_name: "acme/app", name: "app", owner: { login: "acme" } }
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

const baseOptions = {
  token: "token",
  apiBaseUrl: "https://api.github.com",
  webBaseUrl: "https://github.com"
};

describe("fetchNotificationDetail", () => {
  beforeEach(() => {
    clearNotificationDetailCache();
  });

  it("serves the same notification version from the cache", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/comments")) {
        return jsonResponse([]);
      }
      return jsonResponse({ title: "Cached", state: "open", user: { login: "mona" } });
    });

    const options = {
      ...baseOptions,
      notification: notification("Issue", "https://api.github.com/repos/acme/app/issues/7"),
      fetchImpl: fetchMock as unknown as typeof fetch
    };
    await fetchNotificationDetail(options);
    const callsAfterFirst = fetchMock.mock.calls.length;
    const cached = await fetchNotificationDetail(options);

    expect(cached.title).toBe("Cached");
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("refetches when the notification's updated_at changes", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/comments")) {
        return jsonResponse([]);
      }
      return jsonResponse({ title: "Fresh", state: "open", user: { login: "mona" } });
    });

    const base = notification("Issue", "https://api.github.com/repos/acme/app/issues/7");
    await fetchNotificationDetail({
      ...baseOptions,
      notification: base,
      fetchImpl: fetchMock as unknown as typeof fetch
    });
    const callsAfterFirst = fetchMock.mock.calls.length;
    await fetchNotificationDetail({
      ...baseOptions,
      notification: { ...base, updated_at: "2026-07-03T00:00:00Z" },
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("flags and does not cache details whose comments failed", async () => {
    let commentCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/comments")) {
        commentCalls += 1;
        return commentCalls === 1
          ? new Response("{}", { status: 500 })
          : jsonResponse([]);
      }
      return jsonResponse({ title: "T", state: "open", user: { login: "mona" } });
    });

    const options = {
      ...baseOptions,
      notification: notification("Issue", "https://api.github.com/repos/acme/app/issues/7"),
      fetchImpl: fetchMock as unknown as typeof fetch
    };
    const first = await fetchNotificationDetail(options);
    const second = await fetchNotificationDetail(options);

    expect(first.commentsError).toBe(true);
    expect(second.commentsError).toBe(false);
  });

  it("loads an issue with its comment thread", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/issues/42/comments")) {
        return jsonResponse([
          { id: 9, body: "First!", user: { login: "mona" }, created_at: "2026-07-02T11:00:00Z" }
        ]);
      }
      if (target.includes("/users/doortts")) {
        return jsonResponse({ login: "doortts", name: "Doortts Kim" });
      }
      if (target.includes("/users/mona")) {
        return jsonResponse({ login: "mona", name: "Mona Lisa" });
      }
      return jsonResponse({
        title: "Fix login",
        state: "open",
        body: "Issue body",
        user: { login: "doortts", avatar_url: "https://avatars/doortts.png" },
        labels: [{ name: "bug", color: "d73a4a" }],
        author_association: "OWNER",
        created_at: "2026-07-01T00:00:00Z"
      });
    });

    const detail = await fetchNotificationDetail({
      ...baseOptions,
      notification: notification("Issue", "https://api.github.com/repos/acme/app/issues/42"),
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    expect(detail.title).toBe("Fix login");
    expect(detail.state).toBe("open");
    expect(detail.authorName).toBe("Doortts Kim");
    expect(detail.authorAvatarUrl).toBe("https://avatars/doortts.png");
    expect(detail.authorAssociation).toBe("OWNER");
    expect(detail.labels).toEqual([{ name: "bug", color: "d73a4a" }]);
    expect(detail.comments).toEqual([
      {
        id: "9",
        author: "mona",
        authorName: "Mona Lisa",
        avatarUrl: undefined,
        authorAssociation: undefined,
        created_at: "2026-07-02T11:00:00Z",
        body: "First!",
        reactions: []
      }
    ]);
  });

  it("marks merged pull requests as merged", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/comments")) {
        return jsonResponse([]);
      }
      if (target.includes("/users/mona")) {
        return jsonResponse({ login: "mona", name: "Mona Lisa" });
      }
      expect(target).toContain("/pulls/17");
      return jsonResponse({
        title: "Ship it",
        state: "closed",
        merged_at: "2026-07-01T00:00:00Z",
        body: "PR body",
        user: { login: "mona" }
      });
    });

    const detail = await fetchNotificationDetail({
      ...baseOptions,
      notification: notification(
        "PullRequest",
        "https://api.github.com/repos/acme/app/pulls/17"
      ),
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    expect(detail.state).toBe("merged");
  });

  it("loads discussions with their comments", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      expect(target).toContain("/graphql");
      return jsonResponse({
        data: {
          repository: {
            discussion: {
              title: "Roadmap",
              closed: false,
              body: "Talk",
              author: { login: "doortts", name: "Doortts Kim" },
              createdAt: "2026-07-01T00:00:00Z",
              labels: { nodes: [{ name: "planning" }] },
              comments: {
                nodes: [
                  {
                    databaseId: 1,
                    body: "Reply",
                    author: { login: "mona", name: "Mona Lisa" },
                    createdAt: "2026-07-02T00:00:00Z"
                  }
                ]
              }
            }
          }
        }
      });
    });

    const detail = await fetchNotificationDetail({
      ...baseOptions,
      notification: notification(
        "Discussion",
        "https://api.github.com/repos/acme/app/discussions/5"
      ),
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    expect(detail.title).toBe("Roadmap");
    expect(detail.authorName).toBe("Doortts Kim");
    expect(detail.labels).toEqual([{ name: "planning", color: "" }]);
    expect(detail.comments[0].authorName).toBe("Mona Lisa");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("loads release notes using the release id from the subject", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain("/releases/1001");
      return jsonResponse({
        name: "v0.1.0",
        tag_name: "v0.1.0",
        body: "Notes",
        author: { login: "doortts" },
        published_at: "2026-07-01T00:00:00Z"
      });
    });

    const detail = await fetchNotificationDetail({
      ...baseOptions,
      notification: notification(
        "Release",
        "https://api.github.com/repos/acme/app/releases/1001"
      ),
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    expect(detail.title).toBe("v0.1.0");
    expect(detail.state).toBe("v0.1.0");
    expect(detail.body).toBe("Notes");
  });
});
