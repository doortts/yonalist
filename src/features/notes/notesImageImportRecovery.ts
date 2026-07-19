import {
  MAX_NOTE_ATTACHMENT_BATCH_BYTES,
  MAX_NOTE_ATTACHMENT_BYTES,
  MAX_NOTE_IMAGE_NODE_IMPORT_BATCH_ITEMS
} from "../../domain/notes";
import type {
  ImportImageNodeByteItem,
  ImportImageNodePathItem,
  NoteId,
  NotesHistoryContext,
  NotesStore,
  NotesWorkspaceScope,
  PendingImageNodeByteItem
} from "../../domain/notes";
import {
  notesWorkspaceCoordinatorRegistry,
  type NotesWorkspaceCoordinatorSession,
  type NotesWorkspaceImageImportReservation
} from "./notesWorkspaceCoordinator";
import type { NotesHistorySnapshot } from "./notesHistory";
import type { NotesWorkspaceSessionRecord } from "./notesDraftEngine";
import { resetNotesDataDeletionRegistryForTests } from "./notesDataDeletionRegistry";
import type { ImageNodeInsertionAnchor } from "./imageNodeInsertion";
import { releaseOwnedHistorySnapshot } from "./notesWorkspaceNavigationSupport";

export type ImageNodeImportRequest =
  | {
      readonly kind: "paths";
      readonly anchor: ImageNodeInsertionAnchor;
      readonly items: readonly ImportImageNodePathItem[];
    }
  | {
      readonly kind: "bytes";
      readonly anchor: ImageNodeInsertionAnchor;
      readonly items: readonly ImportImageNodeByteItem[];
    };

interface ImageImportOrderingTurn {
  wait(): Promise<void>;
  release(): void;
}

interface ImageImportRecoveryOwner {
  readonly repository: NotesStore;
  readonly vaultRoot: string;
  readonly session: NotesWorkspaceCoordinatorSession;
  readonly attempts: Map<string, AttachmentUploadAttempt>;
}

export interface AttachmentUploadAttempt {
  readonly attemptId: string;
  readonly order: number;
  readonly nodeId: NoteId;
  readonly request: ImageNodeImportRequest;
  readonly retainedByteSize: number;
  scope: NotesWorkspaceScope;
  readonly initialMaxDisplayWidth: number;
  readonly historyContext: NotesHistoryContext | null;
  historyLocation: NotesHistorySnapshot | null;
  record: NotesWorkspaceSessionRecord;
  readonly orderingTurn: ImageImportOrderingTurn;
  reservation: NotesWorkspaceImageImportReservation | null;
  recoveryOwner: ImageImportRecoveryOwner | null;
  effectiveAnchor: ImageNodeInsertionAnchor | null;
  structuralIntent:
    | NotesWorkspaceSessionRecord["structuralIntents"][number]
    | null;
  enqueueCompletionSettled: boolean;
  detached: boolean;
  started: boolean;
  unknownOutcome: boolean;
  status: "pending" | "failed";
  error: string | null;
}

interface ImageImportOrderingSequence {
  tail: Promise<void>;
  pendingTurns: number;
}

// Structural imports can outlive the hook that created them. Keep their byte
// ownership shared until the retained coordinator closure actually finalizes.
export const retainedAttachmentUploadByteAttempts =
  new Set<AttachmentUploadAttempt>();
export const attachmentUploadAttempts = new Set<AttachmentUploadAttempt>();
const imageImportRecoveryOwners = new WeakMap<
  NotesStore,
  Map<string, ImageImportRecoveryOwner>
>();
const imageImportRecoverySubscribers = new WeakMap<
  NotesStore,
  Map<string, Set<() => void>>
>();
const imageImportOrderingSequences = new WeakMap<
  NotesStore,
  Map<string, Map<string, ImageImportOrderingSequence>>
>();

export function reserveImageImportOrderingTurn(
  repository: NotesStore,
  vaultRoot: string,
  anchor: ImageNodeInsertionAnchor
): ImageImportOrderingTurn {
  let vaults = imageImportOrderingSequences.get(repository);
  if (!vaults) {
    vaults = new Map();
    imageImportOrderingSequences.set(repository, vaults);
  }
  let sequences = vaults.get(vaultRoot);
  if (!sequences) {
    sequences = new Map();
    vaults.set(vaultRoot, sequences);
  }
  const key = JSON.stringify([anchor.parentId, anchor.afterId]);
  let sequence = sequences.get(key);
  if (!sequence) {
    sequence = { tail: Promise.resolve(), pendingTurns: 0 };
    sequences.set(key, sequence);
  }

  const predecessor = sequence.tail;
  let resolveTurn!: () => void;
  const completion = new Promise<void>((resolve) => {
    resolveTurn = resolve;
  });
  // A turn can be canceled before it reaches the head of the sequence. Its
  // successors must still wait for the unresolved predecessor, even when the
  // canceled turn has already released its own resources.
  sequence.tail = predecessor.then(() => completion);
  sequence.pendingTurns += 1;
  let released = false;

  return {
    wait(): Promise<void> {
      return predecessor;
    },
    release(): void {
      if (released) return;
      released = true;
      sequence!.pendingTurns = Math.max(0, sequence!.pendingTurns - 1);
      resolveTurn();
      if (sequence!.pendingTurns === 0 && sequences!.get(key) === sequence) {
        sequences!.delete(key);
        if (sequences!.size === 0) vaults!.delete(vaultRoot);
      }
    }
  };
}

export function releaseImageImportReservation(
  attempt: AttachmentUploadAttempt
): void {
  attempt.reservation?.release();
  attempt.reservation = null;
  attempt.orderingTurn.release();
}

function recoveryOwnerFor(
  repository: NotesStore,
  vaultRoot: string,
  create: boolean
): ImageImportRecoveryOwner | null {
  let vaults = imageImportRecoveryOwners.get(repository);
  let owner = vaults?.get(vaultRoot) ?? null;
  if (owner || !create) return owner;
  if (!vaults) {
    vaults = new Map();
    imageImportRecoveryOwners.set(repository, vaults);
  }
  owner = {
    repository,
    vaultRoot,
    session: notesWorkspaceCoordinatorRegistry.openSession({
      repository,
      vaultRoot,
      presentation: "background",
      onEvent() {
        // The recovery session keeps coordinator history and insertion
        // reservations alive. A mounted hook remains the UI event owner.
      }
    }),
    attempts: new Map()
  };
  vaults.set(vaultRoot, owner);
  return owner;
}

export function notifyImageImportRecoveryFor(
  repository: NotesStore,
  vaultRoot: string
): void {
  const subscribers = imageImportRecoverySubscribers
    .get(repository)
    ?.get(vaultRoot);
  for (const subscriber of subscribers ?? []) subscriber();
}

export function notifyImageImportRecovery(
  owner: ImageImportRecoveryOwner
): void {
  notifyImageImportRecoveryFor(owner.repository, owner.vaultRoot);
}

export function retainAttachmentUploadAttemptForRecovery(
  attempt: AttachmentUploadAttempt
): void {
  if (attempt.recoveryOwner) {
    notifyImageImportRecovery(attempt.recoveryOwner);
    return;
  }
  const owner = recoveryOwnerFor(
    attempt.record.repository,
    attempt.record.vaultRoot,
    true
  )!;
  attempt.recoveryOwner = owner;
  owner.attempts.set(attempt.attemptId, attempt);
  notifyImageImportRecovery(owner);
}

export function releaseAttachmentUploadRecovery(
  attempt: AttachmentUploadAttempt
): void {
  const owner = attempt.recoveryOwner;
  if (!owner) return;
  owner.attempts.delete(attempt.attemptId);
  notifyImageImportRecovery(owner);
  attempt.recoveryOwner = null;
  if (owner.attempts.size > 0) return;
  owner.session.close();
  const vaults = imageImportRecoveryOwners.get(owner.repository);
  if (vaults?.get(owner.vaultRoot) === owner) {
    vaults.delete(owner.vaultRoot);
    if (vaults.size === 0) imageImportRecoveryOwners.delete(owner.repository);
  }
}

export function finalizeAttachmentUploadAttempt(
  attempt: AttachmentUploadAttempt
): void {
  if (attempt.historyLocation) {
    releaseOwnedHistorySnapshot(attempt.historyLocation);
    attempt.historyLocation = null;
  }
  releaseImageImportReservation(attempt);
  retainedAttachmentUploadByteAttempts.delete(attempt);
  attachmentUploadAttempts.delete(attempt);
  releaseAttachmentUploadRecovery(attempt);
}

export function recoveredAttachmentUploadAttempts(
  repository: NotesStore,
  vaultRoot: string
): readonly AttachmentUploadAttempt[] {
  return [
    ...(recoveryOwnerFor(repository, vaultRoot, false)?.attempts.values() ?? [])
  ];
}

export function subscribeToImageImportRecovery(
  repository: NotesStore,
  vaultRoot: string,
  subscriber: () => void
): () => void {
  let vaults = imageImportRecoverySubscribers.get(repository);
  if (!vaults) {
    vaults = new Map();
    imageImportRecoverySubscribers.set(repository, vaults);
  }
  let subscribers = vaults.get(vaultRoot);
  if (!subscribers) {
    subscribers = new Set();
    vaults.set(vaultRoot, subscribers);
  }
  subscribers.add(subscriber);
  return () => {
    subscribers!.delete(subscriber);
    if (subscribers!.size === 0 && vaults!.get(vaultRoot) === subscribers) {
      vaults!.delete(vaultRoot);
      if (vaults!.size === 0) imageImportRecoverySubscribers.delete(repository);
    }
  };
}

/** Clears module recovery state between deterministic hook tests only. */
export function resetImageImportRecoveryForTests(): void {
  for (const attempt of [...attachmentUploadAttempts]) {
    attempt.detached = true;
    finalizeAttachmentUploadAttempt(attempt);
  }
  resetNotesDataDeletionRegistryForTests();
}

export function clipboardImageBatchByteSize(
  items: readonly PendingImageNodeByteItem[]
): number | null {
  if (
    items.length === 0 ||
    items.length > MAX_NOTE_IMAGE_NODE_IMPORT_BATCH_ITEMS
  ) {
    return null;
  }

  let aggregateBytes = 0;
  for (let index = 0; index < items.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(items, index)) return null;
    const byteSize = items[index]?.blob.size;
    if (
      !Number.isSafeInteger(byteSize) ||
      byteSize <= 0 ||
      byteSize > MAX_NOTE_ATTACHMENT_BYTES
    ) {
      return null;
    }
    aggregateBytes += byteSize;
    if (aggregateBytes > MAX_NOTE_ATTACHMENT_BATCH_BYTES) return null;
  }
  return aggregateBytes;
}
