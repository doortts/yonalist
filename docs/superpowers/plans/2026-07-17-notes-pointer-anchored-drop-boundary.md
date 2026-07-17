# Notes Pointer-Anchored Drop Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every pointer-driven Notes insertion line and committed drop target follow the actual pointer boundary for both one-row and multi-row drags.

**Architecture:** Add a pure pointer-to-boundary resolver over measured non-dragged rows. Refactor outline projection so pointer input can project an explicit `beforeId` boundary, including a valid no-op result, while keyboard input keeps its row-over projection. Store the current pointer boundary for the active drag attempt and reuse it for preview and pointer-up authority validation.

**Tech Stack:** React 19, TypeScript 6, dnd-kit 6, Vitest 4, Testing Library

## Global Constraints

- Use actual pointer coordinates for one-row and multi-row pointer drags.
- Show the nearest valid insertion boundary above, within, between, and below rows, including the original no-op slot.
- The preview and committed target must use the same boundary projection.
- Keep keyboard drag row-over semantics unchanged.
- Preserve frozen authority, selection revision, workspace generation, attempt epoch, and one-batch selected mutation safeguards.
- Add no dependency, CSS-only target correction, backend command, or schema change.
- Work on `main` and create one final commit after all verification, per user request.

---

## File Structure

- Create `src/features/notes/outlinePointerDrop.ts`: pure measured-row midpoint resolver returning `beforeId` and a real row ID for dnd-kit collision metadata.
- Create `src/features/notes/outlinePointerDrop.test.ts`: unit coverage for pointer positions and gaps left by removed rows.
- Modify `src/features/notes/outlineDrag.ts`: share insertion-index projection and add explicit-boundary projection with valid no-op metadata.
- Modify `src/features/notes/outlineDrag.test.ts`: cover move, tail, nested depth, invalid boundary, and no-op boundary semantics.
- Modify `src/features/notes/NotesOutlinePane.tsx`: capture pointer boundaries during collision detection, project them for preview/drop, and retain keyboard behavior.
- Modify `src/features/notes/NotesWorkspace.test.tsx`: prove exact external-row targeting, selected-area no-op preview, and preview/command parity.
- Modify the approved spec and this plan only for status/checklist updates discovered during implementation.

### Task 1: Resolve Pointer Coordinates to an Outline Boundary

**Files:**
- Create: `src/features/notes/outlinePointerDrop.ts`
- Create: `src/features/notes/outlinePointerDrop.test.ts`

**Interfaces:**
- Consumes: viewport-space pointer Y and rendered non-dragged row rectangles.
- Produces: `resolveOutlinePointerBoundary(pointerY, rows): OutlinePointerBoundary`, where `beforeId` is the semantic insertion anchor and `overId` is an existing droppable row for dnd-kit.

- [x] **Step 1: Write the failing resolver tests**

```ts
import { describe, expect, it } from "vitest";
import { resolveOutlinePointerBoundary } from "./outlinePointerDrop";

const rows = [
  { id: "a", top: 0, bottom: 28 },
  { id: "c", top: 56, bottom: 84 },
  { id: "d", top: 84, bottom: 112 }
] as const;

describe("resolveOutlinePointerBoundary", () => {
  it.each([
    [-10, { beforeId: "a", overId: "a" }],
    [10, { beforeId: "a", overId: "a" }],
    [42, { beforeId: "c", overId: "c" }],
    [70, { beforeId: "d", overId: "d" }],
    [120, { beforeId: null, overId: "d" }]
  ])("resolves pointer y %s", (pointerY, expected) => {
    expect(resolveOutlinePointerBoundary(pointerY, rows)).toEqual(expected);
  });

  it("returns the sole tail slot when every row is dragged", () => {
    expect(resolveOutlinePointerBoundary(20, [])).toEqual({
      beforeId: null,
      overId: null
    });
  });
});
```

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
npx vitest run src/features/notes/outlinePointerDrop.test.ts
```

Expected: FAIL because `outlinePointerDrop.ts` does not exist.

- [x] **Step 3: Implement the minimal pure resolver**

```ts
import type { NoteId } from "../../domain/notes";

export interface OutlinePointerRowRect {
  readonly id: NoteId;
  readonly top: number;
  readonly bottom: number;
}

export interface OutlinePointerBoundary {
  readonly beforeId: NoteId | null;
  readonly overId: NoteId | null;
}

export function resolveOutlinePointerBoundary(
  pointerY: number,
  rows: readonly OutlinePointerRowRect[]
): OutlinePointerBoundary {
  const before = rows.find(
    (row) => pointerY < row.top + (row.bottom - row.top) / 2
  );
  if (before) {
    return { beforeId: before.id, overId: before.id };
  }
  return {
    beforeId: null,
    overId: rows.at(-1)?.id ?? null
  };
}
```

- [x] **Step 4: Run the resolver tests and verify GREEN**

Run:

```bash
npx vitest run src/features/notes/outlinePointerDrop.test.ts
```

Expected: PASS.

### Task 2: Project an Explicit Boundary, Including a Valid No-Op

**Files:**
- Modify: `src/features/notes/outlineDrag.ts:285-415, 550-635`
- Test: `src/features/notes/outlineDrag.test.ts`

**Interfaces:**
- Produces: `OutlineBoundaryDropResult = { projection: OutlineDropProjection; noOp: boolean }`.
- Produces: `projectOutlineDropAtBoundary(activeId, beforeId, horizontalOffset, rows, order, indentPx?)`.
- Produces: `projectPreparedOutlineSelectionDropAtBoundary(prepared, beforeId, horizontalOffset, indentPx?)`, retaining selected-root normalization and adding `noOp` to valid boundary results.
- Preserves: existing `projectOutlineDrop()` and `projectPreparedOutlineSelectionDrop()` return contracts.

- [x] **Step 1: Write failing explicit-boundary projection tests**

Add tests proving:

```ts
const original = projectOutlineDropAtBoundary(
  "a",
  "c",
  0,
  rows,
  order
);
expect(original).toEqual({
  projection: { parentId: null, afterId: null, beforeId: "c" },
  noOp: true
});

const moved = projectOutlineDropAtBoundary(
  "a",
  "d",
  0,
  rows,
  order
);
expect(moved).toEqual({
  projection: { parentId: null, afterId: "c" },
  noOp: false
});

const tail = projectOutlineDropAtBoundary(
  "a",
  null,
  0,
  rows,
  order
);
expect(tail).toEqual({
  projection: { parentId: null, afterId: "d" },
  noOp: false
});
```

Add a prepared selection test for selected roots `a,b` with `beforeId: "c"` that returns a valid `noOp: true` result and derives a line before `c`. Add a nested boundary test showing horizontal offset still clamps to the same parent/depth rules. Add an unknown `beforeId` test returning `null` or `invalid-geometry` as appropriate.

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run src/features/notes/outlineDrag.test.ts
```

Expected: FAIL because the explicit-boundary exports do not exist.

- [x] **Step 3: Extract the shared insertion projection**

Refactor the existing body after active-subtree removal into a private helper that accepts the already-computed `insertionIndex` and returns both projection and no-op state:

```ts
export interface OutlineBoundaryDropResult {
  readonly projection: OutlineDropProjection;
  readonly noOp: boolean;
}

function projectOutlineInsertion(
  active: FlattenedOutlineRow,
  insertionIndex: number,
  horizontalOffset: number,
  remaining: readonly FlattenedOutlineRow[],
  rows: readonly FlattenedOutlineRow[],
  order: OutlineSiblingOrder,
  indentPx: number
): OutlineBoundaryDropResult | null {
  // Existing min/max depth, parent, collapsed-parent, and sibling logic.
  return { projection, noOp: isNoOp(active, projection, order) };
}
```

Keep `projectOutlineDrop()` behavior by returning `null` for `result.noOp` and
`result.projection` otherwise.

- [x] **Step 4: Add the explicit-boundary entry point**

```ts
export function projectOutlineDropAtBoundary(
  activeId: NoteId,
  beforeId: NoteId | null,
  horizontalOffset: number,
  rows: readonly FlattenedOutlineRow[],
  order: OutlineSiblingOrder,
  indentPx = OUTLINE_INDENT_PX
): OutlineBoundaryDropResult | null {
  // Validate row shape/zoom/active, remove the active subtree, translate
  // beforeId to an insertion index (tail when null), then delegate to
  // projectOutlineInsertion().
}
```

The selected counterpart calls this function with its prepared geometry,
rejects any forest-owned anchors, preserves parent/anchor forest validation,
and returns `{ kind: "valid", nodeIds, projection, noOp }`.

- [x] **Step 5: Run outline projection tests and verify GREEN**

Run:

```bash
npx vitest run src/features/notes/outlineDrag.test.ts
```

Expected: PASS with existing row-over tests unchanged.

### Task 3: Use the Pointer Boundary for Preview and Drop

**Files:**
- Modify: `src/features/notes/NotesOutlinePane.tsx:1-110, 165-205, 720-770, 2080-2185, 2240-2605`
- Test: `src/features/notes/NotesWorkspace.test.tsx:4120-4660`

**Interfaces:**
- Consumes: `resolveOutlinePointerBoundary`, `projectOutlineDropAtBoundary`, and `projectPreparedOutlineSelectionDropAtBoundary`.
- Produces: an active-attempt ref `{ activeId, beforeId }` populated only for pointer collision passes and cleared for keyboard/cancel/end/new attempts.
- Adds pane-only `ordinary-preview` for a valid ordinary no-op. Reuses `selected-preview` for pending or ready selected no-op projection.

- [x] **Step 1: Write failing rendered pointer regressions**

Update the pending selected preview test so the pointer is on the actual
external `Charlie` row (`clientY: 70`) and still expects the line before
`Delta` and one eventual batch after `Charlie`.

Add a selected-area no-op test:

```ts
await user.pointer({
  keys: "[MouseLeft>]",
  target: alpha,
  coords: { clientX: 9, clientY: 14 }
});
await user.pointer({
  target: bravo,
  coords: { clientX: 9, clientY: 42 }
});

expect(document.querySelector(".notes-outline-drop-preview")).toHaveAttribute(
  "data-before-id",
  "c"
);

await user.pointer({
  keys: "[/MouseLeft]",
  target: bravo,
  coords: { clientX: 9, clientY: 42 }
});
// Resolve pending authority if this fixture defers it.
expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();
expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
```

Add or adapt a nested multi-row test matching the manual reproduction: dragging
two selected children with the pointer on the following child must render that
child boundary and must not target/move to the parent/root.

- [x] **Step 2: Run the focused rendered tests and verify RED**

Run:

```bash
npx vitest run src/features/notes/NotesWorkspace.test.tsx -t "selected drop line|pointer boundary|selected block"
```

Expected: at least one FAIL because `closestCenter` still uses the translated draggable rectangle and the selected-area no-op has no preview.

- [x] **Step 3: Resolve and store the pointer boundary in collision detection**

For pointer collisions, build measured rows in `structuralRows` order, excluding
the ordinary active subtree or the prepared selected forest. Resolve with
`args.pointerCoordinates.y`, store `{ activeId, beforeId }`, and return one
collision for `boundary.overId` by filtering `droppableContainers` before
calling `closestCenter`. When no real row remains, keep the stored tail boundary
and allow an empty collision list. For `pointerCoordinates === null`, clear the
ref and call the existing `closestCenter(args)` unchanged.

- [x] **Step 4: Project the stored boundary for pointer move/end**

In `projectDrag()`:

```ts
const pointerBoundary =
  pointerDropBoundaryRef.current?.activeId === activeId
    ? pointerDropBoundaryRef.current
    : null;
```

Use explicit-boundary projection when that ref exists. Ordinary no-op returns
`ordinary-preview`; selected pending/no-op returns `selected-preview`; a ready
selected move is converted to the existing `selected-move` with its frozen
context. Without a pointer boundary, retain the existing `event.over` keyboard
path.

Derive `DropPreviewLine` for `ordinary-preview` exactly as for
`ordinary-move`. On pointer-up, return without mutation for ordinary/selected
no-op. Capture the boundary before clearing refs so a pending selected drop can
re-project the same `beforeId` after authority resolves.

- [x] **Step 5: Clear attempt-owned pointer state on every terminal path**

Clear the pointer boundary at drag start, invalid start, cancel, rejection, and
end. Preserve the captured local value only inside the existing pending
authority promise. Do not let a later drag consume it; keep the existing
attempt-epoch and selection-revision checks.

- [x] **Step 6: Run focused Notes tests and verify GREEN**

Run:

```bash
npx vitest run src/features/notes/outlinePointerDrop.test.ts src/features/notes/outlineDrag.test.ts src/features/notes/outlineSelectionDragSession.test.ts src/features/notes/NotesWorkspace.test.tsx
```

Expected: PASS.

### Task 4: Verify the Complete Change and Commit Once

**Files:**
- Verify all changed source, tests, spec, and plan files.

**Interfaces:**
- Produces: one verified commit on `main`.

- [x] **Step 1: Run static and frontend verification**

```bash
npm test -- --run
npm run lint
npm run build
git diff --check
```

Expected: all commands exit 0.

- [x] **Step 2: Verify in the running Tauri development app**

Using the isolated temporary vault, select two sibling rows and drag across:

1. the selected block;
2. the next unselected sibling;
3. a nested parent/child boundary; and
4. the list tail.

Expected: the insertion line follows the actual pointer boundary, the original
slot is a visible no-op, and pointer-up moves the entire selection to exactly
the previewed destination.

- [x] **Step 3: Inspect the final diff and repository status**

```bash
git diff --stat
git diff -- src/features/notes/outlinePointerDrop.ts src/features/notes/outlineDrag.ts src/features/notes/NotesOutlinePane.tsx
git status --short --branch
```

Expected: only task-related files are modified/untracked; branch is `main`.

- [x] **Step 4: Create the requested final commit**

```bash
git add docs/superpowers/specs/2026-07-17-notes-pointer-anchored-drop-boundary-design.md docs/superpowers/plans/2026-07-17-notes-pointer-anchored-drop-boundary.md src/features/notes/outlinePointerDrop.ts src/features/notes/outlinePointerDrop.test.ts src/features/notes/outlineDrag.ts src/features/notes/outlineDrag.test.ts src/features/notes/NotesOutlinePane.tsx src/features/notes/NotesWorkspace.test.tsx
git commit -m "fix(notes): anchor drop preview to pointer"
```

Expected: commit succeeds and the worktree is clean.
