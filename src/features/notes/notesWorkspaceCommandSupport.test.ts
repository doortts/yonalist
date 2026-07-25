import { describe, expect, it, vi } from "vitest";
import type {
  NotesHistoryContext,
  NotesMutationResult,
  NotesStore
} from "../../domain/notes";
import type { NotesHistorySession } from "./notesHistory";
import {
  bindCommittedMutationReloadRecovery,
  hasMoveDependencies,
  historyArguments,
  runCompoundQueueWork,
  takeCommittedMutationReloadRecovery,
  unwrapNotesMutationForContext
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
          imageOffsetUtf16: 0,
          markdownImageWidth: null
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

  const committedContext = (
    overrides: Partial<NotesHistoryContext> = {}
  ): NotesHistoryContext => ({
    sessionId: "session-a",
    historyEpoch: "epoch-a",
    entryId: "entry-a",
    commandKind: "restore",
    ...overrides
  });

  const compactMutation = (
    context: NotesHistoryContext
  ): NotesMutationResult => ({
    historyEntryId: context.entryId,
    canUndo: true,
    canRedo: false,
    historyEpoch: context.historyEpoch,
    nextUndoEntryId: context.entryId,
    nextRedoEntryId: null,
    prunedEntryIds: [],
    changedNodes: [],
    removedNodeIds: ["deleted"],
    changedAttachments: []
  });

  async function committedReloadFailure(
    context: NotesHistoryContext
  ): Promise<unknown> {
    try {
      await unwrapNotesMutationForContext(
        {
          repository: {
            loadWorkspace: vi
              .fn()
              .mockRejectedValue(new Error("reload failed"))
          } as unknown as NotesStore,
          vaultRoot: "/vault",
          confirmedWorkspace: { nodes: [] },
          sourceScope: { kind: "trash" },
          history: {
            sessionId: context.sessionId,
            historyEpoch: context.historyEpoch
          } as NotesHistorySession
        },
        compactMutation(context)
      );
    } catch (cause) {
      return cause;
    }
    throw new Error("Expected the committed Active reload to fail.");
  }

  it("binds a committed reload receipt once to the exact attempt", async () => {
    const context = committedContext();
    const cause = await committedReloadFailure(context);

    expect(bindCommittedMutationReloadRecovery(cause, context)).toBe(true);
    expect(takeCommittedMutationReloadRecovery(cause)).toEqual({
      historyContext: context,
      historyStatus: expect.objectContaining({
        historyEpoch: context.historyEpoch,
        nextUndoEntryId: context.entryId
      })
    });
    expect(takeCommittedMutationReloadRecovery(cause)).toBeNull();
    expect(bindCommittedMutationReloadRecovery(cause, context)).toBe(false);
  });

  it.each([
    ["entry", { entryId: "entry-b" }],
    ["session", { sessionId: "session-b" }],
    ["epoch", { historyEpoch: "epoch-b" }]
  ] as const)(
    "does not bind a committed reload receipt to a mismatched %s",
    async (_field, overrides) => {
      const context = committedContext();
      const cause = await committedReloadFailure(context);

      expect(
        bindCommittedMutationReloadRecovery(
          cause,
          committedContext(overrides)
        )
      ).toBe(false);
      expect(takeCommittedMutationReloadRecovery(cause)).toBeNull();
      expect(bindCommittedMutationReloadRecovery(cause, context)).toBe(true);
    }
  );

  it("ignores unrelated and consumed errors in later attempts", async () => {
    const firstContext = committedContext();
    const firstCause = await committedReloadFailure(firstContext);
    const secondContext = committedContext({
      entryId: "entry-b",
      commandKind: "restore-later"
    });
    const secondCause = await committedReloadFailure(secondContext);

    expect(
      bindCommittedMutationReloadRecovery(new Error("forged"), firstContext)
    ).toBe(false);
    expect(takeCommittedMutationReloadRecovery(new Error("forged"))).toBeNull();
    expect(bindCommittedMutationReloadRecovery(firstCause, firstContext)).toBe(
      true
    );
    expect(takeCommittedMutationReloadRecovery(firstCause)).not.toBeNull();
    expect(
      bindCommittedMutationReloadRecovery(firstCause, secondContext)
    ).toBe(false);
    expect(takeCommittedMutationReloadRecovery(firstCause)).toBeNull();
    expect(
      bindCommittedMutationReloadRecovery(secondCause, secondContext)
    ).toBe(true);
    expect(takeCommittedMutationReloadRecovery(secondCause)).toMatchObject({
      historyContext: secondContext
    });
  });

  it("never emits non-atomic compatibility proof for an atomic receipt", async () => {
    const emptyWorkspace = { nodes: [] };
    const result = await runCompoundQueueWork(
      {
        repository: {} as NotesStore,
        vaultRoot: "/vault",
        confirmedWorkspace: emptyWorkspace,
        sourceScope: { kind: "active" },
        history: { historyEpoch: "epoch-a" } as NotesHistorySession
      },
      [
        {
          historyEntryId: "entry-a",
          run: async () => ({
            workspace: emptyWorkspace,
            historyEntryId: "entry-a",
            canUndo: true,
            canRedo: false,
            historyEpoch: "epoch-a",
            nextUndoEntryId: "entry-a",
            nextRedoEntryId: null,
            prunedEntryIds: []
          })
        }
      ]
    );

    expect(result.kind).toBe("authoritative");
    expect(result).not.toHaveProperty("nonAtomicHistoryEntryIds");
  });
});
