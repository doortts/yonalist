# Notes Pointer-Anchored Drop Boundary Design

**Status:** Approved for implementation

## Goal

During every pointer-driven Notes drag, derive the insertion line from the
actual pointer position rather than from the center of the dragged row or drag
overlay. The line shown during the drag and the destination used on pointer-up
must represent the same structural insertion boundary for both one-row and
multi-row moves.

This design supersedes the pointer-collision rules in
`2026-07-17-notes-multiselect-drop-preview-design.md`. Its authority and batch
mutation safeguards remain unchanged.

## Confirmed Failure

The current `detectOutlineCollisions()` filters selected rows and then calls
dnd-kit's `closestCenter`. `closestCenter` compares droppable row centers with
the center of the translated draggable rectangle. It does not use the pointer
coordinate even when `pointerCoordinates` is available.

In the running development app, dragging two selected child rows with the
pointer on the following child resolved the parent row as `over`. The insertion
line therefore described the parent boundary and releasing the pointer moved
the selection out to the root. The preview renderer and outline projection were
faithfully displaying and committing the wrong collision target.

Filtering the selected forest also creates a second problem: while the pointer
is over a selected row or the gap occupied by selected rows, the nearest
remaining row may be selected by draggable-rectangle distance, so the preview
can jump away from the pointer or disappear.

## Selected Approach

Introduce one pointer-to-boundary resolver and use its result for both visual
projection and drop execution.

A pointer boundary is the vertical insertion slot before one remaining visible
row, or the tail slot after the final remaining row. The resolver:

1. reads dnd-kit's real `pointerCoordinates`;
2. removes the dragged row subtree, or every subtree in the selected forest,
   from destination geometry;
3. orders the remaining measured rows by the rendered outline order;
4. compares the pointer Y coordinate with row midpoints; and
5. resolves the nearest insertion slot as `beforeId` or the list tail.

If every movable row belongs to the dragged forest, the resolver returns the
sole original/tail slot. That slot renders a no-op preview rather than leaving
the drag without an insertion line.

The pointer X delta continues to select the requested indentation depth. The
existing outline depth, parent, zoom-root, collapsed-parent, and sibling
validation rules remain authoritative.

No CSS offset, extra insertion-line component, dependency, or backend change is
needed.

## Projection Contract

The outline projection layer will expose a boundary-based pointer projection in
addition to the existing row-over projection used by keyboard drag.

The common projection core accepts an insertion index in the outline with the
dragged subtree removed. Both entry points delegate to that core:

- keyboard/legacy row-over projection converts `overId` and move direction to
  an insertion index;
- pointer projection converts `beforeId` (or tail) directly to an insertion
  index.

The pointer result distinguishes a valid no-op boundary from an invalid
boundary. A valid no-op still produces an insertion preview at the original
slot, but pointer-up performs no mutation. Invalid hierarchy or authority still
clears/rejects the move as it does today.

For a prepared multi-selection, the existing immutable prepared geometry is
reused. The selected forest is removed once, the active structural root remains
the projection surrogate, and the final command still contains all normalized
selected structural roots.

## Runtime Data Flow

```text
pointer movement
  -> dnd-kit pointerCoordinates
  -> pointer boundary resolver over non-dragged measured rows
  -> boundary-based outline projection + horizontal depth projection
  -> existing OutlineDropPreview renderer

pointer-up
  -> reuse the latest pointer boundary
  -> re-project against the frozen authoritative selected geometry
  -> valid move: existing moveNode/applyBatch path
  -> valid original slot: no mutation
  -> stale/invalid authority: existing rejection path
```

The latest boundary belongs to the active drag attempt and is cleared at drag
start, cancellation, rejection, and completion so a later drag cannot reuse
stale pointer state.

## Input-Specific Behavior

### Pointer drag

- Use actual pointer coordinates for one-row and multi-row drags.
- Resolve positions above the first row, between rows, within the currently
  dragged rows' rendered area, and below the final row.
- Always render the nearest valid insertion boundary once a pointer drag is
  active, including the original no-op slot.
- Keep preview and committed destination identical.

### Keyboard drag

- Retain the existing `closestCenter` and arrow-key row-over semantics.
- Do not require pointer coordinates.
- Preserve current accessibility announcements and keyboard tests.

## Authority and Mutation Safety

- Pending selected-drag preview remains read-only and may not authorize a move.
- Pointer-up still requires the frozen authority captured for the same drag
  attempt, selection revision, workspace generation, and structural root set.
- The final selected target is projected again through the authoritative
  prepared geometry.
- A selected drag never falls back to a one-row move.
- One multi-row drop remains one semantic reorder and one `applyBatch` call.

## Testing

Follow strict RED/GREEN coverage.

1. Unit-test pointer boundary resolution above, within, between, and below
   measured rows, including a gap produced by excluded selected rows.
2. Unit-test boundary projection before a row, at the tail, at nested depths,
   and at the original valid no-op slot.
3. Add a rendered one-row regression proving the insertion line follows the
   pointer rather than the dragged rectangle center.
4. Replace the current selected-row snapping expectation with a regression in
   which the pointer on an exact external row produces that row's boundary.
5. Add a multi-row regression for a pointer within the selected block: the
   original boundary remains visible and pointer-up performs no batch move.
6. Assert the preview's structural target and the eventual `moveNode` or
   `applyBatch` target agree.
7. Preserve pending-authority, rejected-authority, cancellation, nested,
   collapsed, zoomed, and keyboard drag coverage.
8. Run focused Notes tests, the full frontend suite, lint, production build,
   and `git diff --check`, then verify the scenario in the running Tauri app.

## Rejected Alternatives

### Replace `closestCenter` with `pointerWithin`

This fixes the demonstrated external-row collision but returns no collision in
row gaps or over filtered selected rows. It cannot satisfy the requirement to
show a pointer-based insertion line throughout the drag.

### Keep `closestCenter` and adjust the drag overlay rectangle

Synthetic overlay sizing remains indirect and varies with selected row count,
row height, scrolling, and nesting. The pointer can still disagree with the
chosen row.

### Move only the CSS insertion line

A visual-only offset would leave the committed target unchanged, recreating
the dangerous mismatch between preview and actual move.

## Out of Scope

- Changes to Notes selection semantics or the selected-row overlay artwork.
- Changes to native image drop markers.
- Changes to Keychain behavior, persistence, history, or database schema.
- New drag-and-drop dependencies.
