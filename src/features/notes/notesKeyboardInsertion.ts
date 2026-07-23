import type { NoteId, NotesWorkspaceScope } from "../../domain/notes";
import type { FlattenedOutlineRow } from "./outlineTree";

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
  readonly acceptedVisibleRows: readonly FlattenedOutlineRow[];
  /** Task 3 must supply the geometry generation for the accepted Pane projection. */
  readonly acceptedGeometryGeneration: number;
  readonly publicationOwners: readonly NotesProjectionPublicationOwner[];
}): KeyboardInsertionDisposition {
  const { pending, settlement, previousPane, publicationOwners } = input;
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
    previousPane.interactionEpoch === pending.interactionEpochAtDispatch
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
      input.acceptedGeometryGeneration !== previousPane.geometryGeneration ||
      hasInterleavedOwner ||
      !hasPermittedVisibleDiff
        ? "mixed"
        : "exact",
    pending,
    settlement: normalizedSettlement
  };
}
