import { describe, expect, it } from "vitest";
import type { NotesHistoryContext } from "../../domain/notes";
import {
  hasMoveDependencies,
  historyArguments
} from "./notesWorkspaceCommandSupport";
import { normalizeWorkspace } from "./notesWorkspaceReducer";

describe("notesWorkspaceCommandSupport", () => {
  it("requires history ownership for every user mutation", () => {
    const context = {
      sessionId: "session-a",
      historyEpoch: "epoch-a",
      entryId: "entry-a",
      commandKind: "move"
    } satisfies NotesHistoryContext;

    expect(historyArguments(context)).toEqual([context]);
    expect(() => historyArguments(null)).toThrow(
      "A Notes user mutation requires a history context."
    );
  });

  it("accepts a move only when all referenced nodes exist", () => {
    const workspace = normalizeWorkspace({
      nodes: [
        {
          id: "source",
          nodeKind: "text",
          markerKind: "bullet",
          parentId: null,
          sortKey: 1024,
          title: "Source",
          note: "",
          layoutMode: "bullets",
          isCollapsed: false,
          isStarred: false,
          completedAt: null,
          createdAt: "2026-07-19T00:00:00Z",
          updatedAt: "2026-07-19T00:00:00Z",
          deletedAt: null,
          archivedAt: null,
          archiveRootId: null,
          imageOffsetUtf16: 0
        }
      ]
    });

    expect(
      hasMoveDependencies(workspace, {
        id: "source",
        parentId: null,
        afterId: null
      })
    ).toBe(true);
    expect(
      hasMoveDependencies(workspace, {
        id: "missing",
        parentId: null,
        afterId: null
      })
    ).toBe(false);
  });
});
