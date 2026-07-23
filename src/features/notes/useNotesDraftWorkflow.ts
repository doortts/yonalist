import { useCallback } from "react";
import type { NoteId, NoteNode, NotesStore } from "../../domain/notes";
import { isNotesDataDeletionInProgress } from "./notesDataDeletionRegistry";
import type {
  DraftWriteAttempt,
  NotesDraftEngine
} from "./notesDraftEngine";
import type {
  NotesWorkspaceQueueContext,
  NotesWorkspaceQueueResult
} from "./notesWorkspaceCoordinator";
import { isStandaloneRemoteMarkdownImage } from "./noteMarkdown";
import type {
  NotesHistoryFocus,
  NotesHistoryFocusField
} from "./notesHistory";
import type { NotesImageAtomFlushAdapter } from "./notesImageAtomEditorRegistry";
import type { NotesCommandContext } from "./notesCommands";
import {
  unwrapNotesMutation,
  type UnwrappedNotesMutation
} from "./notesWorkspaceProjection";
import {
  confirmedState,
  directMutationResult,
  historyArguments,
  projectNotesMutation
} from "./notesWorkspaceCommandSupport";
import { errorMessage } from "./notesWorkspaceNavigationSupport";
import type { ProjectedNotesMutation } from "./notesWorkspaceTypes";
import type { NotesSelection } from "./notesWorkspaceReducer";
import type { NotesSelectionStateController } from "./useNotesSelectionController";

interface LiveRef<T> {
  current: T;
}

interface NotesDraftWorkflowDependencies {
  readonly repository: NotesStore;
  readonly vaultRoot: string;
  readonly activeScopeRef: NotesCommandContext["activeScopeRef"];
  readonly draftEngineRef: LiveRef<NotesDraftEngine | null>;
  readonly editingFocusRef: LiveRef<NotesHistoryFocus | null>;
  readonly navigationVersionRef: NotesCommandContext["navigationVersionRef"];
  readonly selectionRef: LiveRef<NotesSelection | null>;
  readonly updateSelection: NotesSelectionStateController["updateSelection"];
  readonly retirePendingPrimarySelection: () => void;
  readonly settleAtomicMutation: (
    context: DraftWriteAttempt["historyContext"],
    mutation: UnwrappedNotesMutation,
    projection: ProjectedNotesMutation,
    options?: { focus?: NotesHistoryFocus | null }
  ) => Promise<NotesWorkspaceQueueResult | null>;
}

export function useNotesDraftWorkflow({
  repository,
  vaultRoot,
  activeScopeRef,
  draftEngineRef,
  editingFocusRef,
  navigationVersionRef,
  selectionRef,
  updateSelection,
  retirePendingPrimarySelection,
  settleAtomicMutation
}: NotesDraftWorkflowDependencies) {
  const persistDraftMutation = useCallback(
    async (
      context: NotesWorkspaceQueueContext,
      attempt: DraftWriteAttempt
    ): Promise<NotesWorkspaceQueueResult> => {
      const { nodeId, draft, historyContext } = attempt;
      const confirmedNode = confirmedState(context).nodesById[nodeId];
      if (!confirmedNode) {
        return { kind: "skipped" };
      }
      try {
        const markdownImageWidth = isStandaloneRemoteMarkdownImage(draft.title)
          ? (draft.markdownImageWidth ?? confirmedNode.markdownImageWidth)
          : draft.markdownImageWidth !== undefined ||
              confirmedNode.markdownImageWidth !== null
            ? null
            : undefined;
        const mutation = unwrapNotesMutation(
          await context.repository.updateNode(
            context.vaultRoot,
            {
              id: nodeId,
              title: draft.title,
              note: draft.note,
              imageOffsetUtf16: draft.imageOffsetUtf16,
              ...(markdownImageWidth !== undefined
                ? { markdownImageWidth }
                : {}),
              markerKind: draft.markerKind ?? confirmedNode.markerKind
            },
            ...historyArguments(historyContext)
          )
        );
        const projection = await projectNotesMutation(
          context,
          mutation,
          activeScopeRef.current
        );
        const settlement = await settleAtomicMutation(
          historyContext,
          mutation,
          projection,
          { focus: attempt.focus }
        );
        if (settlement) return settlement;
        return directMutationResult(mutation, projection);
      } catch (cause) {
        return { kind: "failure", error: errorMessage(cause) };
      }
    },
    [activeScopeRef, settleAtomicMutation]
  );

  const markEditingFocus = useCallback(
    (nodeId: NoteId, field: NotesHistoryFocusField): void => {
      retirePendingPrimarySelection();
      navigationVersionRef.current += 1;
      editingFocusRef.current = { nodeId, field };
    },
    [editingFocusRef, navigationVersionRef, retirePendingPrimarySelection]
  );
  const setDraftEditingNavigation = useCallback(
    (nodeId: NoteId, field: NotesHistoryFocusField): void => {
      retirePendingPrimarySelection();
      const current = editingFocusRef.current;
      if (current?.nodeId === nodeId && current.field === field) return;
      navigationVersionRef.current += 1;
      editingFocusRef.current = { nodeId, field };
    },
    [editingFocusRef, navigationVersionRef, retirePendingPrimarySelection]
  );
  const getNavigationVersion = useCallback(
    (): number => navigationVersionRef.current,
    [navigationVersionRef]
  );
  const updateNodeDraft = useCallback(
    (
      nodeId: NoteId,
      patch: Pick<NoteNode, "title" | "note" | "imageOffsetUtf16"> &
        Partial<Pick<NoteNode, "markerKind" | "markdownImageWidth">>,
      field: NotesHistoryFocusField = "title"
    ): void => {
      if (selectionRef.current !== null) {
        updateSelection({ type: "clearSelection" });
      }
      draftEngineRef.current?.updateNodeDraft(nodeId, patch, field);
    },
    [draftEngineRef, selectionRef, updateSelection]
  );
  const flushNodeDraft = useCallback(
    (nodeId: NoteId): Promise<boolean> =>
      draftEngineRef.current?.flushNodeDraft(nodeId) ?? Promise.resolve(false),
    [draftEngineRef]
  );
  const registerImageAtomFlushAdapter = useCallback(
    (adapter: NotesImageAtomFlushAdapter): (() => void) => {
      const engine = draftEngineRef.current;
      if (
        !engine ||
        engine.record.closing ||
        engine.record.repository !== repository ||
        engine.record.vaultRoot !== vaultRoot ||
        isNotesDataDeletionInProgress(repository, vaultRoot)
      ) {
        return () => undefined;
      }
      return engine.registerImageAtomFlushAdapter(adapter);
    },
    [draftEngineRef, repository, vaultRoot]
  );
  const retryFailedDraft = useCallback(
    (nodeId: NoteId): Promise<void> =>
      draftEngineRef.current?.retryFailedDraft(nodeId) ?? Promise.resolve(),
    [draftEngineRef]
  );
  const retryLastFailedWrite = useCallback(
    (): Promise<void> =>
      draftEngineRef.current?.retryLastFailedWrite() ?? Promise.resolve(),
    [draftEngineRef]
  );
  const flushAllDraftsBeforeStructural = useCallback(
    (): Promise<boolean> =>
      draftEngineRef.current?.flushAllDrafts() ?? Promise.resolve(false),
    [draftEngineRef]
  );

  return {
    persistDraftMutation,
    markEditingFocus,
    setDraftEditingNavigation,
    getNavigationVersion,
    updateNodeDraft,
    flushNodeDraft,
    registerImageAtomFlushAdapter,
    retryFailedDraft,
    retryLastFailedWrite,
    flushAllDraftsBeforeStructural
  };
}
