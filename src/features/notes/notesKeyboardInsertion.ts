import type {
  NoteId,
  NoteNode,
  NotesHistoryContext,
  NotesWorkspaceScope
} from "../../domain/notes";
import type { NotesHistoryPrimarySelection } from "./notesHistory";
import {
  deriveOutlineGuideMetadata,
  type FlattenedOutlineRow
} from "./outlineTree";

export type KeyboardInsertionKind = "split" | "first-child";

export type KeyboardInsertionPostcondition =
  | {
      readonly kind: "split";
      readonly expectedSourceTitle: string;
      readonly expectedInsertedTitle: string;
    }
  | {
      readonly kind: "first-child";
      readonly expectedParentId: NoteId;
      readonly expectedIndex: 0;
      readonly expectedInsertedTitle: "";
    };

export interface KeyboardInsertionIntent {
  readonly token: number;
  readonly ownerSessionGeneration: number;
  readonly sourceId: NoteId;
  readonly expectedNodeId: NoteId;
  readonly postcondition: KeyboardInsertionPostcondition;
}

export interface PendingKeyboardInsertion {
  readonly intent: KeyboardInsertionIntent;
  readonly ownerSessionId: string;
  readonly ownerPaneId: string;
  readonly interactionEpochAtDispatch: number;
  readonly expectedStructuralHistoryEpoch: string;
  readonly expectedStructuralHistoryEntryId: string;
  readonly projectionGenerationAtDispatch: number;
  readonly layoutGenerationAtDispatch: number;
  readonly paneSnapshotAtDispatch: OutlinePanePublicationSnapshot;
  readonly dragGenerationAtDispatch: number;
}

export type OptimisticKeyboardInsertionStatus =
  | "prepared"
  | "queued"
  | "running"
  | "checking"
  | "settled";

export interface OptimisticKeyboardInsertionCheckpoint {
  readonly sourceNode: NoteNode;
  readonly sourceRow: FlattenedOutlineRow;
  readonly sourceSelection: NotesHistoryPrimarySelection;
}

export interface OptimisticKeyboardInsertion {
  readonly pending: PendingKeyboardInsertion;
  readonly historyContext: NotesHistoryContext;
  readonly dependencyId: NoteId | null;
  readonly checkpoint: OptimisticKeyboardInsertionCheckpoint;
  readonly sourceTitle: string;
  readonly insertedTitle: string;
  readonly status: OptimisticKeyboardInsertionStatus;
  readonly focusAcknowledged: boolean;
  readonly undoRequested: boolean;
}

export interface OptimisticInsertionFailure {
  readonly insertion: OptimisticKeyboardInsertion;
  readonly message: string;
  readonly recoveryText: string;
  readonly retryable: boolean;
}

export interface OptimisticInsertionSnapshot {
  readonly insertions: readonly OptimisticKeyboardInsertion[];
  readonly failure: OptimisticInsertionFailure | null;
}

export interface OptimisticOutlineProjection {
  readonly rows: readonly FlattenedOutlineRow[];
  readonly nodeOverrides: ReadonlyMap<NoteId, NoteNode>;
}

export interface KeyboardInsertionSettlement {
  readonly intentToken: number;
  readonly expectedNodeId: NoteId;
  readonly ownerSessionId: string;
  readonly ownerPaneId: string;
  readonly ownerSessionGeneration: number;
  readonly interactionEpochAtDispatch: number;
  readonly baseProjectionGeneration: number;
  readonly acceptedProjectionGeneration: number;
  readonly baseLayoutGeneration: number;
  readonly acceptedLayoutGeneration: number;
  readonly authorityOutcome:
    | "postconditionAccepted"
    | "ownedButSuperseded"
    | "mismatch";
  readonly focusEligible: boolean;
}

export type KeyboardInsertionDisposition =
  | {
      readonly kind: "exact";
      readonly pending: PendingKeyboardInsertion;
      readonly settlement: KeyboardInsertionSettlement;
    }
  | {
      readonly kind: "mixed";
      readonly pending: PendingKeyboardInsertion;
      readonly settlement: KeyboardInsertionSettlement;
    }
  | {
      readonly kind: "mismatch";
      readonly pending: PendingKeyboardInsertion;
      readonly settlement: KeyboardInsertionSettlement;
    }
  | { readonly kind: "unrelated" };

export type NotesProjectionPublicationOwner =
  | { readonly kind: "keyboard-insertion"; readonly intentToken: number }
  | { readonly kind: "keyboard-draft"; readonly intentToken: number }
  | { readonly kind: "other" };

export interface OutlinePanePublicationSnapshot {
  readonly paneId: string;
  readonly sessionId: string;
  readonly scope: NotesWorkspaceScope;
  readonly zoomedNodeId: NoteId | null;
  readonly showCompleted: boolean;
  readonly collapsedNodeIds: ReadonlySet<NoteId>;
  readonly locallyExpandedNodeIds: ReadonlySet<NoteId>;
  readonly interactionEpoch: number;
  readonly visibleSignature: string;
  readonly geometryGeneration: number;
  readonly activeDrag: boolean;
}

export interface KeyboardInsertionRegistry {
  register(pending: PendingKeyboardInsertion): boolean;
  get(expectedNodeId: NoteId): PendingKeyboardInsertion | undefined;
  consume(
    expectedNodeId: NoteId,
    intentToken: number
  ): PendingKeyboardInsertion | null;
  cancel(
    expectedNodeId: NoteId,
    intentToken: number
  ): PendingKeyboardInsertion | null;
  transfer(
    expectedNodeId: NoteId,
    intentToken: number
  ): PendingKeyboardInsertion | null;
  cancelForPane(
    ownerSessionId: string,
    ownerPaneId: string
  ): PendingKeyboardInsertion[];
  cancelForSession(ownerSessionId: string): PendingKeyboardInsertion[];
  clear(): PendingKeyboardInsertion[];
  size(): number;
}

export function createKeyboardInsertionRegistry(): KeyboardInsertionRegistry {
  const entries = new Map<NoteId, PendingKeyboardInsertion>();

  const take = (
    expectedNodeId: NoteId,
    intentToken: number
  ): PendingKeyboardInsertion | null => {
    const entry = entries.get(expectedNodeId);
    if (!entry || entry.intent.token !== intentToken) return null;
    entries.delete(expectedNodeId);
    return entry;
  };

  const cancelWhere = (
    predicate: (entry: PendingKeyboardInsertion) => boolean
  ): PendingKeyboardInsertion[] => {
    const cancelled: PendingKeyboardInsertion[] = [];
    for (const [expectedNodeId, entry] of entries) {
      if (!predicate(entry)) continue;
      entries.delete(expectedNodeId);
      cancelled.push(entry);
    }
    return cancelled;
  };

  return {
    register(pending) {
      const expectedNodeId = pending.intent.expectedNodeId;
      if (entries.has(expectedNodeId)) return false;
      entries.set(expectedNodeId, pending);
      return true;
    },
    get: (expectedNodeId) => entries.get(expectedNodeId),
    consume: take,
    cancel: take,
    transfer: take,
    cancelForPane: (ownerSessionId, ownerPaneId) =>
      cancelWhere(
        (entry) =>
          entry.ownerSessionId === ownerSessionId &&
          entry.ownerPaneId === ownerPaneId
      ),
    cancelForSession: (ownerSessionId) =>
      cancelWhere((entry) => entry.ownerSessionId === ownerSessionId),
    clear() {
      const cancelled = [...entries.values()];
      entries.clear();
      return cancelled;
    },
    size: () => entries.size
  };
}

function sameNumbers(
  left: readonly number[],
  right: readonly number[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function projectOptimisticKeyboardInsertions(
  rows: readonly FlattenedOutlineRow[],
  nodesById: Readonly<Record<NoteId, NoteNode>>,
  insertions: readonly OptimisticKeyboardInsertion[]
): OptimisticOutlineProjection {
  if (insertions.length === 0) {
    return { rows, nodeOverrides: new Map() };
  }

  const projectedRows = [...rows];
  const nodeOverrides = new Map<NoteId, NoteNode>();

  for (const insertion of insertions) {
    const expectedNodeId = insertion.pending.intent.expectedNodeId;
    if (
      nodesById[expectedNodeId] ||
      projectedRows.some((row) => row.id === expectedNodeId)
    ) {
      continue;
    }

    const sourceId = insertion.pending.intent.sourceId;
    const sourceIndex = projectedRows.findIndex((row) => row.id === sourceId);
    if (sourceIndex < 0) continue;

    const sourceRow = projectedRows[sourceIndex];
    const sourceNode =
      nodeOverrides.get(sourceId) ??
      nodesById[sourceId] ??
      insertion.checkpoint.sourceNode;
    if (!sourceNode) continue;

    const firstChild =
      insertion.pending.intent.postcondition.kind === "first-child";
    const insertedRow: FlattenedOutlineRow = {
      id: expectedNodeId,
      parentId: firstChild ? sourceId : sourceRow.parentId,
      depth: sourceRow.depth + (firstChild ? 1 : 0),
      isCollapsed: false,
      ancestorIds: firstChild
        ? [...sourceRow.ancestorIds, sourceId]
        : sourceRow.ancestorIds,
      ancestorGuideDepths: [],
      visibleDescendantEndId: null
    };
    const insertedNode: NoteNode = {
      ...sourceNode,
      id: expectedNodeId,
      nodeKind: "text",
      markerKind: "bullet",
      parentId: insertedRow.parentId,
      title: insertion.insertedTitle,
      note: "",
      imageOffsetUtf16: 0,
      markdownImageWidth: null,
      isCollapsed: false,
      isStarred: false,
      completedAt: null,
      deletedAt: null,
      archivedAt: null,
      archiveRootId: null
    };

    if (firstChild) {
      if (sourceRow.isCollapsed) {
        projectedRows[sourceIndex] = { ...sourceRow, isCollapsed: false };
      }
      if (
        sourceNode.isCollapsed ||
        sourceNode.title !== insertion.sourceTitle
      ) {
        nodeOverrides.set(sourceId, {
          ...sourceNode,
          title: insertion.sourceTitle,
          isCollapsed: false
        });
      }
      projectedRows.splice(sourceIndex + 1, 0, insertedRow);
    } else {
      nodeOverrides.set(sourceId, {
        ...sourceNode,
        title: insertion.sourceTitle
      });
      const descendantEndIndex =
        sourceRow.visibleDescendantEndId === null
          ? sourceIndex
          : projectedRows.findIndex(
              (row) => row.id === sourceRow.visibleDescendantEndId
            );
      projectedRows.splice(
        Math.max(sourceIndex, descendantEndIndex) + 1,
        0,
        insertedRow
      );
    }
    nodeOverrides.set(expectedNodeId, insertedNode);
  }

  if (nodeOverrides.size === 0) {
    return { rows, nodeOverrides };
  }

  const guideMetadata = deriveOutlineGuideMetadata(projectedRows);
  return {
    rows: projectedRows.map((row, index) => {
      const guides = guideMetadata[index];
      return row.visibleDescendantEndId === guides.visibleDescendantEndId &&
        sameNumbers(row.ancestorGuideDepths, guides.ancestorGuideDepths)
        ? row
        : { ...row, ...guides };
    }),
    nodeOverrides
  };
}

export function dependentOptimisticInsertionIds(
  insertions: readonly OptimisticKeyboardInsertion[],
  failedNodeId: NoteId
): readonly NoteId[] {
  const affected = new Set<NoteId>([failedNodeId]);
  let previousSize = 0;
  while (affected.size !== previousSize) {
    previousSize = affected.size;
    for (const insertion of insertions) {
      if (
        insertion.dependencyId !== null &&
        affected.has(insertion.dependencyId)
      ) {
        affected.add(insertion.pending.intent.expectedNodeId);
      }
    }
  }
  return insertions
    .map((insertion) => insertion.pending.intent.expectedNodeId)
    .filter((expectedNodeId) => affected.has(expectedNodeId));
}

export function optimisticInsertionRecoveryText(
  insertion: Pick<OptimisticKeyboardInsertion, "sourceTitle" | "insertedTitle">
): string {
  return `${insertion.sourceTitle}\n${insertion.insertedTitle}`;
}

type VisibleRowSignatureEntry = readonly [
  id: NoteId,
  parentId: NoteId | null,
  depth: number,
  isCollapsed: boolean
];

export function createOutlineVisibleSignature(
  rows: readonly FlattenedOutlineRow[]
): string {
  return JSON.stringify(
    rows.map<VisibleRowSignatureEntry>((row) => [
      row.id,
      row.parentId,
      row.depth,
      row.isCollapsed
    ])
  );
}

function parseOutlineVisibleSignature(
  signature: string
): VisibleRowSignatureEntry[] | null {
  let value: unknown;
  try {
    value = JSON.parse(signature);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;

  const entries: VisibleRowSignatureEntry[] = [];
  for (const item of value) {
    if (
      !Array.isArray(item) ||
      item.length !== 4 ||
      typeof item[0] !== "string" ||
      (item[1] !== null && typeof item[1] !== "string") ||
      typeof item[2] !== "number" ||
      !Number.isInteger(item[2]) ||
      item[2] < 0 ||
      typeof item[3] !== "boolean"
    ) {
      return null;
    }
    entries.push([
      item[0] as NoteId,
      item[1] as NoteId | null,
      item[2],
      item[3]
    ]);
  }
  return entries;
}

function withoutFocus(
  settlement: KeyboardInsertionSettlement
): KeyboardInsertionSettlement {
  return settlement.focusEligible
    ? { ...settlement, focusEligible: false }
    : settlement;
}

function settlementIdentityMatchesPending(
  pending: PendingKeyboardInsertion,
  settlement: KeyboardInsertionSettlement,
  pane: OutlinePanePublicationSnapshot
): boolean {
  return (
    settlement.intentToken === pending.intent.token &&
    settlement.expectedNodeId === pending.intent.expectedNodeId &&
    settlement.ownerSessionId === pending.ownerSessionId &&
    settlement.ownerPaneId === pending.ownerPaneId &&
    settlement.ownerSessionGeneration ===
      pending.intent.ownerSessionGeneration &&
    settlement.interactionEpochAtDispatch ===
      pending.interactionEpochAtDispatch &&
    pane.sessionId === pending.ownerSessionId &&
    pane.paneId === pending.ownerPaneId
  );
}

function settlementGenerationsAreValid(
  pending: PendingKeyboardInsertion,
  settlement: KeyboardInsertionSettlement
): boolean {
  return (
    settlement.baseProjectionGeneration ===
      pending.projectionGenerationAtDispatch &&
    settlement.baseLayoutGeneration === pending.layoutGenerationAtDispatch &&
    settlement.acceptedProjectionGeneration >=
      settlement.baseProjectionGeneration &&
    settlement.acceptedLayoutGeneration >= settlement.baseLayoutGeneration
  );
}

function hasCurrentInsertionRelationship(
  pending: PendingKeyboardInsertion,
  rows: readonly FlattenedOutlineRow[]
): boolean {
  const expectedId = pending.intent.expectedNodeId;
  const expectedRows = rows.filter((row) => row.id === expectedId);
  if (expectedRows.length !== 1) return false;
  const expected = expectedRows[0];
  const postcondition = pending.intent.postcondition;

  if (postcondition.kind === "first-child") {
    const parent = rows.find((row) => row.id === postcondition.expectedParentId);
    if (
      !parent ||
      expected.parentId !== postcondition.expectedParentId ||
      expected.depth !== parent.depth + 1
    ) {
      return false;
    }
    const directChildren = rows.filter(
      (row) => row.parentId === postcondition.expectedParentId
    );
    return directChildren[postcondition.expectedIndex]?.id === expectedId;
  }

  const source = rows.find((row) => row.id === pending.intent.sourceId);
  if (
    !source ||
    expected.parentId !== source.parentId ||
    expected.depth !== source.depth
  ) {
    return false;
  }
  const siblings = rows.filter((row) => row.parentId === source.parentId);
  const sourceIndex = siblings.findIndex((row) => row.id === source.id);
  return sourceIndex >= 0 && siblings[sourceIndex + 1]?.id === expectedId;
}

function hasOnlyPermittedVisibleDiff(
  pending: PendingKeyboardInsertion,
  previousEntries: readonly VisibleRowSignatureEntry[],
  acceptedRows: readonly FlattenedOutlineRow[]
): boolean {
  const expectedId = pending.intent.expectedNodeId;
  if (
    previousEntries.some(([id]) => id === expectedId) ||
    acceptedRows.length !== previousEntries.length + 1
  ) {
    return false;
  }

  const acceptedById = new Map<NoteId, FlattenedOutlineRow>();
  for (const row of acceptedRows) {
    if (acceptedById.has(row.id)) return false;
    acceptedById.set(row.id, row);
  }

  const previousIds = previousEntries.map(([id]) => id);
  const retainedIds = acceptedRows
    .filter((row) => row.id !== expectedId)
    .map((row) => row.id);
  if (
    retainedIds.length !== previousIds.length ||
    retainedIds.some((id, index) => id !== previousIds[index])
  ) {
    return false;
  }

  for (const [id, parentId, depth, isCollapsed] of previousEntries) {
    const accepted = acceptedById.get(id);
    if (!accepted) return false;
    const permitsContextualExpansion =
      pending.intent.postcondition.kind === "first-child" &&
      id === pending.intent.postcondition.expectedParentId &&
      isCollapsed &&
      !accepted.isCollapsed;
    if (
      accepted.parentId !== parentId ||
      accepted.depth !== depth ||
      (accepted.isCollapsed !== isCollapsed && !permitsContextualExpansion)
    ) {
      return false;
    }
  }

  return true;
}

export function classifyKeyboardInsertionPublication(input: {
  readonly pending: PendingKeyboardInsertion;
  readonly settlement: KeyboardInsertionSettlement;
  readonly previousPane: OutlinePanePublicationSnapshot;
  readonly acceptedPane: OutlinePanePublicationSnapshot;
  readonly acceptedVisibleRows: readonly FlattenedOutlineRow[];
  readonly acceptedDragGeneration: number;
  readonly publicationOwners: readonly NotesProjectionPublicationOwner[];
}): KeyboardInsertionDisposition {
  const {
    pending,
    settlement,
    previousPane,
    acceptedPane,
    publicationOwners
  } = input;
  const mismatch = (): KeyboardInsertionDisposition => ({
    kind: "mismatch",
    pending,
    settlement: withoutFocus(settlement)
  });

  if (
    !settlementIdentityMatchesPending(pending, settlement, previousPane)
  ) {
    return { kind: "unrelated" };
  }

  if (settlement.authorityOutcome === "ownedButSuperseded") {
    return {
      kind: "mixed",
      pending,
      settlement: withoutFocus(settlement)
    };
  }

  if (!settlementGenerationsAreValid(pending, settlement)) {
    return mismatch();
  }

  if (settlement.authorityOutcome === "mismatch") {
    return mismatch();
  }

  const ownedStructuralPublicationCount = publicationOwners.filter(
    (owner) =>
      owner.kind === "keyboard-insertion" &&
      owner.intentToken === pending.intent.token
  ).length;
  if (ownedStructuralPublicationCount === 0) {
    return { kind: "unrelated" };
  }

  if (
    !hasCurrentInsertionRelationship(pending, input.acceptedVisibleRows)
  ) {
    return mismatch();
  }

  const normalizedSettlement =
    acceptedPane.interactionEpoch === pending.interactionEpochAtDispatch
      ? settlement
      : withoutFocus(settlement);
  const previousEntries = parseOutlineVisibleSignature(
    previousPane.visibleSignature
  );
  const hasInterleavedOwner = publicationOwners.some(
    (owner) =>
      owner.kind === "other" ||
      owner.intentToken !== pending.intent.token
  ) ||
    ownedStructuralPublicationCount !== 1 ||
    publicationOwners.at(-1)?.kind !== "keyboard-insertion";
  const hasPermittedVisibleDiff =
    previousEntries !== null &&
    hasOnlyPermittedVisibleDiff(
      pending,
      previousEntries,
      input.acceptedVisibleRows
    );

  return {
    kind:
      previousPane.activeDrag ||
      acceptedPane.activeDrag ||
      acceptedPane.geometryGeneration !== previousPane.geometryGeneration ||
      input.acceptedDragGeneration !== pending.dragGenerationAtDispatch ||
      hasInterleavedOwner ||
      !hasPermittedVisibleDiff
        ? "mixed"
        : "exact",
    pending,
    settlement: normalizedSettlement
  };
}
