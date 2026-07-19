<!-- reconciliation: auditedHead=ec8a9ff3d016449255992adf70e128ea5e222e9a status=complete -->
> **증거 대조 상태 (2026-07-19): 완료.** commit·artifact 근거는 [감사 ledger](../reports/2026-07-19-historical-plan-ledger.json)에 기록했다.

# Notes Outliner MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Notes shell with a fast, keyboard-friendly, Workflowy-inspired outliner that persists every core tree action through the SQLite command boundary.

**Architecture:** `NotesFeature` supplies a context provider shared by the middle library pane and detail outliner pane. The provider owns normalized UI state and calls `notesStore`; pure reducer, flattening, keyboard, and drop-projection modules make tree behavior testable without React or Tauri.

**Tech Stack:** React 18, TypeScript, Testing Library, Vitest, Base UI, Lucide, @dnd-kit/core 6.3.1, @dnd-kit/sortable 10.0.0, existing Notes Tauri commands.

## Global Constraints

- Consume `src/services/notesStore.ts`; do not import Tauri or SQLite from components.
- Keep Notes feature code independent of GitHub hooks, `vaultStore`, and outbox services.
- Use the existing three-pane shell: application sidebar, Notes library middle pane, and Notes outline detail pane.
- Preserve screen-reader focus and keyboard operation for every pointer action.
- Use native buttons, checkboxes, inputs, menus, and tooltips; do not make text-only rounded controls where a familiar icon control fits.
- Use a custom tree projection on maintained dnd-kit primitives; do not add an unmaintained tree wrapper package.
- Structural commands return the authoritative workspace and replace the local projection after success.

---

## Target File Structure

| File | Responsibility |
| --- | --- |
| `src/features/notes/NotesFeature.tsx` | Registry descriptor and Notes context provider |
| `src/features/notes/NotesWorkspaceContext.ts` | Context and typed hook for shared workspace state |
| `src/features/notes/useNotesWorkspace.ts` | Load/reload/mutation lifecycle and focus handoff |
| `src/features/notes/notesWorkspaceReducer.ts` | Normalized workspace reducer |
| `src/features/notes/outlineTree.ts` | Tree flattening, visible order, parent/child navigation helpers |
| `src/features/notes/outlineKeyboard.ts` | Pure key-to-command resolution |
| `src/features/notes/outlineDrag.ts` | Pure projected-drop calculation |
| `src/features/notes/NotesLibraryPane.tsx` | Root-page library and new-page action |
| `src/features/notes/NotesOutlinePane.tsx` | Breadcrumb, outline, and empty state |
| `src/features/notes/OutlineNodeRow.tsx` | One bullet row, title input, note editor, controls |
| `src/features/notes/notes.css` | Scoped Notes layout and interaction styles |
| `src/features/notes/*.test.ts(x)` | Reducer, keyboard, drag, and UI interaction tests |

## Stable Workspace Interface

```ts
export interface NormalizedNotesWorkspace {
  nodesById: Record<NoteId, NoteNode>;
  childIdsByParent: Record<string, NoteId[]>;
  rootIds: NoteId[];
  selectedId: NoteId | null;
  zoomRootId: NoteId | null;
  editingNoteId: NoteId | null;
  pendingFocusId: NoteId | null;
  status: "loading" | "ready" | "error";
  error: string | null;
}

export interface NotesWorkspaceActions {
  createRoot(): Promise<void>;
  splitNode(nodeId: NoteId, newNodeId: NoteId, prefix: string, suffix: string): Promise<void>;
  createChild(nodeId: NoteId): Promise<void>;
  updateNode(nodeId: NoteId, patch: Pick<NoteNode, "title" | "note">): Promise<void>;
  moveNode(input: MoveNoteNodeInput): Promise<void>;
  toggleComplete(nodeId: NoteId): Promise<void>;
  toggleCollapsed(nodeId: NoteId): Promise<void>;
  duplicateNode(nodeId: NoteId): Promise<void>;
  removeEmptyNode(nodeId: NoteId): Promise<void>;
  deleteNode(nodeId: NoteId): Promise<void>;
  restoreNode(nodeId: NoteId): Promise<void>;
  zoomTo(nodeId: NoteId | null): void;
}
```

### Task 1: Build Testable Normalized Tree and Workspace State

**Files:**
- Create: `src/features/notes/notesWorkspaceReducer.ts`
- Create: `src/features/notes/notesWorkspaceReducer.test.ts`
- Create: `src/features/notes/outlineTree.ts`
- Create: `src/features/notes/outlineTree.test.ts`
- Create: `src/features/notes/NotesWorkspaceContext.ts`
- Create: `src/features/notes/useNotesWorkspace.ts`
- Create: `src/features/notes/useNotesWorkspace.test.tsx`

**Interfaces:**
- Consumes: `NoteNode`, `NotesWorkspace`, and `NotesStore` from Phase 2.
- Produces: `normalizeWorkspace`, `visibleNodeIds`, `parentTrail`, `notesWorkspaceReducer`, and `useNotesWorkspace`.

- [x] **Step 1: Write failing reducer and hook tests**

```ts
it("hides descendants of a collapsed node but keeps their persisted records", () => {
  const state = normalizeWorkspace(workspaceWithCollapsedParent());
  expect(visibleNodeIds(state, state.zoomRootId)).toEqual(["root", "sibling"]);
  expect(state.nodesById.child).toBeDefined();
});

it("replaces local nodes with the authoritative response after a mutation", async () => {
  repository.createNode.mockResolvedValue(workspaceAfterCreate());
  const { result } = renderHook(() => useNotesWorkspace({ vaultRoot: "/vault", repository }));
  await act(() => result.current.actions.createRoot());
  expect(result.current.state.rootIds).toEqual(["page-a", "page-b"]);
});
```

- [x] **Step 2: Run state tests to verify they fail**

Run: `npm test -- src/features/notes/notesWorkspaceReducer.test.ts src/features/notes/outlineTree.test.ts src/features/notes/useNotesWorkspace.test.tsx`

Expected: FAIL because normalized Notes state is absent.

- [x] **Step 3: Implement normalization and mutation lifecycle**

```ts
export function normalizeWorkspace(workspace: NotesWorkspace): NormalizedNotesWorkspace {
  const nodesById = Object.fromEntries(workspace.nodes.map((node) => [node.id, node]));
  const childIdsByParent: Record<string, NoteId[]> = {};
  const rootIds: NoteId[] = [];

  for (const node of [...workspace.nodes].sort((left, right) => left.sortKey - right.sortKey)) {
    if (node.parentId === null) rootIds.push(node.id);
    else (childIdsByParent[node.parentId] ??= []).push(node.id);
  }

  return { nodesById, childIdsByParent, rootIds, selectedId: null, zoomRootId: null,
    editingNoteId: null, pendingFocusId: null, status: "ready", error: null };
}
```

`useNotesWorkspace` calls `repository.initialize(vaultRoot)` and
`repository.loadWorkspace(vaultRoot, { kind: "active" })` once per
vault change. Every command response dispatches `replaceWorkspace`; failures
dispatch `setError` without discarding the last confirmed tree.

- [x] **Step 4: Run state tests to verify they pass**

Run: `npm test -- src/features/notes/notesWorkspaceReducer.test.ts src/features/notes/outlineTree.test.ts src/features/notes/useNotesWorkspace.test.tsx`

Expected: PASS.

- [x] **Step 5: Commit the workspace state layer**

```bash
git add src/features/notes/notesWorkspaceReducer.ts src/features/notes/notesWorkspaceReducer.test.ts src/features/notes/outlineTree.ts src/features/notes/outlineTree.test.ts src/features/notes/NotesWorkspaceContext.ts src/features/notes/useNotesWorkspace.ts src/features/notes/useNotesWorkspace.test.tsx
git commit -m "feat(notes): add normalized workspace state"
```

### Task 2: Render Notes Library, Breadcrumb, and Inline Editor

**Files:**
- Modify: `src/features/notes/NotesFeature.tsx`
- Create: `src/features/notes/NotesLibraryPane.tsx`
- Create: `src/features/notes/NotesOutlinePane.tsx`
- Create: `src/features/notes/OutlineNodeRow.tsx`
- Create: `src/features/notes/notes.css`
- Create: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**
- Consumes: `NotesWorkspaceContext` and `visibleNodeIds` from Task 1.
- Produces: the feature provider and accessible Notes middle/detail panes used by the registry.

- [x] **Step 1: Write failing component tests for root pages and zoom**

```tsx
function renderNotesWorkspace() {
  return render(
    <NotesWorkspaceProvider>
      <NotesLibraryPane />
      <NotesOutlinePane />
    </NotesWorkspaceProvider>
  );
}

it("creates a root page from the library and focuses its title", async () => {
  renderNotesWorkspace();
  await userEvent.setup().click(screen.getByRole("button", { name: "New page" }));
  expect(repository.createNode).toHaveBeenCalledWith("/vault", expect.objectContaining({ parentId: null }));
  expect(await screen.findByRole("textbox", { name: "Edit node title" })).toHaveFocus();
});

it("shows only the zoomed subtree and its breadcrumb", async () => {
  renderNotesWorkspace();
  await userEvent.setup().doubleClick(screen.getByRole("textbox", { name: "Edit node title: Project" }));
  expect(screen.getByLabelText("Notes breadcrumb")).toHaveTextContent("Project");
  expect(screen.queryByText("Outside branch")).not.toBeInTheDocument();
});
```

- [x] **Step 2: Run component tests to verify they fail**

Run: `npm test -- src/features/notes/NotesWorkspace.test.tsx`

Expected: FAIL because the Notes shell has no working editor.

- [x] **Step 3: Replace placeholders with the full two-pane Notes workspace**

```tsx
export function NotesWorkspaceProvider({ children }: PropsWithChildren) {
  const vaultRoot = useContext(VaultRootContext);
  const workspace = useNotesWorkspace({ vaultRoot, repository: notesStore });
  return <NotesWorkspaceContext.Provider value={workspace}>{children}</NotesWorkspaceContext.Provider>;
}

export function NotesOutlinePane() {
  const { state } = useNotesWorkspaceContext();
  return (
    <div className="notes-outline" aria-label="Notes outline">
      <NotesBreadcrumb />
      <div className="notes-outline-rows">
        {visibleNodeIds(state, state.zoomRootId).map((id) => <OutlineNodeRow key={id} nodeId={id} />)}
      </div>
    </div>
  );
}
```

Keep `NotesFeatureProvider` exported from `NotesFeature.tsx` as the registry
provider; after this task it delegates to `NotesWorkspaceProvider`. Update the
Phase 1 `NotesFeature.test.tsx` to render the working provider and panes rather
than the removed placeholder components.

Use a native checkbox for completion, icon buttons with `IconTooltip` for
collapse/expand and duplicate/delete actions, and a controlled title input.
Supporting-note editing is a compact textarea directly below its node, toggled
by an icon button. The middle pane lists root pages and provides a `New page`
command; it does not render nested cards.

- [x] **Step 4: Run component tests to verify they pass**

Run: `npm test -- src/features/notes/NotesWorkspace.test.tsx`

Expected: PASS.

- [x] **Step 5: Commit the visible Notes workspace**

```bash
git add src/features/notes/NotesFeature.tsx src/features/notes/NotesFeature.test.tsx src/features/notes/NotesLibraryPane.tsx src/features/notes/NotesOutlinePane.tsx src/features/notes/OutlineNodeRow.tsx src/features/notes/notes.css src/features/notes/NotesWorkspace.test.tsx
git commit -m "feat(notes): render workflowy style outline workspace"
```

### Task 3: Define and Implement Keyboard Tree Semantics

**Files:**
- Create: `src/features/notes/outlineKeyboard.ts`
- Create: `src/features/notes/outlineKeyboard.test.ts`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/useNotesWorkspace.ts`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**
- Consumes: visible order/parent helpers from Task 1 and workspace actions from Task 2.
- Produces: `resolveOutlineKey` and one keyboard operation contract for every editable row.

- [x] **Step 1: Write failing pure keyboard tests**

```ts
it("outdents a node immediately after its former parent", () => {
  const action = resolveOutlineKey(keyEvent("Tab", { shiftKey: true }), treeState, "child");
  expect(action).toEqual({ type: "move", id: "child", parentId: null, afterId: "parent" });
});

it("splits the title at the caret when Enter creates a sibling", () => {
  const action = resolveOutlineKey(keyEvent("Enter"), treeState, "task", { value: "alpha beta", selectionStart: 5 });
  expect(action).toEqual({ type: "createSibling", id: "task", prefix: "alpha", suffix: " beta" });
});
```

- [x] **Step 2: Run keyboard tests to verify they fail**

Run: `npm test -- src/features/notes/outlineKeyboard.test.ts`

Expected: FAIL because no key resolver exists.

- [x] **Step 3: Implement fixed keyboard behavior**

```ts
export type OutlineKeyAction =
  | { type: "createSibling"; id: NoteId; prefix: string; suffix: string }
  | { type: "createChild"; id: NoteId }
  | { type: "move"; id: NoteId; parentId: NoteId | null; afterId: NoteId | null }
  | { type: "focus"; id: NoteId }
  | { type: "toggleCollapsed"; id: NoteId }
  | { type: "removeEmpty"; id: NoteId };
```

Apply these exact rules:

- Enter splits the title at the selection and creates a sibling after the node.
- Tab makes the node a child of its immediate previous visible sibling; no
  previous sibling leaves the tree unchanged.
- Shift+Tab makes the node a sibling immediately after its parent; root nodes
  stay put.
- ArrowUp/ArrowDown focus the previous/next visible node.
- ArrowLeft collapses an expanded node, otherwise focuses its parent.
- ArrowRight expands a collapsed node, otherwise focuses its first visible child.
- Backspace on an empty title and empty supporting note removes a leaf and
  focuses the prior visible node; an empty node with children lifts its
  children into the node's parent at the node's position before deletion.

`createSibling` key actions call `splitNode` with a newly generated UUID so the
prefix update and new sibling are one database transaction. Empty-node removal
calls `removeEmptyNode`, which preserves children in the same transaction.
Every structural action awaits its authoritative workspace, then focuses the
action's deterministic target via `pendingFocusId`.

- [x] **Step 4: Run keyboard unit and component tests to verify they pass**

Run: `npm test -- src/features/notes/outlineKeyboard.test.ts src/features/notes/NotesWorkspace.test.tsx`

Expected: PASS, including focus restoration after create, remove, indent, and outdent.

- [x] **Step 5: Commit keyboard navigation**

```bash
git add src/features/notes/outlineKeyboard.ts src/features/notes/outlineKeyboard.test.ts src/features/notes/OutlineNodeRow.tsx src/features/notes/useNotesWorkspace.ts src/features/notes/NotesWorkspace.test.tsx
git commit -m "feat(notes): add keyboard outline editing"
```

### Task 4: Add Accessible Drag Ordering and Complete MVP Verification

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/features/notes/outlineDrag.ts`
- Create: `src/features/notes/outlineDrag.test.ts`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**
- Consumes: `MoveNoteNodeInput`, flattened visible nodes, and workspace `moveNode` action.
- Produces: `projectOutlineDrop(activeId, overId, horizontalOffset, flattened)` returning `{ parentId, afterId } | null`.

- [x] **Step 1: Write failing projected-drop tests**

```ts
it("projects a rightward drop as the last child of the previous row", () => {
  expect(projectOutlineDrop("task-b", "task-a", 28, flattenedRows)).toEqual({
    parentId: "task-a",
    afterId: lastChildId("task-a", flattenedRows)
  });
});

it("never projects a node under its descendant", () => {
  expect(projectOutlineDrop("parent", "child", 28, flattenedRows)).toBeNull();
});
```

- [x] **Step 2: Run drag tests to verify they fail**

Run: `npm test -- src/features/notes/outlineDrag.test.ts`

Expected: FAIL because no projection helper exists.

- [x] **Step 3: Install maintained drag primitives and wire the outline**

```bash
npm install @dnd-kit/core@6.3.1 @dnd-kit/sortable@10.0.0
```

```tsx
<DndContext
  sensors={sensors}
  accessibility={{ screenReaderInstructions: koreanOutlineInstructions }}
  onDragEnd={handleDragEnd}
>
  <SortableContext items={visibleIds} strategy={verticalListSortingStrategy}>
    {visibleIds.map((id) => <OutlineNodeRow key={id} nodeId={id} />)}
  </SortableContext>
</DndContext>
```

Use a dedicated drag-handle button so text editing remains natural. `handleDragEnd`
calls `projectOutlineDrop`; a null result cancels the drag, and a valid result
calls `moveNode`. Keep Space/Enter pickup, Arrow movement, Escape cancel, and
localized screen-reader instructions required by dnd-kit accessibility support.

- [x] **Step 4: Run drag, accessibility, and full MVP tests**

Run: `npm test -- src/features/notes/outlineDrag.test.ts src/features/notes/NotesWorkspace.test.tsx && npm run build`

Expected: PASS with no TypeScript errors.

- [x] **Step 5: Commit the outliner MVP**

```bash
git add package.json package-lock.json src/features/notes
git commit -m "feat(notes): add accessible outline drag ordering"
```
