import { useCallback, useRef, useState } from "react";
import { MAX_NOTE_ATTACHMENT_BATCH_BYTES } from "../../domain/notes";
import type {
  NoteAttachment,
  NoteId,
  NotesHistoryContext,
  NotesStore,
  NotesWorkspaceScope,
  PendingImageNodeByteItem
} from "../../domain/notes";
import type { NotesAttachmentUiBoundary } from "./notesAttachmentController";
import type {
  NotesDraftEngineCoordinatorSession,
  NotesWorkspaceCommandOutcome,
  NotesWorkspaceCoordinatorSession
} from "./notesWorkspaceCoordinator";
import type { NotesWorkspaceSessionRecord } from "./notesDraftEngine";
import type {
  NotesHistoryOwnerRegistry,
  NotesHistorySnapshot
} from "./notesHistory";
import {
  createImageNodeIdPairs,
  imageNodeByteItems,
  imageNodeInsertionAnchor,
  imageNodePathItems,
  sameImageNodeInsertionAnchor,
  type ImageNodeInsertionAnchor
} from "./imageNodeInsertion";
import {
  attachmentUploadAttempts,
  clipboardImageBatchByteSize,
  finalizeAttachmentUploadAttempt,
  notifyImageImportRecovery,
  notifyImageImportRecoveryFor,
  recoveredAttachmentUploadAttempts,
  releaseAttachmentUploadRecovery,
  releaseImageImportReservation,
  reserveImageImportOrderingTurn,
  retainAttachmentUploadAttemptForRecovery,
  retainedAttachmentUploadByteAttempts,
  type AttachmentUploadAttempt,
  type ImageNodeImportRequest
} from "./notesImageImportRecovery";
import { isNotesDataDeletionInProgress } from "./notesDataDeletionRegistry";
import type { NotesCommandContext } from "./notesCommands";
import type { NormalizedNotesWorkspace } from "./notesWorkspaceReducer";
import {
  confirmedState,
  directMutationResult,
  historyArguments,
  projectNotesMutation
} from "./notesWorkspaceCommandSupport";
import {
  cloneOwnedHistorySnapshot,
  cloneWorkspaceScope,
  errorMessage
} from "./notesWorkspaceNavigationSupport";
import { unwrapNotesMutation } from "./notesWorkspaceProjection";

interface LiveRef<T> {
  current: T;
}

interface NotesAttachmentStateDependencies {
  readonly repository: NotesStore;
  readonly vaultRoot: string;
  readonly closedRef: LiveRef<boolean>;
  readonly historyOwnerByEntryIdRef: LiveRef<
    NotesHistoryOwnerRegistry<NotesWorkspaceCoordinatorSession>
  >;
}

export interface NotesAttachmentWorkflowState {
  readonly attachmentUploadErrorsByNodeId: Readonly<Record<NoteId, string>>;
  readonly attachmentUploadRetryAttemptIdsByNodeId: Readonly<
    Record<NoteId, string>
  >;
  readonly attachmentUploadAttemptsByNodeIdRef: LiveRef<
    Map<NoteId, Map<string, AttachmentUploadAttempt>>
  >;
  readonly attachmentUploadAttemptOrderRef: LiveRef<number>;
  readonly imageImportMaxDisplayWidthRef: LiveRef<number | null>;
  readonly attachmentActionGenerationRef: LiveRef<{
    repository: NotesStore;
    vaultRoot: string;
  }>;
  readonly attachmentActionGeneration: {
    repository: NotesStore;
    vaultRoot: string;
  };
  readonly attachmentRecoveryChangeRef: LiveRef<() => void>;
  readonly setAttachmentUploadError: (
    nodeId: NoteId,
    error: string | null,
    retryAttemptId?: string
  ) => void;
  readonly publishLatestAttachmentAttemptError: (nodeId: NoteId) => void;
  readonly removeAttachmentUploadAttempt: (
    attempt: AttachmentUploadAttempt
  ) => void;
  readonly setImageImportMaxDisplayWidth: (displayWidth: number | null) => void;
  readonly releaseFinalizedDetachedAttachmentUploadAttempts: (
    record: NotesWorkspaceSessionRecord
  ) => void;
  readonly prepareAttachmentUploadAttemptsForTeardown: () => void;
  readonly discardAttachmentUploadAttempts: () => void;
  readonly purgeAttachmentUploadAttemptsAfterDataDeletion: () => void;
  readonly clearAttachmentUploadUi: () => void;
}

export function useNotesAttachmentWorkflowState({
  repository,
  vaultRoot,
  closedRef,
  historyOwnerByEntryIdRef
}: NotesAttachmentStateDependencies): NotesAttachmentWorkflowState {
  const [attachmentUploadErrorsByNodeId, setAttachmentUploadErrorsByNodeId] =
    useState<Readonly<Record<NoteId, string>>>({});
  const [
    attachmentUploadRetryAttemptIdsByNodeId,
    setAttachmentUploadRetryAttemptIdsByNodeId
  ] = useState<Readonly<Record<NoteId, string>>>({});
  const attachmentUploadAttemptsByNodeIdRef = useRef(
    new Map<NoteId, Map<string, AttachmentUploadAttempt>>()
  );
  const attachmentUploadAttemptOrderRef = useRef(0);
  const imageImportMaxDisplayWidthRef = useRef<number | null>(null);
  const attachmentRecoveryChangeRef = useRef<() => void>(() => undefined);
  const attachmentActionGenerationRef = useRef({ repository, vaultRoot });
  if (
    attachmentActionGenerationRef.current.repository !== repository ||
    attachmentActionGenerationRef.current.vaultRoot !== vaultRoot
  ) {
    attachmentActionGenerationRef.current = { repository, vaultRoot };
  }
  const attachmentActionGeneration = attachmentActionGenerationRef.current;

  const setAttachmentUploadError = useCallback(
    (nodeId: NoteId, error: string | null, retryAttemptId?: string): void => {
      let effectiveRetryAttemptId = retryAttemptId;
      if (error !== null && effectiveRetryAttemptId === undefined) {
        for (const attempt of
          attachmentUploadAttemptsByNodeIdRef.current.get(nodeId)?.values() ??
          []) {
          if (attempt.status === "failed") {
            effectiveRetryAttemptId = attempt.attemptId;
          }
        }
      }
      setAttachmentUploadErrorsByNodeId((current) => {
        if (error === null) {
          if (current[nodeId] === undefined) return current;
          const next = { ...current };
          delete next[nodeId];
          return next;
        }
        return current[nodeId] === error
          ? current
          : { ...current, [nodeId]: error };
      });
      setAttachmentUploadRetryAttemptIdsByNodeId((current) => {
        if (error === null || effectiveRetryAttemptId === undefined) {
          if (current[nodeId] === undefined) return current;
          const next = { ...current };
          delete next[nodeId];
          return next;
        }
        return current[nodeId] === effectiveRetryAttemptId
          ? current
          : { ...current, [nodeId]: effectiveRetryAttemptId };
      });
    },
    []
  );
  const publishLatestAttachmentAttemptError = useCallback(
    (nodeId: NoteId): void => {
      const attempts = attachmentUploadAttemptsByNodeIdRef.current.get(nodeId);
      let latestFailedAttempt: AttachmentUploadAttempt | undefined;
      for (const attempt of attempts?.values() ?? []) {
        if (attempt.status === "failed") latestFailedAttempt = attempt;
      }
      setAttachmentUploadError(
        nodeId,
        latestFailedAttempt?.error ?? null,
        latestFailedAttempt?.attemptId
      );
    },
    [setAttachmentUploadError]
  );
  const removeAttachmentUploadAttempt = useCallback(
    (attempt: AttachmentUploadAttempt): void => {
      const attempts = attachmentUploadAttemptsByNodeIdRef.current.get(
        attempt.nodeId
      );
      if (attempts?.get(attempt.attemptId) !== attempt) return;
      attempts.delete(attempt.attemptId);
      if (attempts.size === 0) {
        attachmentUploadAttemptsByNodeIdRef.current.delete(attempt.nodeId);
      }
    },
    []
  );
  const setImageImportMaxDisplayWidth = useCallback(
    (displayWidth: number | null): void => {
      imageImportMaxDisplayWidthRef.current =
        displayWidth !== null &&
        Number.isSafeInteger(displayWidth) &&
        displayWidth > 0
          ? displayWidth
          : null;
    },
    []
  );
  const releaseFinalizedDetachedAttachmentUploadAttempts = useCallback(
    (record: NotesWorkspaceSessionRecord): void => {
      for (const attempt of attachmentUploadAttempts) {
        if (
          attempt.record === record &&
          attempt.detached &&
          !attempt.started &&
          !attempt.unknownOutcome &&
          attempt.enqueueCompletionSettled &&
          (attempt.structuralIntent === null ||
            !record.structuralIntents.includes(attempt.structuralIntent))
        ) {
          retainedAttachmentUploadByteAttempts.delete(attempt);
          attachmentUploadAttempts.delete(attempt);
          releaseAttachmentUploadRecovery(attempt);
        }
      }
    },
    []
  );
  const prepareAttachmentUploadAttemptsForTeardown = useCallback((): void => {
    for (const attempts of attachmentUploadAttemptsByNodeIdRef.current.values()) {
      for (const attempt of attempts.values()) {
        if (!attempt.started && !attempt.unknownOutcome) continue;
        attempt.detached = true;
        retainAttachmentUploadAttemptForRecovery(attempt);
      }
    }
  }, []);
  const discardAttachmentUploadAttempts = useCallback((): void => {
    const detachedRecords = new Set<NotesWorkspaceSessionRecord>();
    for (const attempts of attachmentUploadAttemptsByNodeIdRef.current.values()) {
      for (const attempt of attempts.values()) {
        const context = attempt.historyContext;
        if (attempt.status === "pending") {
          attempt.detached = true;
          detachedRecords.add(attempt.record);
        }
        if (attempt.started || attempt.unknownOutcome) {
          attempt.detached = true;
          retainAttachmentUploadAttemptForRecovery(attempt);
          continue;
        }
        releaseImageImportReservation(attempt);
        if (attempt.enqueueCompletionSettled) {
          retainedAttachmentUploadByteAttempts.delete(attempt);
          attachmentUploadAttempts.delete(attempt);
        }
        if (context) {
          historyOwnerByEntryIdRef.current
            .owner(context.entryId)
            ?.history.discard(context.entryId);
          historyOwnerByEntryIdRef.current.discard(context.entryId);
        }
      }
    }
    attachmentUploadAttemptsByNodeIdRef.current.clear();
    for (const record of detachedRecords) {
      releaseFinalizedDetachedAttachmentUploadAttempts(record);
    }
  }, [historyOwnerByEntryIdRef, releaseFinalizedDetachedAttachmentUploadAttempts]);
  const clearAttachmentUploadUi = useCallback((): void => {
    setAttachmentUploadErrorsByNodeId({});
    setAttachmentUploadRetryAttemptIdsByNodeId({});
  }, []);
  const purgeAttachmentUploadAttemptsAfterDataDeletion = useCallback((): void => {
    for (const attempt of [...attachmentUploadAttempts]) {
      const recoveryOwner = attempt.recoveryOwner;
      const belongsToDeletedVault = recoveryOwner
        ? recoveryOwner.repository === repository &&
          recoveryOwner.vaultRoot === vaultRoot
        : attempt.record.repository === repository &&
          attempt.record.vaultRoot === vaultRoot;
      if (!belongsToDeletedVault) continue;
      attempt.detached = true;
      const context = attempt.historyContext;
      if (context) {
        const registeredOwner = historyOwnerByEntryIdRef.current.owner(
          context.entryId
        );
        (registeredOwner ?? attempt.record.session).history.discard(
          context.entryId
        );
        historyOwnerByEntryIdRef.current.discard(context.entryId);
      }
      finalizeAttachmentUploadAttempt(attempt);
    }
    notifyImageImportRecoveryFor(repository, vaultRoot);
    const generation = attachmentActionGenerationRef.current;
    if (
      !closedRef.current &&
      generation.repository === repository &&
      generation.vaultRoot === vaultRoot
    ) {
      attachmentUploadAttemptsByNodeIdRef.current.clear();
      clearAttachmentUploadUi();
    }
  }, [
    clearAttachmentUploadUi,
    closedRef,
    historyOwnerByEntryIdRef,
    repository,
    vaultRoot
  ]);

  const syncRecoveredAttachmentUploadAttempts = useCallback((): void => {
    const recovered = recoveredAttachmentUploadAttempts(repository, vaultRoot);
    const recoveredSet = new Set(recovered);
    const affectedNodeIds = new Set<NoteId>();
    for (const attempts of attachmentUploadAttemptsByNodeIdRef.current.values()) {
      for (const [attemptId, attempt] of attempts) {
        const recoveryOwner = attempt.recoveryOwner;
        const belongsToCurrentVault = recoveryOwner
          ? recoveryOwner.repository === repository &&
            recoveryOwner.vaultRoot === vaultRoot
          : attempt.record.repository === repository &&
            attempt.record.vaultRoot === vaultRoot;
        const finalized =
          belongsToCurrentVault && !attachmentUploadAttempts.has(attempt);
        const noLongerRecovered =
          recoveryOwner?.repository === repository &&
          recoveryOwner.vaultRoot === vaultRoot &&
          !recoveredSet.has(attempt);
        if (finalized || noLongerRecovered) {
          attempts.delete(attemptId);
          if (finalized && attempt.historyContext) {
            historyOwnerByEntryIdRef.current.discard(
              attempt.historyContext.entryId
            );
          }
          affectedNodeIds.add(attempt.nodeId);
        }
      }
    }
    for (const attempt of recovered) {
      const attempts =
        attachmentUploadAttemptsByNodeIdRef.current.get(attempt.nodeId) ??
        new Map();
      attempts.set(attempt.attemptId, attempt);
      attachmentUploadAttemptsByNodeIdRef.current.set(attempt.nodeId, attempts);
      affectedNodeIds.add(attempt.nodeId);
    }
    for (const [nodeId, attempts] of attachmentUploadAttemptsByNodeIdRef.current) {
      if (attempts.size === 0) {
        attachmentUploadAttemptsByNodeIdRef.current.delete(nodeId);
      }
    }
    for (const nodeId of affectedNodeIds) {
      publishLatestAttachmentAttemptError(nodeId);
    }
  }, [
    historyOwnerByEntryIdRef,
    publishLatestAttachmentAttemptError,
    repository,
    vaultRoot
  ]);
  attachmentRecoveryChangeRef.current = syncRecoveredAttachmentUploadAttempts;

  return {
    attachmentUploadErrorsByNodeId,
    attachmentUploadRetryAttemptIdsByNodeId,
    attachmentUploadAttemptsByNodeIdRef,
    attachmentUploadAttemptOrderRef,
    imageImportMaxDisplayWidthRef,
    attachmentActionGenerationRef,
    attachmentActionGeneration,
    attachmentRecoveryChangeRef,
    setAttachmentUploadError,
    publishLatestAttachmentAttemptError,
    removeAttachmentUploadAttempt,
    setImageImportMaxDisplayWidth,
    releaseFinalizedDetachedAttachmentUploadAttempts,
    prepareAttachmentUploadAttemptsForTeardown,
    discardAttachmentUploadAttempts,
    purgeAttachmentUploadAttemptsAfterDataDeletion,
    clearAttachmentUploadUi
  };
}

interface NotesAttachmentWorkflowDependencies {
  readonly repository: NotesStore;
  readonly vaultRoot: string;
  readonly attachmentUi: NotesAttachmentUiBoundary;
  readonly activeScopeRef: LiveRef<NotesWorkspaceScope>;
  readonly activeWorkspaceGenerationRef: LiveRef<number>;
  readonly stateRef: LiveRef<NormalizedNotesWorkspace>;
  readonly sessionRecordRef: LiveRef<NotesWorkspaceSessionRecord | null>;
  readonly sessionRef: LiveRef<NotesWorkspaceCoordinatorSession | null>;
  readonly vaultRootRef: LiveRef<string>;
  readonly closedRef: LiveRef<boolean>;
  readonly captureHistorySnapshot: () => NotesHistorySnapshot;
  readonly beginStructuralEntry: (
    record: NotesWorkspaceSessionRecord,
    commandKind: string,
    before?: NotesHistorySnapshot
  ) => NotesHistoryContext;
  readonly discardHistoryEntry: (
    context: NotesHistoryContext | null | undefined
  ) => void;
  readonly registerHistoryOwner: (
    context: NotesHistoryContext,
    owner: NotesWorkspaceCoordinatorSession
  ) => NotesHistoryContext;
  readonly runStructuralCommand: NotesCommandContext["runStructuralCommand"];
  readonly settleAtomicMutation: NotesCommandContext["settleAtomicMutation"];
  readonly workflowState: NotesAttachmentWorkflowState;
}

export interface NotesAttachmentWorkflowActions {
  readonly importClipboardImages: (
    nodeId: NoteId,
    items: readonly PendingImageNodeByteItem[]
  ) => Promise<void>;
  readonly importDroppedImagePaths: (
    nodeId: NoteId,
    paths: readonly string[]
  ) => Promise<void>;
  readonly uploadImage: (nodeId: NoteId) => Promise<void>;
  readonly retryImageUpload: (nodeId: NoteId, attemptId?: string) => Promise<void>;
  readonly loadAttachmentBytes: (attachmentId: string) => Promise<Uint8Array>;
  readonly viewImageOriginal: (attachmentId: string) => Promise<void>;
  readonly downloadImage: (
    attachmentId: string,
    originalName: string,
    mimeType: NoteAttachment["mimeType"]
  ) => Promise<void>;
  readonly resizeImage: (
    attachmentId: string,
    displayWidth: number
  ) => Promise<void>;
  readonly removeImage: (attachmentId: string) => Promise<void>;
}

function asCoordinatorSession(
  session: NotesDraftEngineCoordinatorSession
): NotesWorkspaceCoordinatorSession {
  return session as NotesWorkspaceCoordinatorSession;
}

export function useNotesAttachmentWorkflow({
  repository,
  vaultRoot,
  attachmentUi,
  activeScopeRef,
  activeWorkspaceGenerationRef,
  stateRef,
  sessionRecordRef,
  sessionRef,
  vaultRootRef,
  closedRef,
  captureHistorySnapshot,
  beginStructuralEntry,
  discardHistoryEntry,
  registerHistoryOwner,
  runStructuralCommand,
  settleAtomicMutation,
  workflowState
}: NotesAttachmentWorkflowDependencies): NotesAttachmentWorkflowActions {
  const {
    attachmentUploadAttemptsByNodeIdRef,
    attachmentUploadAttemptOrderRef,
    imageImportMaxDisplayWidthRef,
    attachmentActionGenerationRef,
    attachmentActionGeneration,
    setAttachmentUploadError,
    publishLatestAttachmentAttemptError,
    removeAttachmentUploadAttempt,
    releaseFinalizedDetachedAttachmentUploadAttempts
  } = workflowState;

  const discardPendingAttachmentUploadAttempt = useCallback(
    (attempt: AttachmentUploadAttempt): void => {
      if (attempt.status !== "pending" || attempt.unknownOutcome) return;
      const attempts = attachmentUploadAttemptsByNodeIdRef.current.get(
        attempt.nodeId
      );
      if (attempts?.get(attempt.attemptId) !== attempt) return;
      finalizeAttachmentUploadAttempt(attempt);
      discardHistoryEntry(attempt.historyContext);
      removeAttachmentUploadAttempt(attempt);
      publishLatestAttachmentAttemptError(attempt.nodeId);
    },
    [
      attachmentUploadAttemptsByNodeIdRef,
      discardHistoryEntry,
      publishLatestAttachmentAttemptError,
      removeAttachmentUploadAttempt
    ]
  );
  const admitAttachmentUploadBytes = useCallback(
    (incomingByteSize: number): boolean => {
      let retainedByteSize = 0;
      for (const attempt of retainedAttachmentUploadByteAttempts) {
        retainedByteSize += attempt.retainedByteSize;
      }
      return (
        retainedByteSize + incomingByteSize <= MAX_NOTE_ATTACHMENT_BATCH_BYTES
      );
    },
    []
  );
  const createAttachmentUploadAttempt = useCallback(
    (
      nodeId: NoteId,
      request: ImageNodeImportRequest,
      initialMaxDisplayWidth: number,
      retainedByteSize = 0
    ): AttachmentUploadAttempt | null => {
      const record = sessionRecordRef.current;
      if (
        !record ||
        record.closing ||
        record.repository !== repository ||
        record.vaultRoot !== vaultRoot
      ) {
        return null;
      }
      const historyLocation = captureHistorySnapshot();
      const attempt: AttachmentUploadAttempt = {
        attemptId: globalThis.crypto.randomUUID(),
        order: ++attachmentUploadAttemptOrderRef.current,
        nodeId,
        request,
        retainedByteSize,
        scope: cloneWorkspaceScope(activeScopeRef.current),
        initialMaxDisplayWidth,
        historyContext: beginStructuralEntry(
          record,
          "attachment-import",
          historyLocation
        ),
        historyLocation: cloneOwnedHistorySnapshot(historyLocation),
        record,
        orderingTurn: reserveImageImportOrderingTurn(
          repository,
          vaultRoot,
          request.anchor
        ),
        reservation:
          asCoordinatorSession(record.session).reserveImageImportInsertion?.(
            request.anchor
          ) ?? null,
        recoveryOwner: null,
        effectiveAnchor: null,
        structuralIntent: null,
        enqueueCompletionSettled: false,
        detached: false,
        started: false,
        unknownOutcome: false,
        status: "pending",
        error: null
      };
      const attempts =
        attachmentUploadAttemptsByNodeIdRef.current.get(nodeId) ?? new Map();
      attempts.set(attempt.attemptId, attempt);
      attachmentUploadAttemptsByNodeIdRef.current.set(nodeId, attempts);
      attachmentUploadAttempts.add(attempt);
      if (request.kind === "bytes") {
        retainedAttachmentUploadByteAttempts.add(attempt);
      }
      publishLatestAttachmentAttemptError(nodeId);
      return attempt;
    },
    [
      activeScopeRef,
      attachmentUploadAttemptOrderRef,
      attachmentUploadAttemptsByNodeIdRef,
      beginStructuralEntry,
      captureHistorySnapshot,
      publishLatestAttachmentAttemptError,
      repository,
      sessionRecordRef,
      vaultRoot
    ]
  );
  const executeAttachmentUploadAttempt = useCallback(
    async (attempt: AttachmentUploadAttempt): Promise<void> => {
      const retainedUnknownError = attempt.unknownOutcome ? attempt.error : null;
      attempt.status = "pending";
      attempt.error = null;
      attempt.structuralIntent = null;
      attempt.enqueueCompletionSettled = false;
      attempt.detached = false;
      attempt.started = false;
      if (attempt.request.kind === "bytes") {
        retainedAttachmentUploadByteAttempts.add(attempt);
      }
      publishLatestAttachmentAttemptError(attempt.nodeId);

      let outcome: NotesWorkspaceCommandOutcome | null = null;
      let finishMutationSettlement!: () => void;
      const mutationSettlement = new Promise<void>((resolve) => {
        finishMutationSettlement = resolve;
      });
      try {
        await attempt.orderingTurn.wait();
        if (attempt.detached) {
          if (attempt.unknownOutcome) {
            attempt.status = "failed";
            attempt.error = retainedUnknownError;
            if (attempt.recoveryOwner) {
              notifyImageImportRecovery(attempt.recoveryOwner);
            }
          }
          return;
        }
        const priorStructuralIntents = new Set(attempt.record.structuralIntents);
        const completion = runStructuralCommand(
          "attachment-import",
          async (context, historyContext, record) => {
            attempt.scope = cloneWorkspaceScope(context.sourceScope);
            const confirmedTarget =
              confirmedState(context).nodesById[attempt.nodeId];
            const currentAnchor = imageNodeInsertionAnchor(
              stateRef.current,
              attempt.nodeId
            );
            if (
              record !== attempt.record ||
              (!attempt.unknownOutcome &&
                (!confirmedTarget ||
                  confirmedTarget.deletedAt !== null ||
                  confirmedTarget.archivedAt !== null ||
                  currentAnchor === null ||
                  !sameImageNodeInsertionAnchor(
                    currentAnchor,
                    attempt.request.anchor
                  )))
            ) {
              if (attempt.unknownOutcome) {
                return {
                  kind: "failure",
                  error:
                    attempt.error ??
                    "Image upload reconciliation is still pending."
                };
              }
              finalizeAttachmentUploadAttempt(attempt);
              removeAttachmentUploadAttempt(attempt);
              publishLatestAttachmentAttemptError(attempt.nodeId);
              return { kind: "skipped" };
            }
            const executionAnchor =
              attempt.effectiveAnchor ??
              attempt.reservation?.resolve() ??
              attempt.request.anchor;
            attempt.effectiveAnchor = executionAnchor;
            const operationGeneration = activeWorkspaceGenerationRef.current;
            const isCurrent = (): boolean =>
              sessionRecordRef.current === attempt.record &&
              !attempt.record.closing &&
              sessionRef.current === attempt.record.session &&
              activeWorkspaceGenerationRef.current === operationGeneration;
            let mutationOutcomeKnown = false;
            try {
              if (
                attempt.request.kind === "paths" &&
                !context.repository.importImageNodePaths
              ) {
                throw new Error("Image node path import is unavailable.");
              }
              if (
                attempt.request.kind === "bytes" &&
                !context.repository.importImageNodeBytes
              ) {
                throw new Error("Image node byte import is unavailable.");
              }
              attempt.started = true;
              const response =
                attempt.request.kind === "paths"
                  ? await context.repository.importImageNodePaths!(
                      context.vaultRoot,
                      {
                        parentId: executionAnchor.parentId,
                        afterId: executionAnchor.afterId,
                        items: attempt.request.items,
                        initialMaxDisplayWidth: attempt.initialMaxDisplayWidth
                      },
                      ...historyArguments(historyContext)
                    )
                  : await context.repository.importImageNodeBytes!(
                      context.vaultRoot,
                      {
                        parentId: executionAnchor.parentId,
                        afterId: executionAnchor.afterId,
                        items: attempt.request.items,
                        initialMaxDisplayWidth: attempt.initialMaxDisplayWidth
                      },
                      ...historyArguments(historyContext)
                    );
              const mutation = unwrapNotesMutation(response);
              mutationOutcomeKnown = true;
              attempt.unknownOutcome = false;
              const importedTailId = mutation.importedRootIds?.at(-1);
              if (importedTailId) attempt.reservation?.commit(importedTailId);
              const projection = await projectNotesMutation(
                context,
                mutation,
                attempt.scope
              );
              if (
                !isCurrent() &&
                vaultRootRef.current !== attempt.record.vaultRoot
              ) {
                const settlement = await settleAtomicMutation(
                  historyContext,
                  mutation,
                  projection,
                  {
                    requestedLocation: attempt.historyLocation ?? undefined,
                    recoveryLocation: attempt.historyLocation ?? undefined,
                    recoverySource: attempt.record
                  }
                );
                removeAttachmentUploadAttempt(attempt);
                if (settlement) return settlement;
                return directMutationResult(
                  mutation,
                  projection,
                  undefined,
                  attempt.scope
                );
              }
              const importedRootId = mutation.importedRootIds?.[0] ?? null;
              const uiUpdate = importedRootId
                ? {
                    selectedId: importedRootId,
                    editingNoteId: importedRootId,
                    pendingFocusId: importedRootId,
                    pendingFocusField: "title" as const
                  }
                : undefined;
              const settlement = await settleAtomicMutation(
                historyContext,
                mutation,
                projection,
                {
                  uiUpdate,
                  recoveryLocation: attempt.historyLocation ?? undefined,
                  recoverySource: attempt.record
                }
              );
              if (settlement) {
                removeAttachmentUploadAttempt(attempt);
                return settlement;
              }
              if (!isCurrent()) {
                removeAttachmentUploadAttempt(attempt);
                return directMutationResult(
                  mutation,
                  projection,
                  undefined,
                  attempt.scope
                );
              }
              removeAttachmentUploadAttempt(attempt);
              publishLatestAttachmentAttemptError(attempt.nodeId);
              return directMutationResult(
                mutation,
                projection,
                uiUpdate,
                attempt.scope
              );
            } catch (cause) {
              const message = `Image upload failed: ${errorMessage(cause)}`;
              if (!attempt.started && !attempt.unknownOutcome) {
                removeAttachmentUploadAttempt(attempt);
                discardHistoryEntry(attempt.historyContext);
                setAttachmentUploadError(attempt.nodeId, message);
                return { kind: "failure", error: message };
              }
              attempt.unknownOutcome = true;
              attempt.status = "failed";
              attempt.error = message;
              if (!isCurrent()) {
                attempt.detached = true;
                removeAttachmentUploadAttempt(attempt);
                retainAttachmentUploadAttemptForRecovery(attempt);
                return { kind: "failure", error: message };
              }
              publishLatestAttachmentAttemptError(attempt.nodeId);
              return { kind: "failure", error: message };
            } finally {
              if (
                mutationOutcomeKnown ||
                (!attempt.started && !attempt.unknownOutcome)
              ) {
                finalizeAttachmentUploadAttempt(attempt);
              }
              finishMutationSettlement();
            }
          },
          {
            historyContext: attempt.historyContext,
            retainHistoryOnFailure: true
          }
        );
        attempt.structuralIntent =
          attempt.record.structuralIntents.find(
            (intent) => !priorStructuralIntents.has(intent)
          ) ?? null;
        try {
          outcome = await completion;
        } finally {
          if (attempt.started) await mutationSettlement;
        }
      } catch {
        if (!attempt.started && !attempt.unknownOutcome) {
          discardPendingAttachmentUploadAttempt(attempt);
        } else if (!attempt.started && attempt.unknownOutcome) {
          attempt.status = "failed";
          attempt.error ??= retainedUnknownError;
          if (attempt.detached) {
            if (attempt.recoveryOwner) {
              notifyImageImportRecovery(attempt.recoveryOwner);
            }
          } else {
            publishLatestAttachmentAttemptError(attempt.nodeId);
          }
        }
        return;
      } finally {
        attempt.enqueueCompletionSettled = true;
        releaseFinalizedDetachedAttachmentUploadAttempts(attempt.record);
      }
      if (
        outcome !== "committed" &&
        !attempt.started &&
        attempt.unknownOutcome
      ) {
        attempt.status = "failed";
        attempt.error ??= retainedUnknownError;
        if (attempt.detached) {
          if (attempt.recoveryOwner) {
            notifyImageImportRecovery(attempt.recoveryOwner);
          }
        } else {
          publishLatestAttachmentAttemptError(attempt.nodeId);
        }
      } else if (
        outcome !== "committed" &&
        !attempt.started &&
        !attempt.unknownOutcome
      ) {
        discardPendingAttachmentUploadAttempt(attempt);
      }
    },
    [
      activeWorkspaceGenerationRef,
      discardHistoryEntry,
      discardPendingAttachmentUploadAttempt,
      publishLatestAttachmentAttemptError,
      releaseFinalizedDetachedAttachmentUploadAttempts,
      removeAttachmentUploadAttempt,
      runStructuralCommand,
      sessionRecordRef,
      sessionRef,
      settleAtomicMutation,
      setAttachmentUploadError,
      stateRef,
      vaultRootRef
    ]
  );
  const importImagePaths = useCallback(
    async (
      nodeId: NoteId,
      paths: readonly string[],
      initialMaxDisplayWidth: number,
      capturedAnchor?: ImageNodeInsertionAnchor
    ): Promise<void> => {
      if (paths.length === 0) return;
      if (!repository.importImageNodePaths) {
        setAttachmentUploadError(
          nodeId,
          "Image upload failed: Image node path import is unavailable."
        );
        return;
      }
      if (
        !Number.isSafeInteger(initialMaxDisplayWidth) ||
        initialMaxDisplayWidth <= 0
      ) {
        setAttachmentUploadError(nodeId, "Image area is not ready.");
        return;
      }
      try {
        const currentAnchor = imageNodeInsertionAnchor(stateRef.current, nodeId);
        if (
          capturedAnchor &&
          (currentAnchor === null ||
            !sameImageNodeInsertionAnchor(currentAnchor, capturedAnchor))
        ) {
          return;
        }
        const anchor = capturedAnchor ?? currentAnchor;
        if (anchor === null) return;
        const request: ImageNodeImportRequest = {
          kind: "paths",
          anchor,
          items: imageNodePathItems(paths, createImageNodeIdPairs(paths.length))
        };
        const attempt = createAttachmentUploadAttempt(
          nodeId,
          request,
          initialMaxDisplayWidth
        );
        if (attempt) await executeAttachmentUploadAttempt(attempt);
      } catch (cause) {
        setAttachmentUploadError(nodeId, errorMessage(cause));
      }
    },
    [
      createAttachmentUploadAttempt,
      executeAttachmentUploadAttempt,
      repository,
      setAttachmentUploadError,
      stateRef
    ]
  );
  const importClipboardImages = useCallback(
    async (
      nodeId: NoteId,
      items: readonly PendingImageNodeByteItem[]
    ): Promise<void> => {
      if (items.length === 0) return;
      if (!repository.importImageNodeBytes) {
        setAttachmentUploadError(
          nodeId,
          "Image upload failed: Image node byte import is unavailable."
        );
        return;
      }
      const retainedByteSize = clipboardImageBatchByteSize(items);
      if (retainedByteSize === null) {
        setAttachmentUploadError(nodeId, "Invalid clipboard image batch.");
        return;
      }
      const initialMaxDisplayWidth = imageImportMaxDisplayWidthRef.current ?? 0;
      if (
        !Number.isSafeInteger(initialMaxDisplayWidth) ||
        initialMaxDisplayWidth <= 0
      ) {
        setAttachmentUploadError(nodeId, "Image area is not ready.");
        return;
      }
      try {
        const anchor = imageNodeInsertionAnchor(stateRef.current, nodeId);
        if (anchor === null) return;
        if (!admitAttachmentUploadBytes(retainedByteSize)) {
          setAttachmentUploadError(
            nodeId,
            "Clipboard image retry data exceeds the 64 MiB memory limit."
          );
          return;
        }
        const request: ImageNodeImportRequest = {
          kind: "bytes",
          anchor,
          items: imageNodeByteItems(items, createImageNodeIdPairs(items.length))
        };
        const attempt = createAttachmentUploadAttempt(
          nodeId,
          request,
          initialMaxDisplayWidth,
          retainedByteSize
        );
        if (attempt) await executeAttachmentUploadAttempt(attempt);
      } catch (cause) {
        setAttachmentUploadError(nodeId, errorMessage(cause));
      }
    },
    [
      admitAttachmentUploadBytes,
      createAttachmentUploadAttempt,
      executeAttachmentUploadAttempt,
      imageImportMaxDisplayWidthRef,
      repository,
      setAttachmentUploadError,
      stateRef
    ]
  );
  const importDroppedImagePaths = useCallback(
    async (nodeId: NoteId, paths: readonly string[]): Promise<void> => {
      await importImagePaths(
        nodeId,
        paths,
        imageImportMaxDisplayWidthRef.current ?? 0
      );
    },
    [imageImportMaxDisplayWidthRef, importImagePaths]
  );
  const uploadImage = useCallback(
    async (nodeId: NoteId): Promise<void> => {
      if (vaultRoot.trim().length === 0) return;
      const invocationRecord = sessionRecordRef.current;
      const initialMaxDisplayWidth = imageImportMaxDisplayWidthRef.current ?? 0;
      const capturedAnchor = imageNodeInsertionAnchor(stateRef.current, nodeId);
      if (capturedAnchor === null) return;
      try {
        const sourcePaths = await attachmentUi.openImageFiles();
        if (
          !invocationRecord ||
          invocationRecord.closing ||
          sessionRecordRef.current !== invocationRecord ||
          invocationRecord.repository !== repository ||
          invocationRecord.vaultRoot !== vaultRoot
        ) {
          return;
        }
        if (sourcePaths === null || sourcePaths.length === 0) return;
        await importImagePaths(
          nodeId,
          sourcePaths,
          initialMaxDisplayWidth,
          capturedAnchor
        );
      } catch (cause) {
        if (
          !invocationRecord ||
          invocationRecord.closing ||
          sessionRecordRef.current !== invocationRecord
        ) {
          return;
        }
        setAttachmentUploadError(
          nodeId,
          `Image picker failed: ${errorMessage(cause)}`
        );
      }
    },
    [
      attachmentUi,
      imageImportMaxDisplayWidthRef,
      importImagePaths,
      repository,
      sessionRecordRef,
      setAttachmentUploadError,
      stateRef,
      vaultRoot
    ]
  );
  const retryImageUpload = useCallback(
    async (nodeId: NoteId, attemptId?: string): Promise<void> => {
      const attempts = attachmentUploadAttemptsByNodeIdRef.current.get(nodeId);
      const failedAttempt = attemptId ? attempts?.get(attemptId) : undefined;
      if (attemptId) {
        if (failedAttempt?.status === "failed") {
          const record = sessionRecordRef.current;
          if (
            !record ||
            record.closing ||
            record.repository !== repository ||
            record.vaultRoot !== vaultRoot
          ) {
            return;
          }
          if (
            failedAttempt.recoveryOwner &&
            (failedAttempt.recoveryOwner.repository !== repository ||
              failedAttempt.recoveryOwner.vaultRoot !== vaultRoot)
          ) {
            return;
          }
          failedAttempt.record = record;
          if (failedAttempt.historyContext) {
            registerHistoryOwner(
              failedAttempt.historyContext,
              asCoordinatorSession(record.session)
            );
          }
          failedAttempt.scope = cloneWorkspaceScope(activeScopeRef.current);
          await executeAttachmentUploadAttempt(failedAttempt);
        }
        return;
      }
      await uploadImage(nodeId);
    },
    [
      activeScopeRef,
      attachmentUploadAttemptsByNodeIdRef,
      executeAttachmentUploadAttempt,
      registerHistoryOwner,
      repository,
      sessionRecordRef,
      uploadImage,
      vaultRoot
    ]
  );
  const currentAttachmentActionRecord = useCallback(
    (): NotesWorkspaceSessionRecord | null => {
      if (
        attachmentActionGenerationRef.current !== attachmentActionGeneration ||
        closedRef.current ||
        isNotesDataDeletionInProgress(
          attachmentActionGeneration.repository,
          attachmentActionGeneration.vaultRoot
        )
      ) {
        return null;
      }
      const record = sessionRecordRef.current;
      return record &&
        !record.closing &&
        record.repository === attachmentActionGeneration.repository &&
        record.vaultRoot === attachmentActionGeneration.vaultRoot &&
        sessionRef.current === record.session
        ? record
        : null;
    },
    [
      attachmentActionGeneration,
      attachmentActionGenerationRef,
      closedRef,
      sessionRecordRef,
      sessionRef
    ]
  );
  const loadAttachmentBytes = useCallback(
    async (attachmentId: string): Promise<Uint8Array> => {
      const record = currentAttachmentActionRecord();
      const readAttachmentBytes = record?.repository.readAttachmentBytes;
      if (!record || !readAttachmentBytes) {
        throw new Error("Image loading is unavailable.");
      }
      return readAttachmentBytes(record.vaultRoot, attachmentId);
    },
    [currentAttachmentActionRecord]
  );
  const viewImageOriginal = useCallback(
    async (attachmentId: string): Promise<void> => {
      const record = currentAttachmentActionRecord();
      if (!record) return;
      const openAttachmentOriginal = record.repository.openAttachmentOriginal;
      if (!openAttachmentOriginal) {
        throw new Error("Opening image originals is unavailable.");
      }
      await openAttachmentOriginal(record.vaultRoot, attachmentId);
    },
    [currentAttachmentActionRecord]
  );
  const downloadImage = useCallback(
    async (
      attachmentId: string,
      _originalName: string,
      _mimeType: NoteAttachment["mimeType"]
    ): Promise<void> => {
      const record = currentAttachmentActionRecord();
      if (!record) return;
      const downloadAttachment = record.repository.downloadAttachment;
      if (!downloadAttachment) {
        throw new Error("Image download is unavailable.");
      }
      await downloadAttachment(record.vaultRoot, attachmentId);
    },
    [currentAttachmentActionRecord]
  );
  const resizeImage = useCallback(
    async (attachmentId: string, displayWidth: number): Promise<void> =>
      runStructuralCommand(
        "attachment-resize",
        async (context, historyContext) => {
          const attachmentExists = Object.values(
            confirmedState(context).attachmentsByNodeId
          ).some((attachments) =>
            attachments.some((attachment) => attachment.id === attachmentId)
          );
          if (!attachmentExists || !context.repository.resizeAttachment) {
            return { kind: "skipped" };
          }
          const mutation = unwrapNotesMutation(
            await context.repository.resizeAttachment(
              context.vaultRoot,
              { id: attachmentId, displayWidth },
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
            projection
          );
          return settlement ?? directMutationResult(mutation, projection);
        }
      ).then(() => undefined),
    [activeScopeRef, runStructuralCommand, settleAtomicMutation]
  );
  const removeImage = useCallback(
    async (attachmentId: string): Promise<void> =>
      runStructuralCommand(
        "attachment-remove",
        async (context, historyContext) => {
          const attachmentExists = Object.values(
            confirmedState(context).attachmentsByNodeId
          ).some((attachments) =>
            attachments.some((attachment) => attachment.id === attachmentId)
          );
          if (!attachmentExists || !context.repository.removeAttachment) {
            return { kind: "skipped" };
          }
          const mutation = unwrapNotesMutation(
            await context.repository.removeAttachment(
              context.vaultRoot,
              attachmentId,
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
            projection
          );
          return settlement ?? directMutationResult(mutation, projection);
        }
      ).then(() => undefined),
    [activeScopeRef, runStructuralCommand, settleAtomicMutation]
  );

  return {
    importClipboardImages,
    importDroppedImagePaths,
    uploadImage,
    retryImageUpload,
    loadAttachmentBytes,
    viewImageOriginal,
    downloadImage,
    resizeImage,
    removeImage
  };
}
