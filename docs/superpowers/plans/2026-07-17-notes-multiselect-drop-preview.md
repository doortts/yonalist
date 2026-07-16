# Notes Multi-Selection Drop Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the existing Notes insertion line immediately during a multi-row pointer drag while preserving authoritative validation for the eventual batch move.

**Architecture:** Prepare one read-only visual selection geometry snapshot synchronously from the rendered outline and store it on a pending selected-drag session. Reuse the existing prepared projection and preview derivation for pointer feedback, filter selected-forest rows from collision candidates, and continue to require the existing asynchronous frozen authority before executing a reorder.

**Tech Stack:** React 19, TypeScript 6, dnd-kit 6, Vitest 4, Testing Library

## Global Constraints

- Do not add a second drop-position algorithm or a new insertion-line component.
- Pending visual projection must never authorize a mutation.
- Final drop execution must retain the existing selection revision, workspace generation, attempt epoch, and authoritative projection checks.
- Selected drags must never fall back to an ordinary single-row move.
- Ordinary single-row drag behavior must remain unchanged.
- Add no dependency, backend command, database schema, or Keychain/code-signing change.

---

## File Structure

- `src/features/notes/outlineDrag.ts`: expose membership of the already prepared selected forest so collision detection can reject impossible targets without rebuilding geometry.
- `src/features/notes/outlineDrag.test.ts`: prove the membership helper includes selected roots and their descendants but excludes external destinations.
- `src/features/notes/NotesOutlinePane.tsx`: attach synchronous visual preparation to pending sessions, project pending pointer movement, filter collision candidates, and feed the existing `DropPreviewLine` state.
- `src/features/notes/NotesWorkspace.test.tsx`: reproduce an unresolved authority read and prove the insertion line appears before authority resolves while the final batch still waits for validation.

### Task 1: Expose Prepared-Forest Membership

**Files:**
- Modify: `src/features/notes/outlineDrag.ts:486-534`
- Test: `src/features/notes/outlineDrag.test.ts:1-14,780-866`

**Interfaces:**
- Consumes: `PreparedOutlineSelectionDrag` and its existing private `preparedSelectionDragStates` WeakMap.
- Produces: `preparedOutlineSelectionDragContainsNode(prepared: PreparedOutlineSelectionDrag, nodeId: NoteId): boolean`.

- [ ] **Step 1: Write the failing selected-forest membership test**

Add `preparedOutlineSelectionDragContainsNode` to the import from `./outlineDrag`, then add this test beside the existing prepared-forest reuse test:

```ts
it("identifies every node owned by a prepared selected forest", () => {
  const state = normalizeWorkspace({
    nodes: [
      node({ id: "selected", sortKey: 1 }),
      node({ id: "selected-child", parentId: "selected" }),
      node({ id: "target", sortKey: 2 })
    ]
  } satisfies NotesWorkspace);
  const prepared = prepareOutlineSelectionDrag(
    "selected",
    ["selected"],
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

  expect(preparedOutlineSelectionDragContainsNode(prepared, "selected")).toBe(
    true
  );
  expect(
    preparedOutlineSelectionDragContainsNode(prepared, "selected-child")
  ).toBe(true);
  expect(preparedOutlineSelectionDragContainsNode(prepared, "target")).toBe(
    false
  );
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npx vitest run src/features/notes/outlineDrag.test.ts
```

Expected: FAIL because `preparedOutlineSelectionDragContainsNode` is not exported by `outlineDrag.ts`.

- [ ] **Step 3: Implement the minimal membership helper**

Add this function immediately after `preparedSelectionDragStates`:

```ts
export function preparedOutlineSelectionDragContainsNode(
  prepared: PreparedOutlineSelectionDrag,
  nodeId: NoteId
): boolean {
  return preparedSelectionDragStates.get(prepared)?.forestNodeIds.has(nodeId) ?? false;
}
```

Do not expose the mutable `ReadonlySet` itself and do not traverse the source tree again.

- [ ] **Step 4: Run the test and verify GREEN**

Run:

```bash
npx vitest run src/features/notes/outlineDrag.test.ts
```

Expected: PASS with the complete existing `outlineDrag` test file green.

- [ ] **Step 5: Commit the prepared-forest helper**

```bash
git add src/features/notes/outlineDrag.ts src/features/notes/outlineDrag.test.ts
git commit -m "test(notes): expose selected drag forest membership"
```

### Task 2: Render Pending Selected-Drop Preview

**Files:**
- Modify: `src/features/notes/NotesOutlinePane.tsx:1-105,165-190,1970-2105,2168-2400,2638-2648`
- Test: `src/features/notes/NotesWorkspace.test.tsx:4080-4505`

**Interfaces:**
- Consumes: `prepareOutlineSelectionDrag`, `projectPreparedOutlineSelectionDrop`, `derivePreparedOutlineSelectionDropPreview`, and `preparedOutlineSelectionDragContainsNode` from Task 1.
- Produces: pending session property `preview: PreparedOutlineSelectionDrag` and pane projection variant `{ kind: "selected-preview"; prepared: PreparedOutlineSelectionDrag; result: OutlineSelectionDropResult }`.

- [ ] **Step 1: Write the failing pending-authority pointer regression test**

Add this test in the selected-drag integration group, next to the existing five-row pointer drag test:

```ts
it("shows a selected drop line before frozen authority resolves", async () => {
  const user = userEvent.setup();
  const activeNodes = [
    node({ id: "a", sortKey: 1, title: "Alpha" }),
    node({ id: "b", sortKey: 2, title: "Bravo" }),
    node({ id: "c", sortKey: 3, title: "Charlie" }),
    node({ id: "d", sortKey: 4, title: "Delta" })
  ];
  const hydration = deferred<NotesWorkspace>();
  let deferAuthority = false;
  configureRepository(activeNodes);
  notesStoreMock.loadWorkspace.mockImplementation(
    async (_vaultRoot: string, scope: { kind: string }) => {
      if (deferAuthority && scope.kind === "active") {
        return hydration.promise;
      }
      return workspace(activeNodes);
    }
  );
  renderNotesWorkspace();
  const alphaTitle = await findTitleInput("Alpha");
  const activeLoadsBeforeSelection = notesStoreMock.loadWorkspace.mock.calls
    .filter(([, scope]) => scope.kind === "active").length;
  deferAuthority = true;
  fireEvent.keyDown(alphaTitle, { key: "ArrowDown", shiftKey: true });
  await waitFor(() =>
    expect(
      notesStoreMock.loadWorkspace.mock.calls.filter(
        ([, scope]) => scope.kind === "active"
      ).length
    ).toBeGreaterThan(activeLoadsBeforeSelection)
  );
  const alpha = screen.getByRole("button", { name: "Zoom into Alpha" });
  const bravo = screen.getByRole("button", { name: "Zoom into Bravo" });
  mockOutlineRowRects();

  await user.pointer({
    keys: "[MouseLeft>]",
    target: alpha,
    coords: { clientX: 9, clientY: 14 }
  });
  await user.pointer({
    target: bravo,
    coords: { clientX: 9, clientY: 42 }
  });

  const dropLine = document.querySelector(".notes-outline-drop-preview");
  expect(dropLine).not.toBeNull();
  expect(dropLine).toHaveAttribute("data-before-id", "d");
  expect(dropLine).not.toHaveAttribute("data-parent-id");
  expect(dropLine).toHaveAttribute("data-depth", "0");
  expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();

  await user.pointer({
    keys: "[/MouseLeft]",
    target: bravo,
    coords: { clientX: 9, clientY: 42 }
  });
  expect(notesStoreMock.applyBatch).not.toHaveBeenCalled();

  await act(async () => {
    deferAuthority = false;
    hydration.resolve(workspace(activeNodes));
    await hydration.promise;
  });

  await waitFor(() => expect(notesStoreMock.applyBatch).toHaveBeenCalledOnce());
  expect(notesStoreMock.applyBatch).toHaveBeenCalledWith("/vault", {
    op: "move",
    nodeIds: ["a", "b"],
    parentId: null,
    afterId: "c",
    beforeId: "d"
  });
  expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
});
```

The pointer intentionally remains over selected row `b`. Once selected-forest collision candidates are removed, the nearest valid destination is `c`, represented by an insertion line before `d`.

- [ ] **Step 2: Run the regression test and verify RED**

Run:

```bash
npx vitest run src/features/notes/NotesWorkspace.test.tsx -t "shows a selected drop line before frozen authority resolves"
```

Expected: FAIL because `.notes-outline-drop-preview` is absent while the selected drag session is pending.

- [ ] **Step 3: Add the pending visual projection types and imports**

Import `CollisionDetection` from `@dnd-kit/core`. Extend the `outlineDrag` import with:

```ts
prepareOutlineSelectionDrag,
preparedOutlineSelectionDragContainsNode,
projectPreparedOutlineSelectionDrop,
type OutlineSelectionDropResult,
type PreparedOutlineSelectionDrag,
```

Add `preview` to `PendingPaneSelectionDragSession`:

```ts
type PendingPaneSelectionDragSession = Readonly<{
  kind: "selected-pending";
  attemptEpoch: number;
  activeId: NoteId;
  selectedNodeIds: readonly NoteId[];
  selectionRevision: number;
  rows: readonly FlattenedOutlineRow[];
  zoomRootId: NoteId | null;
  preview: PreparedOutlineSelectionDrag;
  preparation: PendingPaneSelectionDragPreparation;
}>;
```

Add the preview-only projection variant to `PaneDragProjection`:

```ts
type PaneDragProjection =
  | Readonly<{
      kind: "ordinary-move";
      projection: OutlineDropProjection;
    }>
  | Readonly<{
      kind: "selected-preview";
      prepared: PreparedOutlineSelectionDrag;
      result: OutlineSelectionDropResult;
    }>
  | OutlineSelectionDragProjection;
```

- [ ] **Step 4: Prepare visual geometry synchronously at selected-drag start**

Immediately after `selectedNodeIds` is captured in `handleDragStart`, prepare from the rendered outline:

```ts
const visualPreparation = prepareOutlineSelectionDrag(
  id,
  selectedNodeIds,
  structuralRows,
  {
    rootIds: state.rootIds,
    childIdsByParent: state.childIdsByParent,
    zoomRootId: state.zoomRootId
  }
);
```

If `visualPreparation.kind === "invalid"`, assign the matching `selected-invalid` session before considering cached or asynchronous authority. In the asynchronous branch, store the ready preparation:

```ts
outlineDragSessionRef.current = Object.freeze({
  kind: "selected-pending",
  attemptEpoch,
  activeId: id,
  selectedNodeIds,
  selectionRevision: live.revision,
  rows: Object.freeze([...structuralRows]),
  zoomRootId: state.zoomRootId,
  preview: visualPreparation,
  preparation
});
```

Type-narrow the branch so only a ready `visualPreparation` can create a pending session. Keep the existing cached-authority and selected-invalid rules unchanged.

- [ ] **Step 5: Project the pending visual target through existing helpers**

In `projectDrag`, call `promotePendingSelectionDrag` first as today. If the session is still pending, project its visual snapshot instead of returning `null`:

```ts
if (session.kind === "selected-pending") {
  const result = projectPreparedOutlineSelectionDrop(
    session.preview,
    String(event.over.id),
    event.delta.x,
    outlineIndentPx
  );
  return Object.freeze({
    kind: "selected-preview",
    prepared: session.preview,
    result
  });
}
```

In `handleDragMove`, handle this variant before `selected-invalid`:

```ts
if (projection.kind === "selected-preview") {
  setDropPreview(
    derivePreparedOutlineSelectionDropPreview(
      projection.prepared,
      projection.result
    )
  );
  return;
}
```

After the existing pending-drop branch in `handleDragEnd`, explicitly prevent a preview-only result from reaching the ordinary move path:

```ts
if (projection.kind === "selected-preview") {
  return;
}
```

The existing pending-drop branch must continue to await the captured preparation promise and reproject with the authoritative ready session.

- [ ] **Step 6: Exclude selected-forest collision candidates**

Add one memo-stable collision detector near `measureDragOverlay`:

```ts
const detectOutlineCollisions = useCallback<CollisionDetection>((args) => {
  const session = outlineDragSessionRef.current;
  const prepared =
    session?.kind === "selected-ready"
      ? session.prepared
      : session?.kind === "selected-pending"
        ? session.preview
        : null;
  return closestCenter(
    prepared === null
      ? args
      : {
          ...args,
          droppableContainers: args.droppableContainers.filter(
            ({ id }) =>
              !preparedOutlineSelectionDragContainsNode(prepared, String(id))
          )
        }
  );
}, []);
```

Change only the existing Dnd context collision prop:

```tsx
collisionDetection={detectOutlineCollisions}
```

This leaves ordinary sessions on the unmodified `closestCenter(args)` path.

- [ ] **Step 7: Run the focused integration test and verify GREEN**

Run:

```bash
npx vitest run src/features/notes/NotesWorkspace.test.tsx -t "shows a selected drop line before frozen authority resolves"
```

Expected: PASS. The line exists while authority is unresolved, no mutation occurs before validation, and one batch move occurs after resolution.

- [ ] **Step 8: Run all selected-drag regressions**

Run:

```bash
npx vitest run src/features/notes/NotesWorkspace.test.tsx -t "selected|drag"
npx vitest run src/features/notes/outlineDrag.test.ts src/features/notes/outlineSelectionDragSession.test.ts
```

Expected: PASS, including stale-authority rejection and the prohibition on single-row fallback.

- [ ] **Step 9: Commit the pending preview fix**

```bash
git add src/features/notes/NotesOutlinePane.tsx src/features/notes/NotesWorkspace.test.tsx
git commit -m "fix(notes): show multi-select drop position"
```

### Task 3: Full Verification

**Files:**
- Verify only: `src/features/notes/outlineDrag.ts`
- Verify only: `src/features/notes/NotesOutlinePane.tsx`
- Verify only: `src/features/notes/outlineDrag.test.ts`
- Verify only: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**
- Consumes: the completed synchronous preview and authoritative drop paths.
- Produces: verification evidence; no new production interface.

- [ ] **Step 1: Run the complete frontend test suite**

```bash
npm test
```

Expected: all Vitest files and tests pass.

- [ ] **Step 2: Run lint**

```bash
npm run lint
```

Expected: ESLint exits 0 with no errors.

- [ ] **Step 3: Run the production build**

```bash
npm run build
```

Expected: TypeScript and Vite build successfully.

- [ ] **Step 4: Check patch hygiene and ownership**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only the implementation files above and the user's pre-existing `package-lock.json` change are present outside committed work.

- [ ] **Step 5: Verify in the local Tauri app**

Run:

```bash
npm run tauri:dev
```

In the development app, select at least two sibling Notes rows, drag a selected bullet across another selected row and then over an external destination, and press Escape to cancel without dropping.

Expected:

- the group overlay appears;
- exactly one insertion line is visible at the nearest valid external position;
- the line remains visible while frozen authority is still loading;
- no note moves after cancellation;
- ordinary one-row drag still shows the same insertion line behavior as before.
