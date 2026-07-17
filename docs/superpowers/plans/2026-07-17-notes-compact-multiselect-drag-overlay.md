# Notes Compact Multi-Selection Drag Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the multi-title Notes selection drag overlay with a compact source-first title card, numeric count badge, and two-sheet stacked visual.

**Architecture:** Keep the existing `DragOverlay` lifecycle and source-ordered `draggedNodeLabels` data flow. Narrow only the presentation component to its first label and implement the stack entirely with the existing markup plus CSS pseudo-elements, leaving selection, projection, insertion-line, and move behavior untouched.

**Tech Stack:** React 19, TypeScript 6, CSS, dnd-kit, Vitest, Testing Library

## Global Constraints

- Render the overlay only for multi-row drags; single-row drag behavior remains unchanged.
- Always show the first selected row in source order, regardless of which selected row starts the drag.
- Show only a numeric full-selection count.
- Use two compact, unrotated, offset backing sheets and existing theme tokens.
- Preserve `Untitled` for an empty first presentation label.
- Do not change collision detection, drop projection, insertion-line placement, move normalization, or selection authority checks.
- Add no dependency.

---

## File Structure

- Modify `src/features/notes/NotesSelectionDragPreview.tsx`: render one representative label and the numeric badge.
- Modify `src/features/notes/notes.css`: turn the existing preview into a compact stacked card using pseudo-elements.
- Modify `src/features/notes/NotesSelectionDragPreview.test.tsx`: lock the one-title and number-only component contract.
- Modify `src/features/notes/NotesWorkspace.test.tsx`: prove a drag started from the middle still previews only the source-first row.

### Task 1: Compact multi-selection drag preview

**Files:**
- Modify: `src/features/notes/NotesSelectionDragPreview.test.tsx:5-27`
- Modify: `src/features/notes/NotesWorkspace.test.tsx:4643-4747`
- Modify: `src/features/notes/NotesSelectionDragPreview.tsx:1-27`
- Modify: `src/features/notes/notes.css:1141-1176`

**Interfaces:**
- Consumes: `labels: readonly string[]` in source order and `total: number` from `NotesOutlinePane`.
- Produces: the existing `notes-selection-drag-preview` test target containing exactly one title row and one numeric count badge.

- [x] **Step 1: Write the failing component test**

Replace the first component test with the one-title contract while keeping the existing `Untitled` test:

```tsx
it("shows only the first title and the full selected count", () => {
  render(
    <NotesSelectionDragPreview
      labels={["Alpha", "Bravo", "Charlie", "Delta"]}
      total={4}
    />
  );

  const preview = screen.getByTestId("notes-selection-drag-preview");
  expect(preview).toHaveAttribute("aria-hidden", "true");
  expect(screen.getByText("Alpha")).toBeInTheDocument();
  expect(screen.queryByText("Bravo")).not.toBeInTheDocument();
  expect(screen.queryByText("Charlie")).not.toBeInTheDocument();
  expect(screen.queryByText("Delta")).not.toBeInTheDocument();
  expect(screen.getByText("4")).toHaveClass(
    "notes-selection-drag-preview-count"
  );
  expect(screen.queryByText("4 selected")).not.toBeInTheDocument();
});
```

- [x] **Step 2: Strengthen the rendered workspace regression test**

In `moves five selected sibling roots as one pointer-dragged block from a middle bullet`, replace the current preview assertions with:

```tsx
expect(selectionDragPreview).toHaveTextContent("Alpha");
expect(selectionDragPreview).not.toHaveTextContent("Bravo");
expect(selectionDragPreview).not.toHaveTextContent("Charlie");
expect(selectionDragPreview).not.toHaveTextContent("Delta");
expect(within(selectionDragPreview).getByText("5")).toHaveClass(
  "notes-selection-drag-preview-count"
);
expect(selectionDragPreview).not.toHaveTextContent("5 selected");
```

This test already starts the drag from the middle selected row, `Charlie`, so
the assertion proves the preview remains anchored to source-first `Alpha`.

- [x] **Step 3: Run the focused tests to verify RED**

Run:

```bash
npm test -- src/features/notes/NotesSelectionDragPreview.test.tsx src/features/notes/NotesWorkspace.test.tsx -t "first title|moves five selected sibling roots"
```

Expected: FAIL because the component still renders `Bravo` and `Charlie` and
still renders the text `4 selected` / `5 selected`.

- [x] **Step 4: Implement the minimal one-title component behavior**

Replace the preview body with:

```tsx
export function NotesSelectionDragPreview({
  labels,
  total
}: {
  labels: readonly string[];
  total: number;
}) {
  return (
    <div
      className="notes-selection-drag-preview"
      data-testid="notes-selection-drag-preview"
      aria-hidden="true"
    >
      <div className="notes-selection-drag-preview-stack">
        <div className="notes-selection-drag-preview-row">
          {labels[0] || "Untitled"}
        </div>
      </div>
      <span className="notes-selection-drag-preview-count">{total}</span>
    </div>
  );
}
```

Do not change `NotesOutlinePane`: `draggedNodeLabels` is already derived from
source-ordered `draggedNodeIds`, so `labels[0]` is the agreed representative.

- [x] **Step 5: Run the focused tests to verify behavior GREEN**

Run:

```bash
npm test -- src/features/notes/NotesSelectionDragPreview.test.tsx src/features/notes/NotesWorkspace.test.tsx -t "first title|moves five selected sibling roots"
```

Expected: PASS for the component contract, source-first integration behavior,
full count, existing batch move, and overlay cleanup after drop.

- [x] **Step 6: Implement the compact stacked-card styling**

Replace the four existing preview style rules with:

```css
.notes-selection-drag-preview {
  position: relative;
  min-width: 196px;
  max-width: min(280px, calc(100vw - 36px));
  padding: 0 10px 10px 0;
  color: var(--text-1);
  pointer-events: none;
}

.notes-selection-drag-preview-stack {
  position: relative;
  isolation: isolate;
}

.notes-selection-drag-preview-stack::before,
.notes-selection-drag-preview-stack::after {
  position: absolute;
  inset: 0;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-card);
  content: "";
}

.notes-selection-drag-preview-stack::before {
  z-index: -1;
  transform: translate(5px, 5px);
}

.notes-selection-drag-preview-stack::after {
  z-index: -2;
  opacity: 0.82;
  transform: translate(9px, 9px);
}

.notes-selection-drag-preview-row {
  position: relative;
  z-index: 1;
  min-width: 0;
  padding: 7px 28px 7px 27px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-card);
  box-shadow: 0 5px 14px rgb(0 0 0 / 18%);
  font-size: 13px;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.notes-selection-drag-preview-row::before {
  position: absolute;
  inset-block-start: 50%;
  inset-inline-start: 11px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-3);
  content: "";
  transform: translateY(-50%);
}

.notes-selection-drag-preview-count {
  position: absolute;
  z-index: 2;
  inset-block-start: -7px;
  inset-inline-end: 2px;
  display: grid;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border: 1px solid var(--bg-card);
  border-radius: 999px;
  place-items: center;
  background: var(--accent);
  color: var(--accent-contrast);
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
}
```

- [x] **Step 7: Run focused and full automated verification**

Run:

```bash
npm test -- src/features/notes/NotesSelectionDragPreview.test.tsx
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "moves five selected sibling roots"
npm test
npm run lint
npm run build
git diff --check
```

Expected: all tests pass, lint reports no errors, TypeScript and Vite production
build succeed, and `git diff --check` prints no output.

- [x] **Step 8: Verify the running development UI**

In the running app, select at least five Notes rows, begin dragging from a middle
selected row, and move the pointer above and below an unselected destination.
Verify all of the following:

- only the first selected title follows the pointer;
- two orderly backing sheets and the numeric badge convey the full selection;
- the compact overlay does not cover the insertion line at the pointer target;
- the insertion line updates on both sides of the destination;
- dropping still moves the full selection as one block.

- [x] **Step 9: Commit the implementation**

```bash
git add src/features/notes/NotesSelectionDragPreview.tsx \
  src/features/notes/NotesSelectionDragPreview.test.tsx \
  src/features/notes/NotesWorkspace.test.tsx \
  src/features/notes/notes.css \
  docs/superpowers/plans/2026-07-17-notes-compact-multiselect-drag-overlay.md
git commit -m "fix(notes): compact selection drag preview"
```
