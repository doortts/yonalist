import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import type { NotesApi } from "./api";
import { App } from "./App";

const markdownSnapshot: BootSnapshot = {
  sessionId: "markdown-session",
  revision: 1,
  activePageId: "page-1",
  pages: [{ id: "page-1", title: "Today" }],
  viewport: {
    pageId: "page-1",
    anchorId: null,
    beforeCursor: null,
    afterCursor: null,
    nodes: [{
      id: "bullet-1",
      parentId: "page-1",
      sortKey: 1024,
      kind: "bullet", image: null,
      text: "## **Launch** #Cafe\u0301",
      note: "",
      marker: "bullet",
      collapsed: false,
      completed: false,
      starred: false,
      deleted: false
    }]
  },
  history: { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 }
};

function markdownApi(): NotesApi {
  return {
    bootstrap: vi.fn().mockResolvedValue(markdownSnapshot),
    queryViewport: vi.fn(),
    queryForest: vi.fn().mockImplementation(async (request) => ({
      revision: markdownSnapshot.revision,
      nodes: markdownSnapshot.viewport?.nodes.filter((node) =>
        request.rootIds.includes(node.id)) ?? [],
      complete: true
    })),
    execute: vi.fn(),
    importImageBytes: vi.fn(),
    importImagePaths: vi.fn(),
    readImage: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    search: vi.fn().mockResolvedValue({ hits: [], nextCursor: null }),
    closeSession: vi.fn()
  };
}

describe("outline resting presentation integration", () => {
  it("uses the existing row geometry and sends a clicked tag to indexed search", async () => {
    const notesApi = markdownApi();
    const { container } = render(<App api={notesApi} />);

    const tag = await screen.findByRole("button", {
      name: "#Cafe\u0301 tag filter is inactive"
    });
    const field = container.querySelector(".notes-node-title-field");
    expect(field).toHaveAttribute("data-markdown-block", "heading");
    expect(field).toHaveAttribute("data-markdown-level", "2");
    expect(field?.querySelector(".notes-markdown-strong")).toHaveTextContent(
      "Launch"
    );

    fireEvent.click(tag);

    await waitFor(() => {
      expect(notesApi.search).toHaveBeenCalledWith({
        text: "tag:#café",
        cursor: null,
        limit: 30
      });
    }, { timeout: 1_000 });
  });
});
