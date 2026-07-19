<!-- reconciliation: auditedHead=ec8a9ff3d016449255992adf70e128ea5e222e9a status=complete -->
> **증거 대조 상태 (2026-07-19): 완료.** commit·artifact 근거는 [감사 보고서](../reports/2026-07-19-historical-plan-reconciliation.md)에 기록했다.

# Notes Multi-Select Drag and Indent Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Explain the retained leading item after a partial multi-select indent and permanently guarantee that dragging any selected bullet moves five normalized roots as one ordered, hierarchy-preserving batch.

**Architecture:** Reuse the existing semantic selection router, polite action-bar live region, frozen selected-drag session, outline projection, and prepared batch mutation path. Add one exact status-selection condition in the router and one rendered multi-root pointer regression; do not add a second drag or move implementation. The current source already passes the five-root rendered diagnostic, so the drag task is characterization coverage with a deliberate temporary mutation used only to prove the test can detect a single-root regression.

**Tech Stack:** React 19, TypeScript, dnd-kit, Vitest, Testing Library, Tauri 2, Rust 1.97, rusqlite/SQLite, existing Notes selection router and workspace coordinator.

## Global Constraints

- Treat the approved English design at commit `266ae02` as the source of truth: `git show 266ae02:docs/superpowers/specs/2026-07-15-notes-multiselect-drag-and-indent-feedback-design.md`.
- Publish the exact neutral copy `First item stayed: no preceding sibling.` only when eligible indent IDs equal `structuralRootIds` with exactly the first root removed.
- Preserve `Indented selection.` for fully eligible indents and every other partial shape.
- Publish success only after authoritative settlement. Existing execution, stale-authority, and projection errors remain unchanged and visually dominate status through the existing action-bar live region.
- Keep the existing `role="status"`, `aria-live="polite"`, and `aria-atomic="true"` region between overflow actions and Delete. Do not add a toast, notice component, CSS state, or action-bar prop.
- The row bullet remains the only drag handle. A bullet belonging to any materialized selected row—anchor, head, or middle—uses the selected-drag path; row bodies and ellipsis menus do not become handles.
- A selected drag never falls back to ordinary single-row movement. Invalid geometry, stale ownership, missing destinations, selected-forest targets, and superseded pending drags remain selection-preserving no-ops.
- Send one semantic `reorder` intent and one `{ op: "move", nodeIds, parentId, afterId, beforeId }` batch. Preserve structural-root source order, subtree hierarchy, one SQLite transaction, one history entry, and one Undo.
- Do not change Move To, one-step keyboard reorder, ordinary single-row drag, the database schema, Tauri commands, Rust production code, or repository mutation types.
- Add no dependency and no speculative drag abstraction. The minimal expected production diff is one conditional in `useNotesSelectionCommandRouter.ts`.
- Use strict RED/GREEN for the new indent behavior. For the already-working drag behavior, use the explicit temporary mutation sensitivity check in Task 2 and restore it before committing.
- Commit Task 1 and Task 2 separately after their focused review gates pass.

---

### Task 1: Exact leading-item indent feedback

**Files:**
- Modify: `src/features/notes/useNotesSelectionCommandRouter.ts:255-261`
- Test: `src/features/notes/useNotesSelectionCommandRouter.test.tsx:645-660`
- Test: `src/features/notes/NotesWorkspace.test.tsx:4177-4226`

**Interfaces:**
- Consumes: `NotesSelectionActionSnapshot.structuralRootIds`, `NotesSelectionEligibility.nodeIds`, the existing `exactIds(left, right)` helper, and `ResolvedCommand.successStatus`.
- Produces: no new public type or prop; only an exact `successStatus` choice that the existing `authoritySuccessStatus()` and post-settlement `feedback()` path publish.

- [x] **Step 1: Write the failing router feedback tests**

Replace the existing partial-indent router test with the following block and add the parameterized guard immediately after it:

```tsx
it("uses the exact partially eligible indent targets and reports why the first root stayed", async () => {
  const feedback = vi.fn();
  const harness = dependencies({ onFeedback: feedback });
  vi.mocked(harness.deps.prepareAuthority).mockImplementation(
    async (nodeIds) => authority(nodeIds)
  );
  const router = createNotesSelectionCommandRouter(harness.deps);

  await router.execute({ type: "indent" });

  expect(harness.deps.prepareAuthority).toHaveBeenCalledWith(["b", "c"]);
  expect(harness.deps.applyBatch).toHaveBeenCalledWith(
    expect.objectContaining({ selectedNodeIds: ["b", "c"] }),
    { type: "indent" },
    undefined
  );
  expect(feedback).toHaveBeenLastCalledWith({
    status: "First item stayed: no preceding sibling.",
    error: null
  });
});

it.each([
  { label: "every structural root is eligible", nodeIds: ["a", "b", "c"] },
  { label: "another partial shape is eligible", nodeIds: ["a", "c"] }
])("keeps the general indent status when $label", async ({ nodeIds }) => {
  const feedback = vi.fn();
  const targetedSnapshot = snapshot({
    eligibility: {
      ...snapshot().eligibility,
      indent: eligible(nodeIds)
    }
  });
  const harness = dependencies({
    getSnapshot: () => targetedSnapshot,
    prepareAuthority: vi.fn(async (targetIds) => authority(targetIds)),
    onFeedback: feedback
  });

  await createNotesSelectionCommandRouter(harness.deps).execute({
    type: "indent"
  });

  expect(harness.deps.prepareAuthority).toHaveBeenCalledWith(nodeIds);
  expect(feedback).toHaveBeenLastCalledWith({
    status: "Indented selection.",
    error: null
  });
});
```

- [x] **Step 2: Add the failing rendered live-region assertion**

At the end of `indents the trailing rows beneath a selected first sibling`, after the selection, depth, and focus assertions, add:

```tsx
const toolbar = screen.getByRole("toolbar", {
  name: "Actions for 5 selected notes"
});
const status = within(toolbar).getByRole("status");
expect(status).toHaveTextContent(
  /^First item stayed: no preceding sibling\.$/
);
expect(status).toHaveAttribute("aria-live", "polite");
expect(status).toHaveAttribute("aria-atomic", "true");
expect(status).toHaveAttribute("data-kind", "status");
```

- [x] **Step 3: Run the focused tests and verify RED**

Run:

```bash
npm test -- src/features/notes/useNotesSelectionCommandRouter.test.tsx -t "partially eligible indent targets|general indent status"
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "indents the trailing rows beneath a selected first sibling"
```

Expected: the partial router case and rendered workspace case fail because they receive `Indented selection.`; both generic-status guard cases pass. The existing batch payload remains exactly `nodeIds: ["b", "c", "d", "e"]`, the five-row selection remains active, and the depth assertion remains green.

- [x] **Step 4: Implement the minimal status condition**

Change only the `indent` branch of `resolveCommand()`:

```ts
case "indent":
  return eligibleCommand(snapshot.eligibility.indent, (nodeIds) => ({
    kind: "batch",
    nodeIds,
    op: { type: "indent" },
    successStatus:
      snapshot.structuralRootIds.length > 1 &&
      exactIds(nodeIds, snapshot.structuralRootIds.slice(1))
        ? "First item stayed: no preceding sibling."
        : "Indented selection."
  }));
```

Do not change `authoritySuccessStatus()`, `feedback()`, hook state, `NotesOutlinePane`, `NotesSelectionActionBar`, or CSS. The existing execution path already publishes `command.successStatus` only after a committed settlement and already gives errors render precedence.

- [x] **Step 5: Run focused GREEN and nearby feedback regressions**

Run:

```bash
npm test -- src/features/notes/useNotesSelectionCommandRouter.test.tsx -t "partially eligible indent targets|general indent status"
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "indents the trailing rows beneath a selected first sibling"
npm test -- src/features/notes/NotesSelectionActionBar.test.tsx src/features/notes/notesSelectionActions.test.ts src/features/notes/outlineKeyboard.test.ts
git diff --check
```

Expected: every command exits successfully. The special copy appears with `error: null`, full and unrelated partial eligibility keep `Indented selection.`, and the existing single polite action-bar region remains unchanged.

- [x] **Step 6: Review and commit the feedback change**

Run:

```bash
git diff -- src/features/notes/useNotesSelectionCommandRouter.ts src/features/notes/useNotesSelectionCommandRouter.test.tsx src/features/notes/NotesWorkspace.test.tsx
git diff --check
git add src/features/notes/useNotesSelectionCommandRouter.ts src/features/notes/useNotesSelectionCommandRouter.test.tsx src/features/notes/NotesWorkspace.test.tsx
git commit -m "fix(notes): explain retained first indent item"
```

Expected: the commit contains one production conditional plus the router and rendered assertions; it contains no action-bar, CSS, drag, store, or Rust change.

---

### Task 2: Rendered five-root selected-bullet drag guarantee

**Files:**
- Test: `src/features/notes/NotesWorkspace.test.tsx:3279-3318`
- Inspect only: `src/features/notes/NotesOutlinePane.tsx:1773-2214`
- Inspect only: `src/features/notes/outlineSelectionDragSession.ts:96-172`
- Inspect only: `src/features/notes/outlineDrag.ts:505-584`

**Interfaces:**
- Consumes: the existing bullet-only dnd-kit activator, `selectionRangeIds`, frozen `OutlineSelectionDragFrozenContext`, normalized `structuralRootIds`, semantic `reorder`, and `notesStoreMock.applyBatch` projection boundary.
- Produces: one rendered regression proving that a middle selected bullet submits five ordered structural roots in one batch, keeps a hidden descendant attached to its selected parent, applies the authoritative destination projection, and retains the five-row selection.

- [x] **Step 1: Add the permanent rendered pointer regression**

Add this test immediately after `routes a one-row selected drag through the frozen batch command`:

```tsx
it("moves five selected sibling roots as one pointer-dragged block from a middle bullet", async () => {
  const user = userEvent.setup();
  const movingIds = ["a", "b", "c", "d", "e"];
  configureRepository([
    node({ id: "parent", sortKey: 1, title: "Parent" }),
    ...["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"].map(
      (title, index) =>
        node({
          id: String.fromCharCode(97 + index),
          parentId: "parent",
          sortKey: index + 1,
          title,
          isCollapsed: index === 2
        })
    ),
    node({ id: "c-child", parentId: "c", title: "Charlie child" }),
    node({ id: "destination", sortKey: 2, title: "Destination" })
  ]);
  notesStoreMock.applyBatch.mockImplementationOnce(
    async (_vaultRoot: string, input: ApplyNotesBatchInput) => {
      if (input.op === "move") {
        confirmedNodes = confirmedNodes.map((current) => {
          const movedIndex = movingIds.indexOf(current.id);
          return movedIndex === -1
            ? current
            : {
                ...current,
                parentId: "destination",
                sortKey: movedIndex + 1
              };
        });
      }
      return workspace(confirmedNodes);
    }
  );
  renderNotesWorkspace();
  const alpha = await findTitleInput("Alpha");
  const activeLoadsBeforeSelection = notesStoreMock.loadWorkspace.mock.calls
    .filter(([, scope]) => scope.kind === "active").length;
  alpha.focus();
  for (let index = 0; index < 4; index += 1) {
    fireEvent.keyDown(alpha, { key: "ArrowDown", shiftKey: true });
  }
  expect(selectedOutlineIds()).toEqual(movingIds);
  await waitFor(() =>
    expect(
      notesStoreMock.loadWorkspace.mock.calls.filter(
        ([, scope]) => scope.kind === "active"
      ).length
    ).toBeGreaterThan(activeLoadsBeforeSelection)
  );
  await act(async () => undefined);
  const active = screen.getByRole("button", { name: "Zoom into Charlie" });
  const destination = screen.getByRole("button", {
    name: "Zoom into Destination"
  });
  mockOutlineRowRects();

  await user.pointer({
    keys: "[MouseLeft>]",
    target: active,
    coords: { clientX: 9, clientY: 98 }
  });
  await user.pointer({
    target: destination,
    coords: { clientX: 14, clientY: 210 }
  });
  await user.pointer({
    target: destination,
    coords: { clientX: 50, clientY: 210 }
  });
  await user.pointer({
    keys: "[/MouseLeft]",
    target: destination,
    coords: { clientX: 50, clientY: 210 }
  });

  await waitFor(() => expect(notesStoreMock.applyBatch).toHaveBeenCalledOnce());
  expect(notesStoreMock.applyBatch).toHaveBeenCalledWith("/vault", {
    op: "move",
    nodeIds: movingIds,
    parentId: "destination",
    afterId: null,
    beforeId: null
  });
  await waitFor(() => expect(selectedOutlineIds()).toEqual(movingIds));
  await waitFor(() =>
    expect(
      textareasByName("Edit node title").map((input) => input.value)
    ).toEqual([
      "Parent",
      "Foxtrot",
      "Destination",
      "Alpha",
      "Bravo",
      "Charlie",
      "Delta",
      "Echo"
    ])
  );
  expect(confirmedNodes.find(({ id }) => id === "c-child")?.parentId).toBe(
    "c"
  );
  expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
});
```

- [x] **Step 2: Run the characterization baseline**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "moves five selected sibling roots as one pointer-dragged block"
```

Expected on the current source: PASS. This is intentionally not a RED result because the implementation audit and a temporary rendered diagnostic already proved the selected-drag pipeline works end to end. Do not add production drag code merely to manufacture a behavior change.

- [x] **Step 3: Prove the regression test is sensitive, then restore production immediately**

Temporarily change only the `reorder` branch in `resolveCommand()` from:

```ts
nodeIds: snapshot.structuralRootIds,
```

to:

```ts
nodeIds: snapshot.structuralRootIds.slice(0, 1),
```

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "moves five selected sibling roots as one pointer-dragged block"
```

Expected: FAIL because the frozen context and router target no longer match the five selected structural roots, so no valid five-ID `applyBatch` call is produced.

Restore the exact original line before running any other command:

```ts
nodeIds: snapshot.structuralRootIds,
```

Then run:

```bash
git diff -- src/features/notes/useNotesSelectionCommandRouter.ts
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "moves five selected sibling roots as one pointer-dragged block"
```

Expected: the router diff is empty and the rendered regression passes again. Never stage or commit the temporary mutation.

- [x] **Step 4: Run selected-drag and projection regressions**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "selected drag|moves five selected sibling roots"
npm test -- src/features/notes/outlineDrag.test.ts src/features/notes/outlineSelectionDragSession.test.ts src/features/notes/useNotesSelectionCommandRouter.test.tsx
git diff --check
```

Expected: valid one-root and five-root drags pass; latest-pending authority, filtered hidden order, invalid-inside-selection, ancestor normalization, reverse order, selected-descendant rejection, and collapsed-destination coverage remain green. The only uncommitted file is `NotesWorkspace.test.tsx`.

- [x] **Step 5: Review and commit the rendered guarantee**

Run:

```bash
git diff -- src/features/notes/NotesWorkspace.test.tsx
git diff --check
git add src/features/notes/NotesWorkspace.test.tsx
git commit -m "test(notes): cover multi-root pointer drag"
```

Expected: the commit adds only the rendered regression. There is no production drag, CSS, store, Tauri, schema, or Rust change.

---

### Task 3: Cross-stack regression gate

**Files:**
- Verify only: all tracked frontend and Rust sources

**Interfaces:**
- Consumes: the two completed task commits and existing frontend/backend regression suites.
- Produces: fresh evidence that the exact feedback copy, selected-drag path, atomic batch move/indent contracts, lint, production build, and whitespace checks all pass together.

- [x] **Step 1: Run the complete frontend gate**

Run:

```bash
npm run lint
npm test
npm run build
```

Expected: ESLint exits with zero errors; the complete Vitest suite passes with only its documented skips; TypeScript compilation and the Vite production build complete successfully.

- [x] **Step 2: Run the pinned Rust gate**

Run:

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: the Rust 1.97 suite passes, including exact batch wire decoding, ordered contiguous batch move, hierarchy preservation, atomic rollback, batch indent targeting, one-entry Undo/Redo, and true no-op history behavior.

- [x] **Step 3: Verify final scope and history**

Run:

```bash
git diff --check
git status --short
git log -2 --oneline
```

Expected: `git diff --check` prints nothing, `git status --short` is empty, and the latest two implementation commits are `test(notes): cover multi-root pointer drag` and `fix(notes): explain retained first indent item`. No additional commit is needed for verification-only output.
