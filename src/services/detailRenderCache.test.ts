import { beforeEach, describe, expect, it } from "vitest";
import {
  clearDetailRenderSnapshots,
  captureDetailRenderSnapshotHtml,
  getDetailRenderSnapshot,
  getDetailRenderSnapshotStats,
  setDetailRenderSnapshot
} from "./detailRenderCache";

describe("detailRenderCache", () => {
  beforeEach(() => {
    clearDetailRenderSnapshots();
  });

  it("stores rendered detail HTML including resolved image sources", () => {
    setDetailRenderSnapshot("item:1", {
      html: '<article><p>Body</p><img src="data:image/png;base64,abc"></article>',
      capturedAt: "2026-07-09T00:00:00.000Z"
    });

    expect(getDetailRenderSnapshot("item:1")).toEqual({
      key: "item:1",
      html: '<article><p>Body</p><img src="data:image/png;base64,abc"></article>',
      capturedAt: "2026-07-09T00:00:00.000Z"
    });
  });

  it("keeps at most fifty snapshots and evicts the least recently used one", () => {
    for (let index = 1; index <= 50; index += 1) {
      setDetailRenderSnapshot(`item:${index}`, {
        html: `<article>${index}</article>`,
        capturedAt: `2026-07-09T00:00:${String(index).padStart(2, "0")}.000Z`
      });
    }
    // Touch item:1 so item:2 becomes the least recently used entry.
    expect(getDetailRenderSnapshot("item:1")?.html).toBe("<article>1</article>");

    setDetailRenderSnapshot("item:51", {
      html: "<article>51</article>",
      capturedAt: "2026-07-09T00:00:51.000Z"
    });

    expect(getDetailRenderSnapshotStats().entries).toBe(50);
    expect(getDetailRenderSnapshot("item:1")).not.toBeNull();
    expect(getDetailRenderSnapshot("item:2")).toBeNull();
    expect(getDetailRenderSnapshot("item:51")).not.toBeNull();
  });

  it("captures the rendered DOM while stripping an existing snapshot overlay", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div data-detail-render-snapshot-overlay="true">stale overlay</div>
      <article><p>Fresh body</p><img src="data:image/png;base64,fresh"></article>
    `;

    expect(captureDetailRenderSnapshotHtml(root)).toBe(
      '<article><p>Fresh body</p><img src="data:image/png;base64,fresh"></article>'
    );
  });
});
