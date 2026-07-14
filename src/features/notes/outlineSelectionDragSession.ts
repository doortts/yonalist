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

export interface StartOutlineSelectionDragSessionInput<
  FrozenContext extends object
> {
  readonly activeId: NoteId;
  readonly selectedNodeIds: readonly NoteId[];
  readonly rows: readonly FlattenedOutlineRow[];
  readonly order: OutlineSiblingOrder;
  /** Opaque router ownership captured for the lifetime of this drag. */
  readonly frozenContext: FrozenContext;
}

export interface OrdinaryOutlineDragSession {
  readonly kind: "ordinary";
  readonly activeId: NoteId;
}

export interface ReadyOutlineSelectionDragSession<
  FrozenContext extends object
> {
  readonly kind: "selected-ready";
  readonly prepared: PreparedOutlineSelectionDrag;
  readonly frozenContext: Readonly<FrozenContext>;
}

export interface InvalidOutlineSelectionDragSession {
  readonly kind: "selected-invalid";
  readonly reason: OutlineSelectionDropInvalidReason;
}

export type SelectedOutlineDragSession<FrozenContext extends object> =
  | ReadyOutlineSelectionDragSession<FrozenContext>
  | InvalidOutlineSelectionDragSession;

export type OutlineSelectionDragSession<FrozenContext extends object> =
  | OrdinaryOutlineDragSession
  | SelectedOutlineDragSession<FrozenContext>;

export interface OutlineSelectionDragMove<FrozenContext extends object> {
  readonly kind: "selected-move";
  readonly target: Readonly<NotesSelectionMoveTarget>;
  readonly expandNodeId?: NoteId;
  readonly frozenContext: Readonly<FrozenContext>;
}

export type OutlineSelectionDragProjection<FrozenContext extends object> =
  | OutlineSelectionDragMove<FrozenContext>
  | InvalidOutlineSelectionDragSession;

function invalidSelectionDrag(
  reason: OutlineSelectionDropInvalidReason
): InvalidOutlineSelectionDragSession {
  return Object.freeze({ kind: "selected-invalid", reason });
}

/**
 * Captures whether this drag belongs to the live materialized range. Once the
 * active row is selected, every preparation failure remains a selected no-op;
 * callers cannot reinterpret it as an ordinary single-row drag.
 */
export function startOutlineSelectionDragSession<
  FrozenContext extends object
>(
  input: StartOutlineSelectionDragSessionInput<FrozenContext>
): OutlineSelectionDragSession<FrozenContext> {
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

  return Object.freeze({
    kind: "selected-ready",
    prepared,
    // Router ownership is already an immutable authority snapshot. Freezing
    // its outer identity prevents a caller from retargeting this drag later
    // without traversing or copying the potentially large workspace payload.
    frozenContext: Object.freeze(input.frozenContext)
  });
}

/**
 * Projects only a selected session. The ordinary state is deliberately not a
 * valid input, so integration code must branch before considering a single-row
 * move. Invalid selected sessions remain explicit no-ops.
 */
export function projectOutlineSelectionDragSession<
  FrozenContext extends object
>(
  session: SelectedOutlineDragSession<FrozenContext>,
  overId: NoteId,
  horizontalOffset: number,
  indentPx?: number
): OutlineSelectionDragProjection<FrozenContext> {
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
