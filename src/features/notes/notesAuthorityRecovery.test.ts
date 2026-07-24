import { describe, expect, it } from "vitest";
import {
  normalizeNotesWorkspace,
  type NoteNode,
  type NotesHistoryContext,
  type NotesHistoryStatus,
  type NormalizedNotesWorkspace
} from "../../domain/notes";
import {
  recoverUnknownOutcome,
  type NotesUnknownOutcomeExpectation
} from "./notesAuthorityRecovery";

function node(overrides: Partial<NoteNode> & Pick<NoteNode, "id">): NoteNode {
  return {
    nodeKind: "text",
    markerKind: "bullet",
    parentId: null,
    sortKey: 1024,
    title: overrides.id,
    note: "",
    imageOffsetUtf16: 0,
    markdownImageWidth: null,
    layoutMode: "bullets",
    isCollapsed: false,
    isStarred: false,
    completedAt: null,
    createdAt: "2026-07-24T00:00:00Z",
    updatedAt: "2026-07-24T00:00:00Z",
    deletedAt: null,
    archivedAt: null,
    archiveRootId: null,
    ...overrides
  };
}

function workspace(nodes: NoteNode[]): NormalizedNotesWorkspace {
  const normalized = normalizeNotesWorkspace({ nodes });
  if (!normalized) throw new Error("Invalid recovery fixture.");
  return normalized;
}

function historyContext(
  entryId = "entry-enter",
  historyEpoch = "epoch-a"
): NotesHistoryContext {
  return {
    sessionId: "session-a",
    historyEpoch,
    entryId,
    commandKind: "split"
  };
}

function historyStatus(
  nextUndoEntryId: string | null = "entry-enter",
  historyEpoch = "epoch-a"
): NotesHistoryStatus {
  return {
    canUndo: nextUndoEntryId !== null,
    canRedo: false,
    historyEpoch,
    nextUndoEntryId,
    nextRedoEntryId: null,
    prunedEntryIds: []
  };
}

function splitExpectation(): NotesUnknownOutcomeExpectation {
  return {
    kind: "structural",
    sourceId: "source",
    expectedNodeId: "inserted",
    postcondition: {
      kind: "split",
      expectedSourceTitle: "pre",
      expectedInsertedTitle: "fix"
    },
    historyContext: historyContext()
  };
}

describe("recoverUnknownOutcome", () => {
  it("classifies a current split with matching origin history as committedAndCurrent", () => {
    const acceptedWorkspace = workspace([
      node({ id: "source", sortKey: 1024, title: "pre" }),
      node({ id: "inserted", sortKey: 2048, title: "fix" })
    ]);
    const acceptedHistory = historyStatus();

    expect(
      recoverUnknownOutcome({
        expectation: splitExpectation(),
        authority: {
          kind: "loaded",
          workspace: acceptedWorkspace,
          historyStatus: acceptedHistory
        }
      })
    ).toEqual({
      kind: "committedAndCurrent",
      workspace: acceptedWorkspace,
      historyStatus: acceptedHistory
    });
  });

  it("classifies a current first child without matching history proof separately", () => {
    const expectation: NotesUnknownOutcomeExpectation = {
      kind: "structural",
      sourceId: "parent",
      expectedNodeId: "inserted",
      postcondition: {
        kind: "first-child",
        expectedParentId: "parent",
        expectedIndex: 0,
        expectedInsertedTitle: ""
      },
      historyContext: historyContext()
    };
    const acceptedWorkspace = workspace([
      node({ id: "parent" }),
      node({
        id: "inserted",
        parentId: "parent",
        sortKey: 1024,
        title: ""
      }),
      node({ id: "old-child", parentId: "parent", sortKey: 2048 })
    ]);
    const mismatchedHistory = historyStatus("another-entry");

    expect(
      recoverUnknownOutcome({
        expectation,
        authority: {
          kind: "loaded",
          workspace: acceptedWorkspace,
          historyStatus: mismatchedHistory
        }
      })
    ).toEqual({
      kind: "committedWithoutHistoryProof",
      workspace: acceptedWorkspace,
      historyStatus: mismatchedHistory
    });
  });

  it("does not infer a commit when the structural postcondition is absent", () => {
    const acceptedWorkspace = workspace([
      node({ id: "source", title: "prefix" })
    ]);
    const acceptedHistory = historyStatus();

    expect(
      recoverUnknownOutcome({
        expectation: splitExpectation(),
        authority: {
          kind: "loaded",
          workspace: acceptedWorkspace,
          historyStatus: acceptedHistory
        }
      })
    ).toEqual({
      kind: "notProvenCommitted",
      workspace: acceptedWorkspace,
      historyStatus: acceptedHistory
    });
  });

  it("requires both persisted draft text and its text-history context", () => {
    const expectation: NotesUnknownOutcomeExpectation = {
      kind: "draft",
      nodeId: "source",
      expectedText: {
        title: "edited",
        note: "body",
        imageOffsetUtf16: 0,
        markerKind: "todo",
        markdownImageWidth: 480
      },
      historyContext: {
        ...historyContext("entry-text"),
        commandKind: "text"
      }
    };
    const acceptedWorkspace = workspace([
      node({
        id: "source",
        title: "edited",
        note: "body",
        imageOffsetUtf16: 0,
        markerKind: "todo",
        markdownImageWidth: 480
      })
    ]);
    const acceptedHistory = historyStatus("entry-text");

    expect(
      recoverUnknownOutcome({
        expectation,
        authority: {
          kind: "loaded",
          workspace: acceptedWorkspace,
          historyStatus: acceptedHistory
        }
      })
    ).toEqual({
      kind: "committedAndCurrent",
      workspace: acceptedWorkspace,
      historyStatus: acceptedHistory
    });

    expect(
      recoverUnknownOutcome({
        expectation,
        authority: {
          kind: "loaded",
          workspace: workspace([
            node({
              id: "source",
              title: "edited",
              note: "stale body",
              imageOffsetUtf16: 0,
              markerKind: "todo",
              markdownImageWidth: 480
            })
          ]),
          historyStatus: acceptedHistory
        }
      }).kind
    ).toBe("notProvenCommitted");
  });

  it("classifies a failed authoritative reload as authorityUnknown", () => {
    expect(
      recoverUnknownOutcome({
        expectation: splitExpectation(),
        authority: {
          kind: "failed",
          error: new Error("reload failed")
        }
      })
    ).toEqual({
      kind: "authorityUnknown",
      error: "reload failed"
    });
  });
});
