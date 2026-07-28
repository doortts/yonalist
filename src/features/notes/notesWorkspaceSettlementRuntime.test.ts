import { describe, expect, it } from "vitest";
import type { OptimisticKeyboardInsertion } from "./notesLocalStructure";
import {
  confirmedOptimisticTitleUpdates,
  recordPendingOptimisticTitles
} from "./notesWorkspaceSettlementRuntime";

function insertion(): OptimisticKeyboardInsertion {
  const historyContext = {
    sessionId: "session",
    historyEpoch: "epoch",
    entryId: "entry",
    commandKind: "splitNode" as const
  };
  return {
    pending: {
      intent: {
        token: 1,
        ownerSessionGeneration: 1,
        sourceId: "root",
        expectedNodeId: "split",
        postcondition: {
          kind: "split",
          expectedSourceTitle: "Root",
          expectedInsertedTitle: ""
        }
      },
      ownerSessionId: "frontend",
      ownerPaneId: "primary",
      expectedStructuralHistoryEpoch: "epoch",
      expectedStructuralHistoryEntryId: "entry"
    },
    historyContext,
    dependencyId: null,
    sourceSelection: { anchorUtf16: 4, focusUtf16: 4 },
    sourceTitle: "Root",
    insertedTitle: "failed live text",
    status: "checking",
    undoRequested: false
  };
}

describe("notes workspace settlement runtime", () => {
  it("does not overwrite a later valid save with text from a failed insertion", () => {
    const failed = insertion();
    const pending = new Map<string, string>();

    recordPendingOptimisticTitles(
      { insertions: [failed], failure: null },
      {
        type: "optimisticInsertion",
        snapshot: {
          insertions: [],
          failure: {
            insertion: failed,
            message: "The insertion was reconciled.",
            recoveryText: "Root\nfailed live text",
            retryable: false
          }
        }
      },
      pending
    );

    expect(
      confirmedOptimisticTitleUpdates(
        {
          kind: "authoritative",
          workspace: {
            nodes: [
              {
                id: "split",
                nodeKind: "text",
                parentId: null,
                sortKey: 1024,
                title: "later valid save",
                note: "",
                layoutMode: "bullets",
                markerKind: "bullet",
                isCollapsed: false,
                isStarred: false,
                completedAt: null,
                createdAt: "2026-07-29T00:00:00Z",
                updatedAt: "2026-07-29T00:00:00Z",
                deletedAt: null,
                archivedAt: null,
                archiveRootId: null,
                imageOffsetUtf16: 0,
                markdownImageWidth: null
              }
            ]
          }
        },
        pending
      )
    ).toEqual([]);
  });
});
