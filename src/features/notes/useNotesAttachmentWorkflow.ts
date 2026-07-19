import { useCallback, useRef, useState } from "react";
import type { NoteId, NotesStore } from "../../domain/notes";
import type { NotesWorkspaceCoordinatorSession } from "./notesWorkspaceCoordinator";
import type { NotesWorkspaceSessionRecord } from "./notesDraftEngine";
import type { NotesHistoryOwnerRegistry } from "./notesHistory";
import {
  attachmentUploadAttempts,
  finalizeAttachmentUploadAttempt,
  notifyImageImportRecoveryFor,
  recoveredAttachmentUploadAttempts,
  releaseAttachmentUploadRecovery,
  releaseImageImportReservation,
  retainAttachmentUploadAttemptForRecovery,
  retainedAttachmentUploadByteAttempts,
  type AttachmentUploadAttempt
} from "./notesImageImportRecovery";

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
