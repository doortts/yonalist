# Notes Mouse Multi-Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add desktop-style mouse multi-selection to Notes, make selection indentation atomic, move selection-command feedback to the status bar, and render selected drags as a group.

**Architecture:** Extend the existing anchor/head selection value with an optional explicit ordered ID set, while keeping `selectionRangeIds` as the only materializer used by command and drag consumers. The outline owns pointer gesture promotion and reuses the current selection router and selection-drag authority. A small Notes feedback context bridges selection feedback into `AppStatusBar`, and a `DragOverlay` presents the already-owned selected drag as a compact stack.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, dnd-kit, Tauri 2, CSS.

## Global Constraints

- Plain row clicks keep editing behavior and clear an existing multi-selection.
- Shift+click selects a continuous visible range.
- Cmd+click on macOS and Ctrl+click on Windows/Linux toggle one visible row.
- A text drag stays native inside one row and becomes whole-row range selection only after crossing a row boundary.
- Bullet dragging remains structural drag-and-drop.
- An invalid selection indent performs no partial mutation and reports `Can't indent selection: the first selected item has no preceding sibling outside the selection.`
- Only selection-command feedback moves to the status bar; contextual workspace, row, attachment, date, and tag errors remain where they are.
- Notes status feedback clears after six seconds and when Notes becomes inactive.
- A selected drag shows up to three titles plus the full selected count and ghosts every selected source row.
- Do not add dependencies or change the Notes storage/database schema.
- Preserve the user's unrelated `package-lock.json` change; never stage it.

---

### Task 1: Explicit Mouse-Toggle Selection

**Files:**
- Modify: `src/features/notes/notesWorkspaceReducer.ts:32-115`
- Modify: `src/features/notes/useNotesWorkspace.ts:285-300, 2775-2805, 4655-4675`
- Test: `src/features/notes/notesWorkspaceReducer.test.ts:755-845`
- Test: `src/features/notes/useNotesWorkspace.test.tsx:11880-12030`

**Interfaces:**
- Consumes: visible outline order as `readonly NoteId[]`.
- Produces: optional `NotesSelection.explicitNodeIds`, `NotesSelectionAction.type === "toggleSelectionNode"`, and `UseNotesWorkspaceActions.toggleSelectionNode(nodeId, visibleNodeIds)`.

- [ ] **Step 1: Add failing reducer tests for explicit toggling**

```typescript
it("toggles visible rows into an explicit outline-ordered selection", () => {
  const visible = ["a", "b", "c", "d"];
  const anchored = notesSelectionReducer(null, {
    type: "setSelectionAnchor",
    anchorId: "b"
  });
  const added = notesSelectionReducer(anchored, {
    type: "toggleSelectionNode",
    nodeId: "d",
    visibleNodeIds: visible
  });

  expect(added).toEqual({
    anchorId: "d",
    headId: "d",
    explicitNodeIds: ["b", "d"]
  });
  expect(selectionRangeIds(added, visible)).toEqual(["b", "d"]);
});

it("removes a toggled row and clears the final selected row", () => {
  const visible = ["a", "b", "c"];
  const explicit: NotesSelection = {
    anchorId: "c",
    headId: "c",
    explicitNodeIds: ["a", "c"]
  };
  const removed = notesSelectionReducer(explicit, {
    type: "toggleSelectionNode",
    nodeId: "c",
    visibleNodeIds: visible
  });

  expect(selectionRangeIds(removed, visible)).toEqual(["a"]);
  expect(
    notesSelectionReducer(removed, {
      type: "toggleSelectionNode",
      nodeId: "a",
      visibleNodeIds: visible
    })
  ).toBeNull();
});

it("replaces an explicit selection with a Shift range", () => {
  const explicit: NotesSelection = {
    anchorId: "b",
    headId: "b",
    explicitNodeIds: ["b", "d"]
  };

  expect(
    notesSelectionReducer(explicit, {
      type: "extendSelectionTo",
      headId: "c"
    })
  ).toEqual({ anchorId: "b", headId: "c" });
});
```

- [ ] **Step 2: Run the reducer tests and verify RED**

Run: `npm test -- src/features/notes/notesWorkspaceReducer.test.ts`

Expected: FAIL because `explicitNodeIds` and `toggleSelectionNode` do not exist.

- [ ] **Step 3: Extend the selection reducer and materializer minimally**

```typescript
export interface NotesSelection {
  anchorId: NoteId;
  headId: NoteId;
  explicitNodeIds?: readonly NoteId[];
}

export type NotesSelectionAction =
  | { type: "setSelectionAnchor"; anchorId: NoteId }
  | { type: "extendSelectionTo"; headId: NoteId }
  | {
      type: "toggleSelectionNode";
      nodeId: NoteId;
      visibleNodeIds: readonly NoteId[];
    }
  | { type: "replaceSelection"; selection: NotesSelection | null }
  | { type: "clearSelection" };

case "extendSelectionTo":
  return {
    anchorId: state ? state.anchorId : action.headId,
    headId: action.headId
  };
case "toggleSelectionNode": {
  const selected = new Set(selectionRangeIds(state, action.visibleNodeIds));
  if (selected.has(action.nodeId)) selected.delete(action.nodeId);
  else selected.add(action.nodeId);
  const explicitNodeIds = action.visibleNodeIds.filter((id) => selected.has(id));
  return explicitNodeIds.length === 0
    ? null
    : {
        anchorId: action.nodeId,
        headId: action.nodeId,
        explicitNodeIds: Object.freeze(explicitNodeIds)
      };
}

export function selectionRangeIds(
  selection: NotesSelection | null,
  visibleNodeIds: readonly NoteId[]
): NoteId[] {
  if (!selection) return [];
  if (selection.explicitNodeIds) {
    const explicit = new Set(selection.explicitNodeIds);
    return visibleNodeIds.filter((nodeId) => explicit.has(nodeId));
  }
  const anchorIndex = visibleNodeIds.indexOf(selection.anchorId);
  const headIndex = visibleNodeIds.indexOf(selection.headId);
  if (anchorIndex < 0 || headIndex < 0) return [];
  const start = Math.min(anchorIndex, headIndex);
  const end = Math.max(anchorIndex, headIndex);
  return visibleNodeIds.slice(start, end + 1);
}
```

Clone and freeze `explicitNodeIds` in `replaceSelection` so async selection ownership never observes a caller-mutated array.

- [ ] **Step 4: Expose one stable workspace action**

```typescript
toggleSelectionNode(
  nodeId: NoteId,
  visibleNodeIds: readonly NoteId[]
): void;

const toggleSelectionNode = useCallback(
  (nodeId: NoteId, visibleNodeIds: readonly NoteId[]): void => {
    updateSelection({
      type: "toggleSelectionNode",
      nodeId,
      visibleNodeIds
    });
  },
  [updateSelection]
);
```

Add `toggleSelectionNode` to the memoized actions slice and write a hook test that calls it twice, confirms outline ordering, and confirms selection revision changes on each effective toggle.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npm test -- src/features/notes/notesWorkspaceReducer.test.ts src/features/notes/useNotesWorkspace.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/features/notes/notesWorkspaceReducer.ts \
  src/features/notes/notesWorkspaceReducer.test.ts \
  src/features/notes/useNotesWorkspace.ts \
  src/features/notes/useNotesWorkspace.test.tsx
git commit -m "feat(notes): support explicit row selection"
```

---

### Task 2: Mouse Click and Cross-Row Drag Selection

**Files:**
- Modify: `src/features/notes/OutlineNodeRow.tsx:70-125, 830-1060`
- Modify: `src/features/notes/NotesOutlinePane.tsx:920-1010, 2415-2510`
- Test: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**
- Consumes: `toggleSelectionNode`, `setSelectionAnchor`, `extendSelectionTo`, `clearSelection`, and the current visible body row order.
- Produces: modifier-click selection and cross-row text-drag promotion without changing single-row native text selection.

- [ ] **Step 1: Add failing interaction tests for modifier clicks**

```typescript
it("uses Shift click for a range and Meta click to toggle a row", async () => {
  renderWorkspaceWithRows(["Alpha", "Bravo", "Charlie"]);
  const alpha = screen.getByLabelText("Edit node title", { selector: "textarea" });
  const bravo = screen.getAllByLabelText("Edit node title")[1];
  const charlie = screen.getAllByLabelText("Edit node title")[2];

  fireEvent.pointerDown(alpha, { button: 0 });
  fireEvent.click(alpha);
  fireEvent.pointerDown(charlie, { button: 0, shiftKey: true });
  fireEvent.click(charlie, { shiftKey: true });
  expect(selectedOutlineIds()).toEqual(["alpha", "bravo", "charlie"]);

  fireEvent.pointerDown(bravo, { button: 0, metaKey: true });
  expect(selectedOutlineIds()).toEqual(["alpha", "charlie"]);
});
```

Use the existing workspace render helper and its actual node IDs rather than introducing `renderWorkspaceWithRows` or `selectedOutlineIds` as new production APIs; those names above denote local test helpers only.

- [ ] **Step 2: Add failing interaction tests for text drag promotion**

```typescript
it("keeps a same-row text drag native and promotes a cross-row drag", () => {
  renderWorkspace();
  const titles = screen.getAllByLabelText("Edit node title");

  fireEvent.pointerDown(titles[1], { button: 0, pointerId: 7 });
  fireEvent.pointerMove(titles[1], { buttons: 1, pointerId: 7 });
  expect(screen.queryByLabelText(/notes selected/i)).not.toBeInTheDocument();

  fireEvent.pointerMove(titles[3], { buttons: 1, pointerId: 7 });
  expect(screen.getByLabelText("3 notes selected")).toBeInTheDocument();
  fireEvent.pointerUp(titles[3], { button: 0, pointerId: 7 });
});
```

Add the reverse-direction case and assert that an interactive token/button does not start or change row selection.

- [ ] **Step 3: Run the focused tests and verify RED**

Run: `npm test -- src/features/notes/NotesWorkspace.test.tsx -t "click|cross-row drag|same-row text drag"`

Expected: FAIL because title modifier clicks and pointer-drag promotion are not implemented.

- [ ] **Step 4: Handle modifier clicks at the row capture boundary**

In `OutlineNodeRow`, intercept only primary-pointer events on row text surfaces. Leave links, tags, dates, attachment controls, menus, collapse controls, and bullets untouched.

```typescript
const isSelectionTextSurface = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  Boolean(target.closest(".notes-node-title-field, .notes-node-note-field"));

const handleSelectionPointerDownCapture = (
  event: PointerEvent<HTMLDivElement>
): void => {
  if (event.button !== 0 || !isSelectionTextSurface(event.target)) return;
  if (event.shiftKey) {
    event.preventDefault();
    if (!getSelection()) {
      actions.setSelectionAnchor(activeSelectionRowId() ?? nodeId);
    }
    actions.extendSelectionTo(nodeId);
    return;
  }
  const toggle = detectOutlineShortcutPlatform() === "mac"
    ? event.metaKey
    : event.ctrlKey;
  if (toggle) {
    event.preventDefault();
    actions.toggleSelectionNode(nodeId, getSelectionVisibleNodeIds());
    return;
  }
  if (getSelection()) actions.clearSelection();
};
```

Attach this handler to the outer `.notes-node`. Reuse the same Shift/toggle resolution from the bullet handler so the two surfaces cannot diverge.
Add React's `PointerEvent` type to the existing type-only React imports.

- [ ] **Step 5: Add one outline-owned text-drag gesture ref**

```typescript
interface MouseSelectionGesture {
  readonly pointerId: number;
  readonly anchorId: NoteId;
  promoted: boolean;
}

const mouseSelectionGestureRef = useRef<MouseSelectionGesture | null>(null);

const rowIdFromPointerTarget = (target: EventTarget | null): NoteId | null =>
  target instanceof Element
    ? (target.closest<HTMLElement>("[data-outline-id]")?.dataset.outlineId ?? null)
    : null;
```

Add `onPointerDownCapture`, `onPointerMoveCapture`, `onPointerUpCapture`, and `onPointerCancelCapture` to `.notes-outline-list`. Start only on a primary pointer from a title/note text field with no range/toggle modifier. On the first different row:

```typescript
window.getSelection()?.removeAllRanges();
const active = document.activeElement;
if (active instanceof HTMLTextAreaElement && list.contains(active)) {
  active.setSelectionRange(active.selectionStart, active.selectionStart);
  active.blur();
}
actions.setSelectionAnchor(gesture.anchorId);
actions.extendSelectionTo(currentRowId);
gesture.promoted = true;
event.preventDefault();
```

After promotion, subsequent pointer moves only update the head. Pointer up/cancel clears the gesture ref but leaves the row selection active.

- [ ] **Step 6: Run focused and full Notes workspace tests**

Run: `npm test -- src/features/notes/NotesWorkspace.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/features/notes/OutlineNodeRow.tsx \
  src/features/notes/NotesOutlinePane.tsx \
  src/features/notes/NotesWorkspace.test.tsx
git commit -m "feat(notes): add mouse multi-selection"
```

---

### Task 3: Atomic Selection Indentation

**Files:**
- Modify: `src/features/notes/notesSelectionActions.ts:367-400`
- Modify: `src/features/notes/useNotesSelectionCommandRouter.ts:255-268`
- Test: `src/features/notes/notesSelectionActions.test.ts:390-525`
- Test: `src/features/notes/useNotesSelectionCommandRouter.test.tsx:630-680`
- Test: `src/features/notes/NotesWorkspace.test.tsx:4900-4960`

**Interfaces:**
- Consumes: authoritative `NotesSelectionActionSnapshot.eligibility.indent`.
- Produces: all selected structural roots or one exact unavailable reason; never a partial target list.

- [ ] **Step 1: Replace partial-indent expectations with failing atomic expectations**

```typescript
it("rejects the whole selection when its leading root has no outside sibling", () => {
  const result = snapshot(nodes, ["a", "b", "c"], {
    anchorId: "a",
    headId: "c"
  });

  expect(result?.eligibility.indent).toEqual({
    eligible: false,
    reason:
      "Can't indent selection: the first selected item has no preceding sibling outside the selection."
  });
});
```

Update the router integration test to invoke `indent`, expect that exact feedback error, and assert that `applyBatch` was not called.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- src/features/notes/notesSelectionActions.test.ts src/features/notes/useNotesSelectionCommandRouter.test.tsx src/features/notes/NotesWorkspace.test.tsx -t "indent"`

Expected: FAIL because the current eligibility returns `rootIds.slice(1)` and executes a partial batch.

- [ ] **Step 3: Make eligibility all-or-nothing**

```typescript
const INDENT_UNAVAILABLE_REASON =
  "Can't indent selection: the first selected item has no preceding sibling outside the selection.";

function indentEligibility(
  rootIds: readonly NoteId[],
  visibleNodeIds: readonly NoteId[],
  workspace: NormalizedNotesWorkspace
): NotesSelectionEligibility {
  const selectedRoots = new Set(rootIds);
  const visible = new Set(visibleNodeIds);
  const canIndentEveryRoot = rootIds.every((nodeId) => {
    const node = workspace.nodesById[nodeId];
    const siblings = node.parentId === null
      ? workspace.rootIds
      : (workspace.childIdsByParent[node.parentId] ?? []);
    let index = siblings.indexOf(nodeId) - 1;
    while (index >= 0 && selectedRoots.has(siblings[index])) index -= 1;
    return index >= 0 && visible.has(siblings[index]);
  });
  return canIndentEveryRoot
    ? eligibleTargets(rootIds)
    : unavailable(INDENT_UNAVAILABLE_REASON);
}
```

- [ ] **Step 4: Remove the partial-success message from the router**

```typescript
case "indent":
  return eligibleCommand(snapshot.eligibility.indent, (nodeIds) => ({
    kind: "batch",
    nodeIds,
    op: { type: "indent" },
    successStatus: "Indented selection."
  }));
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npm test -- src/features/notes/notesSelectionActions.test.ts src/features/notes/useNotesSelectionCommandRouter.test.tsx src/features/notes/NotesWorkspace.test.tsx -t "indent"`

Expected: PASS with no mutation call in the blocked case.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/features/notes/notesSelectionActions.ts \
  src/features/notes/notesSelectionActions.test.ts \
  src/features/notes/useNotesSelectionCommandRouter.ts \
  src/features/notes/useNotesSelectionCommandRouter.test.tsx \
  src/features/notes/NotesWorkspace.test.tsx
git commit -m "fix(notes): make selection indent atomic"
```

---

### Task 4: Notes Feedback in the Application Status Bar

**Files:**
- Create: `src/features/notes/NotesFeedbackContext.tsx`
- Create: `src/features/notes/NotesFeedbackContext.test.tsx`
- Modify: `src/features/notes/NotesOutlinePane.tsx:2288-2310`
- Modify: `src/features/notes/NotesSelectionActionBar.tsx:37-45, 160-180, 655-672`
- Modify: `src/features/notes/NotesSelectionActionBar.test.tsx`
- Modify: `src/components/AppStatusBar.tsx:1-105`
- Modify: `src/components/AppStatusBar.test.tsx`
- Modify: `src/App.tsx:1700-1880`
- Modify: `src/styles.css:897-975`
- Modify: `src/features/notes/notes.css:519-538`

**Interfaces:**
- Produces: `NotesFeedbackProvider`, `useNotesFeedback()`, `NotesStatusBarMessage`, and `AppStatusBar.feedback?: ReactNode`.
- Consumes: selection router `status`, selection router/chooser/clipboard `error`, and `activeFeatureId === "notes"`.

- [ ] **Step 1: Write failing feedback lifecycle tests**

```typescript
it("shows errors in the status bar and clears them after six seconds", () => {
  vi.useFakeTimers();
  render(
    <NotesFeedbackProvider active>
      <FeedbackPublisher kind="error" message="Can't indent selection." />
      <NotesStatusBarMessage />
    </NotesFeedbackProvider>
  );

  expect(screen.getByRole("alert")).toHaveTextContent("Can't indent selection.");
  act(() => vi.advanceTimersByTime(6000));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  vi.useRealTimers();
});

it("clears Notes feedback when Notes becomes inactive", () => {
  const { rerender } = renderFeedback({ active: true, message: "Moved selection." });
  expect(screen.getByRole("status")).toHaveTextContent("Moved selection.");
  rerender(renderFeedbackTree({ active: false, message: null }));
  expect(screen.queryByText("Moved selection.")).not.toBeInTheDocument();
});
```

Use local test-only publisher/render helpers defined in the test file.

- [ ] **Step 2: Add a failing AppStatusBar slot test**

```typescript
render(
  <AppStatusBar
    feedback={<span role="alert">Can't indent selection.</span>}
    outboxCount={0}
    online
    syncing={false}
    getMetrics={emptyMetrics}
    onOpenOutbox={vi.fn()}
  />
);
expect(within(screen.getByLabelText("Status bar")).getByRole("alert"))
  .toHaveTextContent("Can't indent selection.");
```

- [ ] **Step 3: Run feedback/status tests and verify RED**

Run: `npm test -- src/features/notes/NotesFeedbackContext.test.tsx src/components/AppStatusBar.test.tsx`

Expected: FAIL because the context and status-bar slot do not exist.

- [ ] **Step 4: Implement the focused feedback context**

```typescript
export type NotesFeedback = Readonly<{
  kind: "status" | "error";
  message: string;
}>;

interface NotesFeedbackValue {
  publish(feedback: NotesFeedback): void;
  clear(): void;
  feedback: NotesFeedback | null;
}

export function NotesFeedbackProvider({ active, children }: PropsWithChildren<{
  active: boolean;
}>) {
  const [feedback, setFeedback] = useState<NotesFeedback | null>(null);
  const publish = useCallback((next: NotesFeedback) => setFeedback(next), []);
  const clear = useCallback(() => setFeedback(null), []);
  useEffect(() => {
    if (!active) clear();
  }, [active, clear]);
  useEffect(() => {
    if (!feedback) return;
    const timeout = window.setTimeout(clear, 6000);
    return () => window.clearTimeout(timeout);
  }, [clear, feedback]);
  const value = useMemo(
    () => ({ publish, clear, feedback }),
    [clear, feedback, publish]
  );
  return <NotesFeedbackContext.Provider value={value}>{children}</NotesFeedbackContext.Provider>;
}
```

`NotesStatusBarMessage` returns `null` without feedback; otherwise it renders one `.statusbar-message` span with `role="alert"` for errors or `role="status"` for success.

- [ ] **Step 5: Add the status-bar slot and App provider boundary**

```typescript
interface AppStatusBarProps {
  outboxCount: number;
  online: boolean;
  syncing: boolean;
  getMetrics: () => StatusBarMetrics;
  onOpenOutbox: () => void;
  feedback?: ReactNode;
}

<footer className="app-statusbar" aria-label="Status bar">
  {METRICS_ENABLED && <StatusBarMetricsRow getMetrics={getMetrics} />}
  <div className="statusbar-feedback">{feedback}</div>
  <div className="statusbar-actions">
    <span className="statusbar-state">
      {syncing ? "Syncing" : online ? "Online" : "Offline"}
    </span>
    <IconTooltip label="Outbox stores offline issues and comments waiting to sync to GitHub.">
      <button
        className="status-outbox-button"
        type="button"
        aria-label={`Open outbox, ${outboxCount} pending ${
          outboxCount === 1 ? "change" : "changes"
        }`}
        onClick={onOpenOutbox}
      >
        <Inbox size={14} />
        <span>Outbox {outboxCount}</span>
      </button>
    </IconTooltip>
  </div>
</footer>
```

Wrap the existing application providers/main in:

```typescript
<NotesFeedbackProvider active={activeFeatureId === "notes"}>
  {/* existing providers and main */}
</NotesFeedbackProvider>
```

Pass `<NotesStatusBarMessage />` as `AppStatusBar.feedback`.

- [ ] **Step 6: Publish selection feedback and remove the toolbar status region**

In `NotesOutlinePane`, compute the existing error precedence once and publish it:

```typescript
const selectionFeedbackError =
  selectionChooserFeedback.error ??
  selectionRouter.error ??
  selectionClipboardError;
const { publish: publishNotesFeedback, clear: clearNotesFeedback } =
  useNotesFeedback();

useEffect(() => {
  if (selectionFeedbackError) {
    publishNotesFeedback({ kind: "error", message: selectionFeedbackError });
  } else if (selectionRouter.status) {
    publishNotesFeedback({ kind: "status", message: selectionRouter.status });
  }
}, [publishNotesFeedback, selectionFeedbackError, selectionRouter.status]);
```

Clear feedback with the stable `clearNotesFeedback` callback when the selection revision changes. Remove `status`/`error` props and `.notes-selection-action-status` markup/CSS from `NotesSelectionActionBar`; retain contextual Notes errors unchanged.

- [ ] **Step 7: Run focused and App tests**

Run: `npm test -- src/features/notes/NotesFeedbackContext.test.tsx src/features/notes/NotesSelectionActionBar.test.tsx src/components/AppStatusBar.test.tsx src/App.test.tsx src/features/notes/NotesWorkspace.test.tsx`

Expected: PASS.

- [ ] **Step 8: Commit Task 4**

```bash
git add src/features/notes/NotesFeedbackContext.tsx \
  src/features/notes/NotesFeedbackContext.test.tsx \
  src/features/notes/NotesOutlinePane.tsx \
  src/features/notes/NotesSelectionActionBar.tsx \
  src/features/notes/NotesSelectionActionBar.test.tsx \
  src/features/notes/notes.css \
  src/components/AppStatusBar.tsx \
  src/components/AppStatusBar.test.tsx \
  src/App.tsx src/App.test.tsx src/styles.css
git commit -m "feat(notes): show command feedback in status bar"
```

---

### Task 5: Multi-Row Drag Overlay and Shared Ghost State

**Files:**
- Create: `src/features/notes/NotesSelectionDragPreview.tsx`
- Create: `src/features/notes/NotesSelectionDragPreview.test.tsx`
- Modify: `src/features/notes/NotesOutlinePane.tsx:1-20, 1810-2265, 2420-2525`
- Modify: `src/features/notes/notes.css:1125-1170`
- Test: `src/features/notes/NotesWorkspace.test.tsx`
- Test: `src/features/notes/outlineSelectionDragSession.test.ts`

**Interfaces:**
- Produces: `NotesSelectionDragPreview({ labels, total })` and pane-owned `draggedNodeIds` state.
- Consumes: frozen selected IDs from the existing outline selection-drag session and `NotesFeedbackContext` for rejected group drags.

- [ ] **Step 1: Write a failing preview component test**

```typescript
it("shows three titles and the full selected count", () => {
  render(
    <NotesSelectionDragPreview
      labels={["Alpha", "Bravo", "Charlie", "Delta"]}
      total={4}
    />
  );
  expect(screen.getByText("Alpha")).toBeInTheDocument();
  expect(screen.getByText("Bravo")).toBeInTheDocument();
  expect(screen.getByText("Charlie")).toBeInTheDocument();
  expect(screen.queryByText("Delta")).not.toBeInTheDocument();
  expect(screen.getByText("4 selected")).toBeInTheDocument();
});
```

- [ ] **Step 2: Write failing integration assertions for group dragging**

Extend the existing selected-drag test to assert:

```typescript
expect(screen.getByTestId("notes-selection-drag-preview"))
  .toHaveTextContent("3 selected");
for (const nodeId of ["a", "b", "c"]) {
  expect(outlineRow(nodeId)).toHaveAttribute("data-selection-dragging", "true");
}
```

Add a rejected-drag case that asserts no ordinary one-row move is called and the status bar receives `Can't move selection: the selected rows cannot be moved together.`

- [ ] **Step 3: Run drag tests and verify RED**

Run: `npm test -- src/features/notes/NotesSelectionDragPreview.test.tsx src/features/notes/outlineSelectionDragSession.test.ts src/features/notes/NotesWorkspace.test.tsx -t "drag"`

Expected: FAIL because selected drag ownership has no visual group overlay or shared source state.

- [ ] **Step 4: Implement the compact preview**

```typescript
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
        {labels.slice(0, 3).map((label, index) => (
          <div
            className="notes-selection-drag-preview-row"
            key={`${index}:${label}`}
          >
            {label || "Untitled"}
          </div>
        ))}
      </div>
      <span className="notes-selection-drag-preview-count">{total} selected</span>
    </div>
  );
}
```

- [ ] **Step 5: Bind overlay state to the frozen selected drag**

Import `DragOverlay` from `@dnd-kit/core`. In `handleDragStart`, set `draggedNodeIds` to the exact frozen `selectedNodeIds` for a selected drag and to `[activeId]` for an ordinary drag. Clear it on end and cancel. Derive labels from `state.nodesById` with `noteNodePresentationLabel`.

```tsx
<DragOverlay dropAnimation={null}>
  {draggedNodeIds.length > 1 ? (
    <NotesSelectionDragPreview
      labels={draggedNodeIds.map((id) =>
        noteNodePresentationLabel(state.nodesById[id])
      )}
      total={draggedNodeIds.length}
    />
  ) : null}
</DragOverlay>
```

Set `data-selection-dragging="true"` on every selected source `<li>` while a selected drag is active. CSS gives all sources the same reduced opacity while the overlay carries the moving visual.

- [ ] **Step 6: Surface invalid group ownership without single-row fallback**

When `startOutlineSelectionDragSession` or its pending promotion becomes `selected-invalid`, keep the existing no-fallback behavior, clear preview state, and publish:

```typescript
notesFeedback.publish({
  kind: "error",
  message: "Can't move selection: the selected rows cannot be moved together."
});
```

Update dnd-kit announcements so selected drag start announces the count, for example `Picked up 3 selected notes.` The overlay remains `aria-hidden`.

- [ ] **Step 7: Run focused and full Notes tests**

Run: `npm test -- src/features/notes/NotesSelectionDragPreview.test.tsx src/features/notes/outlineSelectionDragSession.test.ts src/features/notes/NotesWorkspace.test.tsx`

Expected: PASS.

- [ ] **Step 8: Commit Task 5**

```bash
git add src/features/notes/NotesSelectionDragPreview.tsx \
  src/features/notes/NotesSelectionDragPreview.test.tsx \
  src/features/notes/NotesOutlinePane.tsx \
  src/features/notes/notes.css \
  src/features/notes/NotesWorkspace.test.tsx \
  src/features/notes/outlineSelectionDragSession.test.ts
git commit -m "feat(notes): preview selected rows during drag"
```

---

### Task 6: Full Verification and Native UI Check

**Files:**
- Modify only files required to correct failures caused by Tasks 1-5.

**Interfaces:**
- Consumes: every behavior in the approved design.
- Produces: verified web tests, production build, and native Tauri evidence.

- [ ] **Step 1: Run the complete targeted test set**

```bash
npm test -- \
  src/features/notes/notesWorkspaceReducer.test.ts \
  src/features/notes/useNotesWorkspace.test.tsx \
  src/features/notes/notesSelectionActions.test.ts \
  src/features/notes/useNotesSelectionCommandRouter.test.tsx \
  src/features/notes/NotesSelectionActionBar.test.tsx \
  src/features/notes/NotesFeedbackContext.test.tsx \
  src/features/notes/NotesSelectionDragPreview.test.tsx \
  src/features/notes/outlineSelectionDragSession.test.ts \
  src/features/notes/NotesWorkspace.test.tsx \
  src/components/AppStatusBar.test.tsx \
  src/App.test.tsx
```

Expected: every listed test file passes with zero failures.

- [ ] **Step 2: Run static and production checks**

```bash
npm run lint
npm run build
git diff --check
```

Expected: every command exits 0. The existing Vite chunk-size warning is informational.

- [ ] **Step 3: Build and launch the native debug bundle**

```bash
npm run tauri:build -- --debug
```

Launch `src-tauri/target/debug/bundle/macos/Yonalist.app` after closing any other Yonalist instance that holds the Notes vault.

- [ ] **Step 4: Verify the approved mouse behaviors in Tauri**

Verify all of the following against real Notes rows:

1. Plain click edits and clears a previous multi-selection.
2. Shift+click selects a continuous range.
3. Cmd+click adds and removes one row.
4. A same-row text drag selects characters only.
5. A text drag crossing upward or downward becomes whole-row selection.
6. Invalid Tab indentation moves no rows and shows the exact reason in the status bar.
7. A selected bullet drag shows stacked titles, the full count, and ghosts every selected source.
8. Contextual save/attachment errors remain at their source.

- [ ] **Step 5: Inspect the final diff and commit only verification corrections**

```bash
git status --short
git diff --check
git diff --stat
```

If verification required corrections, stage only the relevant Notes/App files and commit them with:

```bash
git commit -m "fix(notes): correct mouse selection verification"
```

Never stage the pre-existing `package-lock.json` change.
