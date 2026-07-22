import { afterEach, describe, expect, it } from "vitest";
import { createNoteId } from "../../domain/notes";
import type { AssetIngestProgress } from "../../services/assetIngestProgress";
import {
  applyAssetIngestProgress,
  beginNodeIngest,
  endNodeIngest,
  getNodeIngestOverlay,
  resetNotesAssetIngestProgressStore
} from "./notesAssetIngestProgressStore";

const node = createNoteId();

function progress(
  partial: Partial<AssetIngestProgress> & { phase: AssetIngestProgress["phase"] }
): AssetIngestProgress {
  return {
    requestId: "r",
    bytesDone: 0,
    bytesTotal: 0,
    ...partial
  };
}

afterEach(() => {
  resetNotesAssetIngestProgressStore();
});

describe("notesAssetIngestProgressStore", () => {
  it("is idle until an ingest begins", () => {
    expect(getNodeIngestOverlay(node)).toBeNull();
  });

  it("tracks a hashing→copying→done single-file sequence and clears at done", () => {
    beginNodeIngest(node, 1);
    expect(getNodeIngestOverlay(node)).toMatchObject({
      phase: "hashing",
      percent: 0,
      fileIndex: 1,
      fileCount: 1
    });

    applyAssetIngestProgress(
      progress({ phase: "copying", bytesDone: 25, bytesTotal: 100 })
    );
    expect(getNodeIngestOverlay(node)).toMatchObject({
      phase: "copying",
      percent: 25
    });

    applyAssetIngestProgress(
      progress({ phase: "copying", bytesDone: 100, bytesTotal: 100 })
    );
    expect(getNodeIngestOverlay(node)?.percent).toBe(100);

    applyAssetIngestProgress(
      progress({ phase: "done", contentHash: "a".repeat(64) })
    );
    expect(getNodeIngestOverlay(node)).toBeNull();
  });

  it("hides a dedup hit immediately (done with no copy)", () => {
    beginNodeIngest(node, 1);
    applyAssetIngestProgress(
      progress({ phase: "done", contentHash: "b".repeat(64) })
    );
    expect(getNodeIngestOverlay(node)).toBeNull();
  });

  it("advances the file counter across a batch before clearing", () => {
    beginNodeIngest(node, 2);
    applyAssetIngestProgress(
      progress({ phase: "done", contentHash: "c".repeat(64) })
    );
    expect(getNodeIngestOverlay(node)).toMatchObject({
      fileIndex: 2,
      fileCount: 2,
      phase: "hashing"
    });
    applyAssetIngestProgress(
      progress({ phase: "done", contentHash: "d".repeat(64) })
    );
    expect(getNodeIngestOverlay(node)).toBeNull();
  });

  it("ignores progress with no active ingest", () => {
    applyAssetIngestProgress(
      progress({ phase: "copying", bytesDone: 1, bytesTotal: 2 })
    );
    expect(getNodeIngestOverlay(node)).toBeNull();
  });

  it("endNodeIngest clears an in-flight overlay", () => {
    beginNodeIngest(node, 3);
    applyAssetIngestProgress(
      progress({ phase: "copying", bytesDone: 1, bytesTotal: 4 })
    );
    expect(getNodeIngestOverlay(node)).not.toBeNull();
    endNodeIngest(node);
    expect(getNodeIngestOverlay(node)).toBeNull();
  });
});
