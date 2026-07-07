import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sampleItems } from "../fixtures/sampleItems";
import type { ItemDocument } from "../domain/types";
import { clearItemThreadCache } from "../services/itemThread";
import { useItemThread } from "./useItemThread";

interface ThreadHarnessProps {
  token: string;
  item?: ItemDocument | null;
  refreshKey?: number;
}

function ThreadHarness({ token, item, refreshKey = 0 }: ThreadHarnessProps) {
  const selectedItem = item === undefined ? sampleItems[0] : item;
  const state = useItemThread(
    selectedItem,
    {
      apiBaseUrl: "https://api.github.com",
      webBaseUrl: "https://github.com",
      token
    },
    true,
    refreshKey
  );

  return (
    <div>
      <span>{state.loading ? "loading" : "idle"}</span>
      <span>{state.thread?.comments[0]?.body ?? "no-comments"}</span>
    </div>
  );
}

const cachedVaultItem: ItemDocument = {
  path: "/Users/doortts/Yonalist/oss.navercorp.com/pi/agent-dev/discussions/50/discussion.md",
  body: "Cached discussion body",
  frontMatter: {
    kind: "discussion",
    host: "oss.navercorp.com",
    owner: "pi",
    repo: "agent-dev",
    number: 50,
    title: "Cached real discussion",
    state: "open",
    author: "sw-codex",
    labels: [],
    created_at: "2026-05-19T00:00:00Z",
    updated_at: "2026-05-19T00:00:00Z",
    local: { favorite: false },
    sync: { status: "synced" }
  }
};

function item(number: number, title: string): ItemDocument {
  return {
    path: `/vault/github.com/acme/app/pulls/${number}/pull.md`,
    body: title,
    frontMatter: {
      kind: "pull",
      host: "github.com",
      owner: "acme",
      repo: "app",
      number,
      title,
      state: "open",
      author: `author-${number}`,
      labels: [],
      created_at: "2026-07-01T00:00:00Z",
      updated_at: `2026-07-0${number}T00:00:00Z`,
      local: { favorite: false },
      sync: { status: "synced" }
    }
  };
}

describe("useItemThread", () => {
  afterEach(() => {
    clearItemThreadCache();
    vi.unstubAllGlobals();
  });

  it("clears a stale loading state when switching from a live request to demo comments", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        if (init?.signal) {
          signals.push(init.signal);
        }
        return new Promise<Response>(() => {});
      })
    );

    const { rerender } = render(<ThreadHarness token="ghp_test" />);

    expect(await screen.findByText("loading")).toBeInTheDocument();

    rerender(<ThreadHarness token="" />);

    await waitFor(() => {
      expect(screen.getByText("idle")).toBeInTheDocument();
    });
    expect(signals.some((signal) => signal.aborted)).toBe(true);
    expect(
      screen.getByText("Sample reply so the conversation thread layout is visible offline.")
    ).toBeInTheDocument();
  });

  it("does not attach demo comments to cached vault items without a token", () => {
    render(<ThreadHarness item={cachedVaultItem} token="" />);

    expect(screen.getByText("idle")).toBeInTheDocument();
    expect(screen.getByText("no-comments")).toBeInTheDocument();
    expect(
      screen.queryByText("Sample reply so the conversation thread layout is visible offline.")
    ).not.toBeInTheDocument();
  });

  it("shows a cached thread immediately when reselecting an unchanged item", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/comments")) {
        return new Response(
          JSON.stringify([
            {
              id: 1,
              body: "cached comment",
              user: { login: "mona" },
              created_at: "2026-07-02T00:00:00Z"
            }
          ]),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (target.includes("/users/mona")) {
        return new Response(JSON.stringify({ login: "mona" }), { status: 200 });
      }
      return new Response(JSON.stringify({ state: "open" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(<ThreadHarness token="ghp_test" />);

    await screen.findByText("cached comment");
    await waitFor(() => {
      expect(screen.getByText("idle")).toBeInTheDocument();
    });
    const callsAfterFirstLoad = fetchMock.mock.calls.length;

    rerender(<ThreadHarness token="ghp_test" item={undefined} />);
    rerender(<ThreadHarness token="ghp_test" />);

    expect(screen.getByText("cached comment")).toBeInTheDocument();
    expect(screen.getByText("idle")).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirstLoad);
  });

  it("reloads the remote thread when the refresh key changes", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/comments")) {
        const commentBody =
          fetchMock.mock.calls.filter(([calledUrl]) =>
            String(calledUrl).includes("/comments")
          ).length === 1
            ? "old comment"
            : "new synced comment";
        return new Response(
          JSON.stringify([
            {
              id: 1,
              body: commentBody,
              user: { login: "mona" },
              created_at: "2026-07-02T00:00:00Z"
            }
          ]),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (target.includes("/users/mona")) {
        return new Response(JSON.stringify({ login: "mona" }), { status: 200 });
      }
      return new Response(JSON.stringify({ state: "open" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(<ThreadHarness token="ghp_test" refreshKey={0} />);

    await screen.findByText("old comment");

    rerender(<ThreadHarness token="ghp_test" refreshKey={1} />);

    expect(await screen.findByText("new synced comment")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/comments"))
    ).toHaveLength(2);
  });

  it("clears the previous thread while a different item is loading", async () => {
    const firstItem = item(1, "first");
    const secondItem = item(2, "second");
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/pulls/1")) {
        return new Response(
          JSON.stringify({
            state: "open",
            user: {
              login: "first-author",
              avatar_url: "https://avatars.example.com/first.png"
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (target.includes("/issues/1/comments")) {
        return new Response(
          JSON.stringify([
            {
              id: 1,
              body: "first item comment",
              user: { login: "first-commenter" },
              created_at: "2026-07-02T00:00:00Z"
            }
          ]),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (target.includes("/pulls/2") || target.includes("/issues/2/comments")) {
        return new Promise<Response>(() => {});
      }
      return new Response(JSON.stringify({ login: "user" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(<ThreadHarness token="ghp_test" item={firstItem} />);

    await screen.findByText("first item comment");

    rerender(<ThreadHarness token="ghp_test" item={secondItem} />);

    await waitFor(() => {
      expect(screen.getByText("loading")).toBeInTheDocument();
    });
    expect(screen.getByText("no-comments")).toBeInTheDocument();
    expect(screen.queryByText("first item comment")).not.toBeInTheDocument();
  });
});
