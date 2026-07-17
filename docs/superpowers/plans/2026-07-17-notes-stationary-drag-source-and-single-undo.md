# Notes Stationary Drag Source and Single-Undo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the complete Notes drag source visually fixed, show the compact full-forest preview 16 px below-right of the pointer, and make the first existing Undo shortcut work from the focused bullet after drop.

**Architecture:** Reuse `prepareOutlineSelectionDrag()` as the single source of truth for structural roots and the complete descendant forest. Keep dnd-kit collision and move projection unchanged, suppress sortable transforms for every visible row, and render one overlay from a pane-owned immutable presentation snapshot. Route Notes history shortcuts at the bullet activator before forwarding other keys to dnd-kit; repository history remains unchanged.

**Tech Stack:** React 19, TypeScript 6, dnd-kit 6/10, Vitest 4, Testing Library, existing Notes workspace/history APIs.

## Global Constraints

- Work directly on `main`, as explicitly requested by the user.
- Preserve the current compact stacked-card preview and upper-right badge.
- Count every unique moved node, including collapsed descendants.
- Keep visible source nodes in their original DOM positions without fading or reflow.
- Keep collision and insertion-line projection on actual pointer coordinates.
- Keep keyboard drag's row-relative overlay and Space/arrow/Escape behavior.
- Use existing Notes Undo/Redo; add no button, history entry, dependency, or global key listener.
- Keep ordinary moves as one `move` entry and selected moves as one `batch` entry.
- Add no history for cancelled, rejected, invalid, or original-position drops.
- Follow RED/GREEN TDD and commit each completed task separately.

## File Map

- `src/features/notes/outlineDrag.ts`: expose the immutable, ordered full forest already captured by prepared geometry.
- `src/features/notes/outlineDrag.test.ts`: verify order, collapsed descendants, deduplication, and immutability.
- `src/features/notes/notesDragOverlay.ts`: contain the dependency-free dnd-kit overlay modifier.
- `src/features/notes/notesDragOverlay.test.ts`: verify pointer math and keyboard pass-through.
- `src/features/notes/NotesOutlinePane.tsx`: own presentation state, mark source rows, suppress transforms, and render every overlay.
- `src/features/notes/NotesWorkspace.test.tsx`: cover source forests, hidden counts, stationary rows, cleanup, and drop semantics.
- `src/features/notes/notes.css`: replace faded selected-source styling with a source highlight.
- `src/features/notes/OutlineNodeRow.tsx`: compose Notes history and dnd-kit bullet key handling.
- `src/features/notes/outlineRowMemo.test.tsx`: reproduce the focused-bullet Undo gap and guard drag keys.
- `src/features/notes/useNotesWorkspace.test.tsx`: remain unchanged; existing tests prove atomic move replay.

---

### Task 1: Expose the Frozen Full Drag Forest

**Files:**
- Modify: `src/features/notes/outlineDrag.ts:566-624`
- Modify: `src/features/notes/outlineDrag.test.ts:1-12, 924-1027`

**Interfaces:**
- Consumes: `PreparedOutlineSelectionDrag` from `prepareOutlineSelectionDrag()`.
- Produces: `preparedOutlineSelectionDragForestNodeIds(prepared): readonly NoteId[]` in source-tree order, including hidden descendants and no duplicates.

- [ ] **Step 1: Write the failing forest-accessor test**

Import the new accessor and append:

```ts
it("exposes one frozen source-ordered forest including collapsed descendants", () => {
  const state = normalizeWorkspace({
    nodes: [
      node({ id: "parent", sortKey: 1 }),
      node({ id: "visible-child", parentId: "parent", isCollapsed: true }),
      node({ id: "hidden-grandchild", parentId: "visible-child" }),
      node({ id: "second", sortKey: 2 }),
      node({ id: "second-child", parentId: "second" }),
      node({ id: "target", sortKey: 3 })
    ]
  } satisfies NotesWorkspace);
  const prepared = prepareOutlineSelectionDrag(
    "visible-child",
    ["visible-child", "parent", "second"],
    flattenVisibleOutlineRows(state, null),
    {
      rootIds: state.rootIds,
      childIdsByParent: state.childIdsByParent,
      zoomRootId: null
    }
  );
  if (prepared.kind !== "ready") {
    throw new Error("Expected drag preparation to succeed.");
  }

  const forestNodeIds = preparedOutlineSelectionDragForestNodeIds(prepared);

  expect(prepared.nodeIds).toEqual(["parent", "second"]);
  expect(forestNodeIds).toEqual([
    "parent",
    "visible-child",
    "hidden-grandchild",
    "second",
    "second-child"
  ]);
  expect(Object.isFrozen(forestNodeIds)).toBe(true);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npm test -- --run src/features/notes/outlineDrag.test.ts -t "exposes one frozen source-ordered forest"
```

Expected: FAIL because the accessor is not exported.

- [ ] **Step 3: Store and expose the ordered forest without retraversing**

Extend the private state and add the accessor:

```ts
interface PreparedOutlineSelectionDragState {
  readonly activeRootId: NoteId;
  readonly forestNodeIds: ReadonlySet<NoteId>;
  readonly orderedForestNodeIds: readonly NoteId[];
  readonly geometryRows: readonly FlattenedOutlineRow[];
  readonly previewRows: readonly FlattenedOutlineRow[];
  readonly geometryOrder: OutlineSiblingOrder;
}

export function preparedOutlineSelectionDragForestNodeIds(
  prepared: PreparedOutlineSelectionDrag
): readonly NoteId[] {
  return (
    preparedSelectionDragStates.get(prepared)?.orderedForestNodeIds ??
    Object.freeze([] as NoteId[])
  );
}
```

Add the array when creating the WeakMap value:

```ts
preparedSelectionDragStates.set(prepared, {
  activeRootId: forest.activeRootId,
  forestNodeIds: forest.nodeIds,
  orderedForestNodeIds: Object.freeze([...forest.nodeIds]),
  geometryRows,
  previewRows,
  geometryOrder: selectionGeometryOrder(
    order,
    forest.nodeIds,
    forest.activeRootId
  )
});
```

Keep `preparedOutlineSelectionDragContainsNode()` on the existing `Set` for O(1) collision membership.

- [ ] **Step 4: Run the forest test file and verify GREEN**

```bash
npm test -- --run src/features/notes/outlineDrag.test.ts
```

Expected: all `outlineDrag` tests PASS.

- [ ] **Step 5: Commit the forest contract**

```bash
git add src/features/notes/outlineDrag.ts src/features/notes/outlineDrag.test.ts
git commit -m "feat(notes): expose prepared drag forest"
```

---

### Task 2: Offset the Overlay from Pointer Without Changing Projection

**Files:**
- Create: `src/features/notes/notesDragOverlay.ts`
- Create: `src/features/notes/notesDragOverlay.test.ts`

**Interfaces:**
- Consumes: dnd-kit `Modifier` arguments: `activatorEvent`, `activeNodeRect`, and `transform`.
- Produces: `offsetNotesDragOverlayFromPointer: Modifier` and `NOTES_DRAG_OVERLAY_MODIFIERS: Modifiers`.

- [ ] **Step 1: Write the failing modifier tests**

Create `src/features/notes/notesDragOverlay.test.ts`:

```ts
import type { Modifier } from "@dnd-kit/core";
import { describe, expect, it } from "vitest";
import { offsetNotesDragOverlayFromPointer } from "./notesDragOverlay";

function modifierArgs(activatorEvent: Event | null): Parameters<Modifier>[0] {
  return {
    activatorEvent,
    active: null,
    activeNodeRect: {
      width: 200,
      height: 28,
      top: 40,
      left: 120,
      right: 320,
      bottom: 68
    },
    draggingNodeRect: null,
    containerNodeRect: null,
    over: null,
    overlayNodeRect: null,
    scrollableAncestors: [],
    scrollableAncestorRects: [],
    transform: { x: 45, y: 30, scaleX: 1, scaleY: 1 },
    windowRect: null
  };
}

describe("offsetNotesDragOverlayFromPointer", () => {
  it("places the overlay top-left 16 px below-right of the current pointer", () => {
    const activation = new MouseEvent("pointerdown", {
      clientX: 130,
      clientY: 50
    });

    expect(offsetNotesDragOverlayFromPointer(modifierArgs(activation))).toEqual({
      x: 71,
      y: 56,
      scaleX: 1,
      scaleY: 1
    });
  });

  it("keeps keyboard overlay positioning unchanged", () => {
    expect(
      offsetNotesDragOverlayFromPointer(
        modifierArgs(new KeyboardEvent("keydown", { key: " " }))
      )
    ).toEqual({ x: 45, y: 30, scaleX: 1, scaleY: 1 });
  });
});
```

- [ ] **Step 2: Run the modifier tests and verify RED**

```bash
npm test -- --run src/features/notes/notesDragOverlay.test.ts
```

Expected: FAIL because `./notesDragOverlay` does not exist.

- [ ] **Step 3: Implement the local pointer modifier**

Create `src/features/notes/notesDragOverlay.ts`:

```ts
import type { Modifier, Modifiers } from "@dnd-kit/core";

export const NOTES_DRAG_OVERLAY_POINTER_GAP_PX = 16;

function pointerCoordinates(
  event: Event | null
): { readonly x: number; readonly y: number } | null {
  if (
    event === null ||
    !("clientX" in event) ||
    !("clientY" in event) ||
    typeof event.clientX !== "number" ||
    typeof event.clientY !== "number"
  ) {
    return null;
  }
  return { x: event.clientX, y: event.clientY };
}

export const offsetNotesDragOverlayFromPointer: Modifier = ({
  activatorEvent,
  activeNodeRect,
  transform
}) => {
  const activation = pointerCoordinates(activatorEvent);
  if (activation === null || activeNodeRect === null) {
    return transform;
  }
  return {
    ...transform,
    x:
      transform.x +
      activation.x -
      activeNodeRect.left +
      NOTES_DRAG_OVERLAY_POINTER_GAP_PX,
    y:
      transform.y +
      activation.y -
      activeNodeRect.top +
      NOTES_DRAG_OVERLAY_POINTER_GAP_PX
  };
};

export const NOTES_DRAG_OVERLAY_MODIFIERS: Modifiers = [
  offsetNotesDragOverlayFromPointer
];
```

This preserves dnd-kit's live delta, removes the initial pointer-to-row offset, and adds the fixed gap without affecting collision detection.

- [ ] **Step 4: Run the modifier tests and verify GREEN**

```bash
npm test -- --run src/features/notes/notesDragOverlay.test.ts
```

Expected: 2 tests PASS.

- [ ] **Step 5: Commit the overlay modifier**

```bash
git add src/features/notes/notesDragOverlay.ts src/features/notes/notesDragOverlay.test.ts
git commit -m "feat(notes): offset drag overlay from pointer"
```

---

### Task 3: Keep the Complete Source Forest Fixed and Render One Compact Overlay

**Files:**
- Modify: `src/features/notes/NotesOutlinePane.tsx:1-105, 503-516, 2292-2341, 2370-2552, 2616-2630, 2898-3016`
- Modify: `src/features/notes/NotesWorkspace.test.tsx:1800-2020, 4380-4965`
- Modify: `src/features/notes/notes.css:1132-1140`

**Interfaces:**
- Consumes: `preparedOutlineSelectionDragForestNodeIds()` from Task 1 and `NOTES_DRAG_OVERLAY_MODIFIERS` from Task 2.
- Produces: `NotesDragPresentationSnapshot`, whose roots select the label and whose full forest drives the badge and source rows.

- [ ] **Step 1: Write the ordinary-parent stationary-source regression**

Add this case near the existing ordinary pointer-drag tests:

```tsx
it("keeps an ordinary parent forest fixed and counts a collapsed descendant", async () => {
  const user = userEvent.setup();
  configureRepository([
    node({ id: "parent", sortKey: 1, title: "Parent" }),
    node({
      id: "child",
      parentId: "parent",
      sortKey: 1,
      title: "Child",
      isCollapsed: true
    }),
    node({ id: "hidden", parentId: "child", title: "Hidden" }),
    node({ id: "target", sortKey: 2, title: "Target" })
  ]);
  renderNotesWorkspace();
  const parent = await screen.findByRole("button", { name: "Zoom into Parent" });
  const target = screen.getByRole("button", { name: "Zoom into Target" });
  mockOutlineRowRects();

  await user.pointer({
    keys: "[MouseLeft>]",
    target: parent,
    coords: { clientX: 9, clientY: 14 }
  });
  await user.pointer({
    target,
    coords: { clientX: 14, clientY: 70 }
  });

  const preview = screen.getByTestId("notes-selection-drag-preview");
  expect(preview).toHaveTextContent("Parent");
  expect(within(preview).getByText("3")).toHaveClass(
    "notes-selection-drag-preview-count"
  );
  for (const nodeId of ["parent", "child"]) {
    expect(
      document
        .querySelector(`[data-outline-id="${nodeId}"]`)
        ?.closest(".notes-outline-item")
    ).toHaveAttribute("data-drag-source", "true");
  }
  expect(document.querySelector('[data-outline-id="hidden"]')).toBeNull();
  for (const row of document.querySelectorAll<HTMLElement>(".notes-node")) {
    expect(row.style.transform).toBe("");
    expect(row).not.toHaveAttribute("data-dragging");
  }

  await user.keyboard("[Escape]");

  expect(screen.queryByTestId("notes-selection-drag-preview")).toBeNull();
  expect(document.querySelector("[data-drag-source]")).toBeNull();
});
```

In the existing five-selected-roots case, change the preview badge from `5` to `6` because collapsed `c-child` also moves. Only the five visible roots receive `data-drag-source="true"`. Replace lifecycle assertions for `data-selection-dragging` with `data-drag-source` throughout the drag suite.

- [ ] **Step 2: Run the focused presentation tests and verify RED**

```bash
npm test -- --run src/features/notes/NotesWorkspace.test.tsx -t "keeps an ordinary parent forest fixed|moves five selected sibling roots|clears every selected source ghost"
```

Expected: FAIL because ordinary drag has no custom overlay, hidden descendants are not counted, source rows use faded selection-only state, and sortable transforms are not globally suppressed.

- [ ] **Step 3: Replace explicit selected IDs with one immutable visual snapshot**

Import the Task 1 accessor and Task 2 modifiers, then add:

```ts
interface NotesDragPresentationSnapshot {
  readonly rootIds: readonly NoteId[];
  readonly forestNodeIds: readonly NoteId[];
}

function notesDragPresentationSnapshot(
  prepared: PreparedOutlineSelectionDrag
): NotesDragPresentationSnapshot {
  return Object.freeze({
    rootIds: prepared.nodeIds,
    forestNodeIds: preparedOutlineSelectionDragForestNodeIds(prepared)
  });
}
```

Replace the current `draggedNodeIds` state and derivations with:

```ts
const [dragPresentation, setDragPresentation] =
  useState<NotesDragPresentationSnapshot | null>(null);
const dragSourceNodeIdSet = useMemo(
  () => new Set(dragPresentation?.forestNodeIds ?? []),
  [dragPresentation]
);
const draggedNodeLabels = useMemo(
  () =>
    (dragPresentation?.rootIds.slice(0, 1) ?? []).map((nodeId) => {
      const node = state.nodesById[nodeId];
      return noteNodePresentationLabel(node, node.title, "Untitled");
    }),
  [dragPresentation, state.nodesById]
);
```

For a selected drag, retain the existing `visualPreparation`; when ready and not rejected, set:

```ts
setDragPresentation(notesDragPresentationSnapshot(visualPreparation));
```

For an ordinary drag, prepare the active node only for presentation while leaving the command session ordinary:

```ts
const visualPreparation = prepareOutlineSelectionDrag(
  id,
  [id],
  structuralRows,
  {
    rootIds: state.rootIds,
    childIdsByParent: state.childIdsByParent,
    zoomRootId: state.zoomRootId
  }
);
outlineDragSessionRef.current = Object.freeze({
  kind: "ordinary",
  activeId: id
});
setDragPresentation(
  visualPreparation.kind === "ready"
    ? notesDragPresentationSnapshot(visualPreparation)
    : null
);
```

Replace all drag-start reset, rejection, cancellation, and drag-end calls from `setDraggedNodeIds([])` to `setDragPresentation(null)`.

- [ ] **Step 4: Freeze rows and render the overlay for every valid drag**

Replace the list-item presentation attribute with:

```tsx
data-drag-source={
  dragSourceNodeIdSet.has(row.id) ? "true" : undefined
}
```

Replace the current conditional `suppressDragPresentation` prop value with:

```tsx
suppressDragPresentation={activeDragId !== null}
```

Preserve every other `OutlineNodeRow` prop exactly. Replace the conditional overlay with:

```tsx
{dragPresentation !== null && (
  <DragOverlay
    dropAnimation={null}
    modifiers={NOTES_DRAG_OVERLAY_MODIFIERS}
  >
    <NotesSelectionDragPreview
      labels={draggedNodeLabels}
      total={dragPresentation.forestNodeIds.length}
    />
  </DragOverlay>
)}
```

Do not change `detectOutlineCollisions`, `pointerDropBoundaryRef`, `projectDrag`, or either move command path.

- [ ] **Step 5: Replace faded source CSS with a selection-like fixed band**

Replace the old `data-selection-dragging` opacity rule with:

```css
.notes-outline-item[data-drag-source="true"]
  > .notes-node
  > .notes-node-main {
  border-radius: 4px;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
```

Keep `.notes-node[data-dragging="true"]`; pane-wide suppression makes it absent during outline drags.

- [ ] **Step 6: Run presentation, cleanup, and drop regressions**

```bash
npm test -- --run src/features/notes/NotesSelectionDragPreview.test.tsx src/features/notes/NotesWorkspace.test.tsx -t "drag|drop line|collapsed drop parent|ordinary parent forest|five selected sibling roots"
```

Expected: PASS. Ordinary and selected drags show one compact overlay; the insertion line stays present; source rows remain untransformed; presentation clears on cancel, end, and rejection.

- [ ] **Step 7: Commit stationary presentation**

```bash
git add src/features/notes/NotesOutlinePane.tsx src/features/notes/NotesWorkspace.test.tsx src/features/notes/notes.css
git commit -m "feat(notes): keep drag source forest stationary"
```

---

### Task 4: Route Undo from the Focused Bullet and Preserve dnd-kit Keys

**Files:**
- Modify: `src/features/notes/OutlineNodeRow.tsx:645-680, 1074-1084`
- Modify: `src/features/notes/outlineRowMemo.test.tsx:100-190, 650-730`

**Interfaces:**
- Consumes: `resolveNotesHistoryShortcut()`, `detectOutlineShortcutPlatform()`, `actions.undo`, `actions.redo`, and `listeners.onKeyDown` from `useSortable()`.
- Produces: a composed bullet handler that owns Notes Undo/Redo and forwards every other key to dnd-kit once.

- [ ] **Step 1: Write the focused-bullet history regression**

Append:

```tsx
it("undoes one completed keyboard drop from the still-focused bullet", async () => {
  const before = [
    node({ id: "first", sortKey: 1, title: "First" }),
    node({ id: "second", sortKey: 2, title: "Second" })
  ];
  const after = [
    node({ id: "second", sortKey: 1, title: "Second" }),
    node({ id: "first", sortKey: 2, title: "First" })
  ];
  let active = before;
  let moveEntryId: string | null = null;
  const store = repository(before);
  vi.mocked(store.loadWorkspace).mockImplementation(async () => workspace(active));
  const moveNode = vi.mocked(store.moveNode);
  moveNode.mockImplementation(async (_vaultRoot, _input, context) => {
    active = after;
    moveEntryId = context?.entryId ?? null;
    return {
      workspace: workspace(after),
      historyEntryId: moveEntryId,
      canUndo: true,
      canRedo: false
    };
  });
  const undo = vi.mocked(store.undo!);
  undo.mockImplementation(async () => {
    active = before;
    return {
      workspace: workspace(before),
      replayedEntryId: moveEntryId,
      canUndo: false,
      canRedo: true
    };
  });
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
  const user = userEvent.setup();
  render(<Harness store={store} />);
  await waitFor(() => expect(captured?.status).toBe("ready"));
  const rectangle = (top: number) =>
    ({
      x: 0,
      y: top,
      top,
      left: 0,
      right: 640,
      bottom: top + 28,
      width: 640,
      height: 28,
      toJSON: () => ({})
    }) as DOMRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const row = this.closest<HTMLElement>(".notes-node");
      const rows = Array.from(document.querySelectorAll(".notes-node"));
      return rectangle(row ? rows.indexOf(row) * 28 : 0);
    }
  );
  const bullet = await screen.findByRole("button", {
    name: "Zoom into Second"
  });

  bullet.focus();
  await user.keyboard("[Space][ArrowUp][Space]");
  await waitFor(() => expect(moveNode).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(
      Array.from(document.querySelectorAll<HTMLElement>("[data-outline-id]")).map(
        (row) => row.dataset.outlineId
      )
    ).toEqual(["second", "first"])
  );
  expect(bullet).toHaveFocus();

  expect(fireEvent.keyDown(bullet, { key: "z", metaKey: true })).toBe(false);
  await waitFor(() => expect(undo).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(
      Array.from(document.querySelectorAll<HTMLElement>("[data-outline-id]")).map(
        (row) => row.dataset.outlineId
      )
    ).toEqual(["first", "second"])
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npm test -- --run src/features/notes/outlineRowMemo.test.tsx -t "undoes one completed keyboard drop from the still-focused bullet"
```

Expected: the keyboard drop completes, but the original order is not restored because the focused bullet only owns dnd-kit listeners and never calls Undo.

- [ ] **Step 3: Compose the bullet key handler**

Add inside `OutlineNodeRow`:

```ts
const handleBulletKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
  const historyShortcut = resolveNotesHistoryShortcut({
    key: event.key,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    isComposing: event.nativeEvent.isComposing,
    platform: detectOutlineShortcutPlatform()
  });
  if (historyShortcut) {
    event.preventDefault();
    void actions[historyShortcut]?.();
    return;
  }
  if (dragEnabled) {
    listeners?.onKeyDown?.(event);
  }
};
```

Keep both existing dnd-kit spreads, then place this explicit prop after them:

```tsx
onKeyDown={handleBulletKeyDown}
```

Preserve the pointer-capture handler and button content. Do not stop propagation or install a window listener.

- [ ] **Step 4: Run shortcut, keyboard-drag, and atomic-history regressions**

```bash
npm test -- --run src/features/notes/outlineRowMemo.test.tsx -t "undoes one completed keyboard drop from the still-focused bullet"
npm test -- --run src/features/notes/NotesWorkspace.test.tsx -t "moves before the first row by keyboard|routes a one-row selected drag through the frozen batch command"
npm test -- --run src/features/notes/useNotesWorkspace.test.tsx -t "locally expands a collapsed prepared reorder target only after success and records it in history|reverts an applied batch in a single undo step"
```

Expected: focused bullet Undo calls the repository once; dnd-kit keys still work; ordinary/prepared moves issue one mutation; one existing Undo restores the corresponding history state.

- [ ] **Step 5: Commit the focused Undo route**

```bash
git add src/features/notes/OutlineNodeRow.tsx src/features/notes/outlineRowMemo.test.tsx
git commit -m "fix(notes): route undo from drag bullet"
```

---

### Task 5: Full Verification and Running-App Acceptance

**Files:**
- Verify only; change source only if a failing check reveals a defect inside this specification.

**Interfaces:**
- Consumes: all four committed tasks.
- Produces: test/build evidence and direct UI acceptance evidence.

- [ ] **Step 1: Run all focused Notes tests together**

```bash
npm test -- --run \
  src/features/notes/outlineDrag.test.ts \
  src/features/notes/notesDragOverlay.test.ts \
  src/features/notes/NotesSelectionDragPreview.test.tsx \
  src/features/notes/outlineRowMemo.test.tsx \
  src/features/notes/NotesWorkspace.test.tsx \
  src/features/notes/useNotesWorkspace.test.tsx
```

Expected: all focused files PASS.

- [ ] **Step 2: Run repository-wide checks**

```bash
npm test
npm run lint
npm run build
git diff --check
```

Expected: every command exits 0. Record any unrelated pre-existing failure separately without expanding this task.

- [ ] **Step 3: Inspect the final boundary**

```bash
git status --short --branch
git diff HEAD~4 --stat
git log -4 --oneline
```

Expected: only planned files changed, the worktree is clean, and four implementation commits follow the design commit.

- [ ] **Step 4: Verify in the already-running Tauri app**

1. Drag a leaf: compact stack stays 16 px below-right; source is fixed; insertion line is clear.
2. Drag an expanded parent: parent and visible descendants stay fixed and highlighted.
3. Drag a parent with collapsed descendants: hidden rows stay hidden but count in the badge.
4. Drag selected roots: first structural-root title appears; visible forest is highlighted; count is unique and complete.
5. Cancel: overlay, highlight, and insertion line clear without mutation.
6. Drop ordinary and selected drags: pointer insertion line remains authoritative until drop.
7. Immediately press `Cmd+Z` on the focused bullet: the first command restores the exact prior tree and selection/focus.
8. Perform Space/arrow/Space keyboard drag: behavior and row-relative overlay remain intact.

Expected: all eight checks pass without restarting the development app.

- [ ] **Step 5: Report completion evidence**

Report implementation commit hashes, focused/full check results, and direct UI checks. State that backend history was unchanged because existing move and batch entries replay atomically once the bullet routes the shortcut.
