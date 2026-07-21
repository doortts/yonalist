import { render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createNoteId } from "../../domain/notes";
import type { AssetIngestProgress } from "../../services/assetIngestProgress";
import { NotesImageIngestOverlay } from "./NotesImageIngestOverlay";
import {
  applyAssetIngestProgress,
  beginNodeIngest,
  resetNotesAssetIngestProgressStore
} from "./notesAssetIngestProgressStore";

const node = createNoteId();

function copying(bytesDone: number, bytesTotal: number): AssetIngestProgress {
  return { requestId: "r", phase: "copying", bytesDone, bytesTotal };
}

afterEach(() => {
  resetNotesAssetIngestProgressStore();
});

describe("NotesImageIngestOverlay", () => {
  it("renders nothing while idle", () => {
    const { container } = render(<NotesImageIngestOverlay nodeId={node} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the percent for the active single-file ingest", () => {
    render(<NotesImageIngestOverlay nodeId={node} />);
    act(() => {
      beginNodeIngest(node, 1);
      applyAssetIngestProgress(copying(30, 100));
    });
    const overlay = screen.getByRole("status");
    expect(overlay).toHaveTextContent("30%");
    expect(overlay).not.toHaveTextContent("file");
  });

  it("adds a file counter for a batch and clears when done", () => {
    render(<NotesImageIngestOverlay nodeId={node} />);
    act(() => {
      beginNodeIngest(node, 3);
      applyAssetIngestProgress(copying(10, 20));
    });
    expect(screen.getByRole("status")).toHaveTextContent("file 1/3");

    act(() => {
      applyAssetIngestProgress({
        requestId: "r",
        phase: "done",
        bytesDone: 0,
        bytesTotal: 0,
        contentHash: "a".repeat(64)
      });
    });
    expect(screen.getByRole("status")).toHaveTextContent("file 2/3");
  });
});
