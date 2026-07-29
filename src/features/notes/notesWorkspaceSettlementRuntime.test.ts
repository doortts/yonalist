import { describe, expect, it } from "vitest";
import type { OptimisticKeyboardInsertion } from "./notesLocalStructure";
import {
  confirmedOptimisticTitleUpdates,
  confirmedOptimisticTitleUpdatesFromNodesById,
  recordPendingOptimisticTitles,
  routeKeyboardInsertionSettlement,
  settledLocalExpansions,
} from "./notesWorkspaceSettlementRuntime";

function insertion(): OptimisticKeyboardInsertion {
  const historyContext = {
    sessionId: "session",
    historyEpoch: "epoch",
    entryId: "entry",
    commandKind: "splitNode" as const,
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
          expectedInsertedTitle: "",
        },
      },
      ownerSessionId: "frontend",
      ownerPaneId: "primary",
      expectedStructuralHistoryEpoch: "epoch",
      expectedStructuralHistoryEntryId: "entry",
    },
    historyContext,
    dependencyId: null,
    sourceSelection: { anchorUtf16: 4, focusUtf16: 4 },
    sourceTitle: "Root",
    insertedTitle: "failed live text",
    createdAt: "2026-07-29T00:00:00.000Z",
    status: "checking",
    undoRequested: false,
  };
}

describe("notes workspace settlement runtime", () => {
  it("does not restore a provisional title consumed by a dependent split removed in the same batch", () => {
    const first = {
      ...insertion(),
      insertedTitle: "beta",
      pending: {
        ...insertion().pending,
        intent: {
          ...insertion().pending.intent,
          expectedNodeId: "split-1",
        },
      },
    };
    const second = {
      ...insertion(),
      dependencyId: "split-1",
      insertedTitle: "",
      pending: {
        ...insertion().pending,
        intent: {
          ...insertion().pending.intent,
          sourceId: "split-1",
          expectedNodeId: "split-2",
        },
      },
    };
    const pending = new Map<string, string>();

    recordPendingOptimisticTitles(
      { insertions: [first, second], failure: null },
      {
        type: "optimisticInsertion",
        snapshot: { insertions: [], failure: null },
      },
      pending,
    );

    expect(pending.size).toBe(0);
  });

  it("reads a settled focus title from the mutation delta before scanning the workspace", () => {
    const split = {
      id: "split",
      nodeKind: "text" as const,
      parentId: null,
      sortKey: 1024,
      title: "focused",
      note: "",
      layoutMode: "bullets" as const,
      markerKind: "bullet" as const,
      isCollapsed: false,
      isStarred: false,
      completedAt: null,
      createdAt: "2026-07-29T00:00:00Z",
      updatedAt: "2026-07-29T00:00:00Z",
      deletedAt: null,
      archivedAt: null,
      archiveRootId: null,
      imageOffsetUtf16: 0,
      markdownImageWidth: null,
    };
    const nodes = new Proxy([], {
      get() {
        throw new Error("full workspace scan");
      },
    });

    expect(
      routeKeyboardInsertionSettlement(
        {
          kind: "authoritative",
          workspace: { nodes },
          delta: {
            changedNodes: [split],
            removedNodeIds: [],
            changedAttachments: [],
          },
          uiUpdate: { pendingFocusId: "split" },
          projectionPublication: {
            targetPaneId: "primary",
            expectedNavigationVersion: 0,
          },
        },
        0,
        0,
        0,
      ).focusRequest?.titleLength,
    ).toBe(7);
  });

  it("flushes live provisional text after the authoritative row is already settled", () => {
    const pending = new Map([["split", "live text"]]);
    const split = {
      id: "split",
      nodeKind: "text" as const,
      parentId: null,
      sortKey: 1024,
      title: "",
      note: "",
      layoutMode: "bullets" as const,
      markerKind: "bullet" as const,
      isCollapsed: false,
      isStarred: false,
      completedAt: null,
      createdAt: "2026-07-29T00:00:00Z",
      updatedAt: "2026-07-29T00:00:00Z",
      deletedAt: null,
      archivedAt: null,
      archiveRootId: null,
      imageOffsetUtf16: 0,
      markdownImageWidth: null,
    };

    expect(
      confirmedOptimisticTitleUpdatesFromNodesById({ split }, pending),
    ).toEqual([
      {
        nodeId: "split",
        title: "live text",
        note: "",
        imageOffsetUtf16: 0,
      },
    ]);
    expect(pending.size).toBe(0);
  });

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
            retryable: false,
          },
        },
      },
      pending,
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
                markdownImageWidth: null,
              },
            ],
          },
        },
        pending,
      ),
    ).toEqual([]);
  });

  it("routes a first-child expansion only to the insertion pane", () => {
    const primary = new Set(["primary"]);
    const secondary = new Set(["secondary"]);
    const expanded = new Set(["secondary", "root"]);
    const result = {
      kind: "authoritative" as const,
      workspace: { nodes: [] },
      projectionPublication: {
        targetPaneId: "secondary",
        locallyExpandedNodeIds: expanded,
      },
    };

    expect(settledLocalExpansions(primary, result, "primary")).toBe(primary);
    expect(settledLocalExpansions(secondary, result, "secondary")).toBe(
      expanded,
    );
  });
});
