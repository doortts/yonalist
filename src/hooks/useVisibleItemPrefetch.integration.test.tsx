import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ItemDocument } from "../domain/types";
import { clearItemThreadCache } from "../services/itemThread";
import { useItemThread } from "./useItemThread";
import { useVisibleItemPrefetch } from "./useVisibleItemPrefetch";

const vaultRoot = "/vault";
const connection = {
  apiBaseUrl: "https://api.github.com",
  webBaseUrl: "https://github.com",
  token: "ghp_test"
};

const item: ItemDocument = {
  path: "/vault/github.com/acme/app/issues/42/issue.md",
  body: "Issue body",
  frontMatter: {
    kind: "issue",
    host: "github.com",
    owner: "acme",
    repo: "app",
    number: 42,
    title: "Cached issue",
    state: "open",
    author: "owner",
    labels: [],
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    local: { favorite: false },
    sync: { status: "synced" }
  }
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function Harness({ selected }: { selected: boolean }) {
  useVisibleItemPrefetch({
    visibleItems: [item],
    selectedPath: selected ? item.path : null,
    vaultRoot,
    connection,
    online: true,
    enabled: true,
    loadedBodies: {},
    dwellMs: 2_000,
    evictionMs: 60_000,
    onBodyPrefetched: vi.fn(),
    onBodyInvalidated: vi.fn()
  });
  const thread = useItemThread(selected ? item : null, connection, true);

  return (
    <div>
      <span>{thread.loading ? "loading" : "idle"}</span>
      <span>{thread.thread?.comments[0]?.body ?? "no-comments"}</span>
    </div>
  );
}

describe("visible item prefetch and selected thread rendering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearItemThreadCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearItemThreadCache();
    vi.unstubAllGlobals();
  });

  it("uses the prefetched thread cache when the user later selects the item", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/comments")) {
        return jsonResponse([
          {
            id: 1001,
            body: "prefetched comment",
            user: { login: "mona" },
            created_at: "2026-07-03T00:00:00Z"
          }
        ]);
      }
      if (target.includes("/users/")) {
        return jsonResponse({ login: target.split("/").pop(), name: null });
      }
      return jsonResponse({
        state: "open",
        user: { login: "owner" },
        labels: []
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(<Harness selected={false} />);

    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();

    const callsAfterPrefetch = fetchMock.mock.calls.length;
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/comments"))
    ).toBe(true);

    rerender(<Harness selected />);
    await flushPromises();

    expect(screen.queryByText("loading")).not.toBeInTheDocument();
    expect(screen.getByText("prefetched comment")).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBe(callsAfterPrefetch);
  });
});
