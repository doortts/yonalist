import { render } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ItemDocument } from "../domain/types";
import { warmMarkdownBodies } from "../components/MarkdownBody";
import {
  fetchItemThread,
  deleteCachedItemThread,
  type ItemThread
} from "../services/itemThread";
import {
  loadItemDocumentBody,
  persistCommentDocuments,
  persistItemDocument
} from "../services/vaultStore";
import { useVisibleItemPrefetch } from "./useVisibleItemPrefetch";
import type { VisibleItemPrefetchStats } from "./useVisibleItemPrefetch";

vi.mock("../services/itemThread", () => ({
  fetchItemThread: vi.fn(),
  deleteCachedItemThread: vi.fn()
}));

vi.mock("../services/vaultStore", () => ({
  loadItemDocumentBody: vi.fn(),
  persistCommentDocuments: vi.fn(),
  persistItemDocument: vi.fn()
}));

vi.mock("../components/MarkdownBody", () => ({
  warmMarkdownBodies: vi.fn().mockResolvedValue(undefined)
}));

const vaultRoot = "/vault";
const connection = {
  apiBaseUrl: "https://api.github.com",
  webBaseUrl: "https://github.com",
  token: "ghp_test"
};

const baseItem: ItemDocument = {
  path: "/vault/github.com/acme/app/issues/42/issue.md",
  body: "",
  frontMatter: {
    kind: "issue",
    host: "github.com",
    owner: "acme",
    repo: "app",
    number: 42,
    title: "Fix prefetch",
    state: "open",
    author: "mona",
    labels: [],
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    local: { favorite: false },
    sync: { status: "synced" }
  }
};

const thread: ItemThread = {
  state: "open",
  draft: false,
  labels: [{ name: "bug", color: "b60205" }],
  comments: [
    {
      id: "1001",
      author: "mona",
      created_at: "2026-07-03T00:00:00Z",
      body: "Prefetched comment"
    }
  ]
};

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

interface HarnessProps {
  visibleItems: ItemDocument[];
  selectedPath?: string | null;
  maxConcurrentPrefetches?: number;
  onBodyPrefetched?: (path: string, body: string) => void;
  onBodyInvalidated?: (path: string) => void;
  onStats?: (stats: VisibleItemPrefetchStats) => void;
}

function Harness({
  visibleItems,
  selectedPath = null,
  maxConcurrentPrefetches,
  onBodyPrefetched = vi.fn(),
  onBodyInvalidated = vi.fn(),
  onStats
}: HarnessProps) {
  const stats = useVisibleItemPrefetch({
    visibleItems,
    selectedPath,
    vaultRoot,
    connection,
    online: true,
    enabled: true,
    loadedBodies: {},
    refreshKey: 0,
    maxConcurrentPrefetches,
    onBodyPrefetched,
    onBodyInvalidated
  });
  useEffect(() => {
    onStats?.(stats);
  }, [onStats, stats]);
  return null;
}

describe("useVisibleItemPrefetch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(loadItemDocumentBody).mockResolvedValue("Loaded body");
    vi.mocked(fetchItemThread).mockResolvedValue(thread);
    vi.mocked(persistItemDocument).mockResolvedValue(undefined);
    vi.mocked(persistCommentDocuments).mockResolvedValue({
      checked: 1,
      written: 1,
      skipped: 0
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("prefetches body and comments only after a visible item dwells for one second", async () => {
    const onBodyPrefetched = vi.fn();
    render(
      <Harness visibleItems={[baseItem]} onBodyPrefetched={onBodyPrefetched} />
    );

    await vi.advanceTimersByTimeAsync(999);

    expect(loadItemDocumentBody).not.toHaveBeenCalled();
    expect(fetchItemThread).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();

    expect(fetchItemThread).toHaveBeenCalledTimes(1);
    expect(onBodyPrefetched).toHaveBeenCalledWith(baseItem.path, "Loaded body");
    expect(warmMarkdownBodies).toHaveBeenCalledWith([
      "Loaded body",
      "Prefetched comment"
    ]);
    expect(persistItemDocument).toHaveBeenCalledWith(
      vaultRoot,
      expect.objectContaining({
        body: "Loaded body",
        frontMatter: expect.objectContaining({
          state: "open",
          labels: ["bug"],
          label_colors: { bug: "b60205" },
          comments_count: 1
        })
      })
    );
    expect(persistCommentDocuments).toHaveBeenCalledWith(vaultRoot, [
      expect.objectContaining({
        body: "Prefetched comment",
        frontMatter: expect.objectContaining({
          author: "mona",
          remote_id: 1001,
          sync: { status: "synced" }
        })
      })
    ]);
  });

  it("cancels the dwell timer when an item scrolls out before one second", async () => {
    const { rerender } = render(<Harness visibleItems={[baseItem]} />);

    await vi.advanceTimersByTimeAsync(500);
    rerender(<Harness visibleItems={[]} />);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(loadItemDocumentBody).not.toHaveBeenCalled();
    expect(fetchItemThread).not.toHaveBeenCalled();
  });

  it("evicts prefetched body and thread cache ten minutes after the item leaves view", async () => {
    const onBodyInvalidated = vi.fn();
    const { rerender } = render(
      <Harness
        visibleItems={[baseItem]}
        onBodyInvalidated={onBodyInvalidated}
      />
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(fetchItemThread).toHaveBeenCalledTimes(1);

    rerender(
      <Harness visibleItems={[]} onBodyInvalidated={onBodyInvalidated} />
    );
    await vi.advanceTimersByTimeAsync(599_999);

    expect(deleteCachedItemThread).not.toHaveBeenCalled();
    expect(onBodyInvalidated).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(deleteCachedItemThread).toHaveBeenCalledWith(
      connection,
      {
        kind: "issue",
        owner: "acme",
        repo: "app",
        number: 42
      },
      "2026-07-02T00:00:00Z|refresh:0"
    );
    expect(onBodyInvalidated).toHaveBeenCalledWith(baseItem.path);
  });

  it("keeps the cache for the currently selected item even after it leaves the visible list", async () => {
    const onBodyInvalidated = vi.fn();
    const { rerender } = render(
      <Harness
        visibleItems={[baseItem]}
        selectedPath={baseItem.path}
        onBodyInvalidated={onBodyInvalidated}
      />
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(fetchItemThread).toHaveBeenCalledTimes(1);

    rerender(
      <Harness
        visibleItems={[]}
        selectedPath={baseItem.path}
        onBodyInvalidated={onBodyInvalidated}
      />
    );
    await vi.advanceTimersByTimeAsync(600_000);

    expect(deleteCachedItemThread).not.toHaveBeenCalled();
    expect(onBodyInvalidated).not.toHaveBeenCalled();
  });

  it("limits concurrent prefetch work and drains the queue as requests finish", async () => {
    const items = Array.from({ length: 5 }, (_, index) => ({
      ...baseItem,
      path: `/vault/github.com/acme/app/issues/${index + 1}/issue.md`,
      frontMatter: {
        ...baseItem.frontMatter,
        number: index + 1,
        updated_at: `2026-07-0${index + 1}T00:00:00Z`
      }
    }));
    const resolvers: Array<(value: ItemThread) => void> = [];
    vi.mocked(fetchItemThread).mockImplementation(
      () =>
        new Promise<ItemThread>((resolve) => {
          resolvers.push(resolve);
        })
    );

    render(<Harness visibleItems={items} maxConcurrentPrefetches={3} />);

    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(fetchItemThread).toHaveBeenCalledTimes(3);

    resolvers.shift()?.(thread);
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();
    await flushPromises();

    expect(fetchItemThread).toHaveBeenCalledTimes(4);
  });

  it("starts enough visible rows to cover lower viewport clicks with the default concurrency", async () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      ...baseItem,
      path: `/vault/github.com/acme/app/issues/${index + 1}/issue.md`,
      frontMatter: {
        ...baseItem.frontMatter,
        number: index + 1,
        updated_at: `2026-07-0${index + 1}T00:00:00Z`
      }
    }));
    vi.mocked(fetchItemThread).mockImplementation(
      () => new Promise<ItemThread>(() => undefined)
    );

    render(<Harness visibleItems={items} />);

    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(fetchItemThread).toHaveBeenCalledTimes(10);
  });

  it("continues publishing stats after React StrictMode replays effects", async () => {
    const onStats = vi.fn();

    render(
      <StrictMode>
        <Harness visibleItems={[baseItem]} onStats={onStats} />
      </StrictMode>
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(onStats).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        visible: 1,
        completed: 1
      })
    );
  });
});
