import { describe, expect, it, vi } from "vitest";
import type { GitHubNotification } from "../domain/notifications";
import { fetchNotificationDetail } from "./notificationDetail";

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
  it("loads an issue with its comment thread", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/issues/42/comments")) {
        return jsonResponse([
          { id: 9, body: "First!", user: { login: "mona" }, created_at: "2026-07-02T11:00:00Z" }
        ]);
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
    expect(detail.authorAvatarUrl).toBe("https://avatars/doortts.png");
    expect(detail.authorAssociation).toBe("OWNER");
    expect(detail.labels).toEqual([{ name: "bug", color: "d73a4a" }]);
    expect(detail.comments).toEqual([
      {
        id: "9",
        author: "mona",
        avatarUrl: undefined,
        authorAssociation: undefined,
        created_at: "2026-07-02T11:00:00Z",
        body: "First!"
      }
    ]);
  });

  it("marks merged pull requests as merged", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/comments")) {
        return jsonResponse([]);
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
              author: { login: "doortts" },
              createdAt: "2026-07-01T00:00:00Z",
              labels: { nodes: [{ name: "planning" }] },
              comments: {
                nodes: [
                  {
                    databaseId: 1,
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

    const detail = await fetchNotificationDetail({
      ...baseOptions,
      notification: notification(
        "Discussion",
        "https://api.github.com/repos/acme/app/discussions/5"
      ),
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    expect(detail.title).toBe("Roadmap");
    expect(detail.labels).toEqual([{ name: "planning", color: "" }]);
    expect(detail.comments).toHaveLength(1);
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
