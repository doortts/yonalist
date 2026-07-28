import { describe, expect, it } from "vitest";
import { normalizeWorkspace } from "./notesWorkspaceReducer";
import { currentNotesNavigation } from "./notesWorkspaceNavigationSupport";

describe("currentNotesNavigation", () => {
  it("overlays the active editing focus without changing settled zoom navigation", () => {
    const state = {
      ...normalizeWorkspace({ nodes: [] }),
      selectedId: "settled-selection",
      zoomRootId: "zoom-root",
      editingNoteId: "settled-editor",
      pendingFocusId: "settled-focus",
      pendingFocusField: "note" as const
    };

    expect(
      currentNotesNavigation(state, {
        nodeId: "direct-editor",
        field: "title"
      })
    ).toEqual({
      selectedId: "direct-editor",
      zoomRootId: "zoom-root",
      editingNoteId: "direct-editor",
      pendingFocusId: "settled-focus",
      pendingFocusField: "title"
    });
  });

  it("uses settled navigation when no direct editing focus owns the caret", () => {
    const state = {
      ...normalizeWorkspace({ nodes: [] }),
      selectedId: "settled-selection",
      zoomRootId: "zoom-root",
      editingNoteId: "settled-editor",
      pendingFocusId: "settled-focus",
      pendingFocusField: "note" as const
    };

    expect(currentNotesNavigation(state, null)).toEqual({
      selectedId: "settled-selection",
      zoomRootId: "zoom-root",
      editingNoteId: "settled-editor",
      pendingFocusId: "settled-focus",
      pendingFocusField: "note"
    });
  });
});
