import type { NoteId } from "../../domain/notes";
import {
  prepareOutlineSelectionDrag,
  projectPreparedOutlineSelectionDrop,
  type OutlineSelectionDropInvalidReason,
  type OutlineSiblingOrder,
  type PreparedOutlineSelectionDrag
} from "./outlineDrag";
import type { NotesSelectionMoveTarget } from "./notesSelectionActions";
import type { FlattenedOutlineRow } from "./outlineTree";
import type { NotesFrozenSelectionCommandContext } from "./useNotesSelectionCommandRouter";
import type { NotesPreparedSelectionAuthority } from "./useNotesWorkspace";

export type OutlineSelectionDragFrozenContext =
  NotesFrozenSelectionCommandContext<NotesPreparedSelectionAuthority>;

export interface StartOutlineSelectionDragSessionInput {
  readonly activeId: NoteId;
  readonly selectedNodeIds: readonly NoteId[];
  readonly rows: readonly FlattenedOutlineRow[];
  readonly order: OutlineSiblingOrder;
  /** Router ownership for the exact structural roots being dragged. */
  readonly frozenContext: OutlineSelectionDragFrozenContext;
}

export interface OrdinaryOutlineDragSession {
  readonly kind: "ordinary";
  readonly activeId: NoteId;
}

export interface ReadyOutlineSelectionDragSession {
  readonly kind: "selected-ready";
  readonly prepared: PreparedOutlineSelectionDrag;
  readonly frozenContext: OutlineSelectionDragFrozenContext;
}

export type OutlineSelectionDragInvalidReason =
  | OutlineSelectionDropInvalidReason
  | "selection-authority-mismatch";

export interface InvalidOutlineSelectionDragSession {
  readonly kind: "selected-invalid";
  readonly reason: OutlineSelectionDragInvalidReason;
}

export type SelectedOutlineDragSession =
  | ReadyOutlineSelectionDragSession
  | InvalidOutlineSelectionDragSession;

export type OutlineSelectionDragSession =
  | OrdinaryOutlineDragSession
  | SelectedOutlineDragSession;

export interface OutlineSelectionDragMove {
  readonly kind: "selected-move";
  readonly target: Readonly<NotesSelectionMoveTarget>;
  readonly expandNodeId?: NoteId;
  readonly frozenContext: OutlineSelectionDragFrozenContext;
}

export type OutlineSelectionDragProjection =
  | OutlineSelectionDragMove
  | InvalidOutlineSelectionDragSession;

function invalidSelectionDrag(
  reason: OutlineSelectionDragInvalidReason
): InvalidOutlineSelectionDragSession {
  return Object.freeze({ kind: "selected-invalid", reason });
}

function exactNodeIds(
  left: readonly NoteId[],
  right: readonly NoteId[]
): boolean {
  return (
    left.length === right.length &&
    left.every((nodeId, index) => nodeId === right[index])
  );
}

function captureFrozenContext(
  context: OutlineSelectionDragFrozenContext
): OutlineSelectionDragFrozenContext {
  return Object.freeze({
    nodeIds: Object.freeze([...context.nodeIds]),
    ownership: Object.freeze({
      // `deriveNotesSelectionActionSnapshot` freezes the snapshot graph used by
      // commands, and `prepareSelectionAuthority` deeply freezes its authority
      // workspace. This session owns only the shell and the node-id copy.
      actionSnapshot: context.ownership.actionSnapshot,
      authority: context.ownership.authority
    })
  });
}

/**
 * Captures whether this drag belongs to the live materialized range. Once the
 * active row is selected, every preparation failure remains a selected no-op;
 * callers cannot reinterpret it as an ordinary single-row drag.
 */
export function startOutlineSelectionDragSession(
  input: StartOutlineSelectionDragSessionInput
): OutlineSelectionDragSession {
  if (!input.selectedNodeIds.includes(input.activeId)) {
    return Object.freeze({ kind: "ordinary", activeId: input.activeId });
  }

  const prepared = prepareOutlineSelectionDrag(
    input.activeId,
    input.selectedNodeIds,
    input.rows,
    input.order
  );
  if (prepared.kind === "invalid") {
    return invalidSelectionDrag(prepared.reason);
  }

  const context = input.frozenContext;
  if (
    !exactNodeIds(prepared.nodeIds, context.nodeIds) ||
    !exactNodeIds(
      prepared.nodeIds,
      context.ownership.authority.selectedNodeIds
    ) ||
    !exactNodeIds(
      prepared.nodeIds,
      context.ownership.actionSnapshot.structuralRootIds
    )
  ) {
    return invalidSelectionDrag("selection-authority-mismatch");
  }

  return Object.freeze({
    kind: "selected-ready",
    prepared,
    frozenContext: captureFrozenContext(context)
  });
}

/**
 * Projects only a selected session. The ordinary state is deliberately not a
 * valid input, so integration code must branch before considering a single-row
 * move. Invalid selected sessions remain explicit no-ops.
 */
export function projectOutlineSelectionDragSession(
  session: SelectedOutlineDragSession,
  overId: NoteId,
  horizontalOffset: number,
  indentPx?: number
): OutlineSelectionDragProjection {
  if (session.kind === "selected-invalid") {
    return invalidSelectionDrag(session.reason);
  }

  const result = projectPreparedOutlineSelectionDrop(
    session.prepared,
    overId,
    horizontalOffset,
    indentPx
  );
  if (result.kind === "invalid") {
    return invalidSelectionDrag(result.reason);
  }

  const { expandNodeId, ...target } = result.projection;
  return Object.freeze({
    kind: "selected-move",
    target: Object.freeze(target),
    ...(expandNodeId === undefined ? {} : { expandNodeId }),
    frozenContext: session.frozenContext
  });
}
