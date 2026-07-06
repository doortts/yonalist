import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sampleItems } from "../fixtures/sampleItems";
import type { ItemDocument } from "../domain/types";
import { useItemThread } from "./useItemThread";

interface ThreadHarnessProps {
  token: string;
  item?: ItemDocument;
}

function ThreadHarness({ token, item = sampleItems[0] }: ThreadHarnessProps) {
  const state = useItemThread(
    item,
    {
      apiBaseUrl: "https://api.github.com",
      webBaseUrl: "https://github.com",
      token
    },
    true
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

describe("useItemThread", () => {
  afterEach(() => {
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
});
