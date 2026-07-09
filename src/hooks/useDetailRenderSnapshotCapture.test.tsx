import { render } from "@testing-library/react";
import { StrictMode, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureDetailRenderSnapshotHtml,
  setDetailRenderSnapshot
} from "../services/detailRenderCache";
import { useDetailRenderSnapshotCapture } from "./useDetailRenderSnapshotCapture";

vi.mock("../services/detailRenderCache", () => ({
  captureDetailRenderSnapshotHtml: vi.fn(() => "<p>snapshot</p>"),
  setDetailRenderSnapshot: vi.fn()
}));

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function Harness({
  detailKey = "item:1",
  enabled = true
}: {
  detailKey?: string | null;
  enabled?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useDetailRenderSnapshotCapture({ rootRef, detailKey, enabled });
  return (
    <div ref={rootRef}>
      <p>content</p>
    </div>
  );
}

describe("useDetailRenderSnapshotCapture", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(captureDetailRenderSnapshotHtml).mockReset();
    vi.mocked(captureDetailRenderSnapshotHtml).mockReturnValue("<p>snapshot</p>");
    vi.mocked(setDetailRenderSnapshot).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("captures once after the debounce delay, not immediately", async () => {
    render(<Harness />);
    await flushPromises();
    expect(setDetailRenderSnapshot).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(149);
    expect(setDetailRenderSnapshot).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(setDetailRenderSnapshot).toHaveBeenCalledTimes(1);
    expect(setDetailRenderSnapshot).toHaveBeenCalledWith("item:1", {
      html: "<p>snapshot</p>",
      capturedAt: expect.any(String)
    });
  });

  it("coalesces a mutation burst into a single capture", async () => {
    const { container } = render(<Harness />);
    const root = container.firstChild as HTMLElement;

    // Initial capture lands after the trailing window elapses.
    await vi.advanceTimersByTimeAsync(150);
    await flushPromises();
    expect(setDetailRenderSnapshot).toHaveBeenCalledTimes(1);

    // Five rapid mutations, each re-arming the trailing timer. Interleave
    // flushPromises so jsdom delivers each MutationObserver callback.
    for (let index = 0; index < 5; index += 1) {
      root.appendChild(document.createElement("span"));
      await flushPromises();
    }
    // No capture happened mid-burst: the trailing timer never elapsed.
    expect(setDetailRenderSnapshot).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(150);
    await flushPromises();
    expect(setDetailRenderSnapshot).toHaveBeenCalledTimes(2);
  });

  it("cancels the pending capture on unmount", async () => {
    const { container, unmount } = render(<Harness />);
    const root = container.firstChild as HTMLElement;

    root.appendChild(document.createElement("span"));
    await flushPromises();
    unmount();

    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(setDetailRenderSnapshot).not.toHaveBeenCalled();
  });

  it("switching keys drops the old key's pending capture", async () => {
    const { container, rerender } = render(<Harness detailKey="A" />);
    const root = container.firstChild as HTMLElement;

    root.appendChild(document.createElement("span"));
    await flushPromises();

    // Switch keys before the debounce for A elapses.
    rerender(<Harness detailKey="B" />);
    await vi.advanceTimersByTimeAsync(150);
    await flushPromises();

    const calls = vi.mocked(setDetailRenderSnapshot).mock.calls;
    expect(calls.some(([key]) => key === "A")).toBe(false);
    expect(calls.some(([key]) => key === "B")).toBe(true);
  });

  it("does nothing while disabled", async () => {
    render(<Harness enabled={false} />);
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();

    expect(captureDetailRenderSnapshotHtml).not.toHaveBeenCalled();
    expect(setDetailRenderSnapshot).not.toHaveBeenCalled();
  });

  it("skips empty captures", async () => {
    vi.mocked(captureDetailRenderSnapshotHtml).mockReturnValue("");
    render(<Harness />);
    await vi.advanceTimersByTimeAsync(150);
    await flushPromises();

    expect(captureDetailRenderSnapshotHtml).toHaveBeenCalled();
    expect(setDetailRenderSnapshot).not.toHaveBeenCalled();
  });

  it("captures once under React StrictMode double-invoked effects", async () => {
    render(
      <StrictMode>
        <Harness />
      </StrictMode>
    );
    await vi.advanceTimersByTimeAsync(150);
    await flushPromises();

    expect(setDetailRenderSnapshot).toHaveBeenCalledTimes(1);
  });
});
