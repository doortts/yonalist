# Yonalist v2 Performance Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate title and note drafts to their owning rows, reduce coordinator
responsibilities, remove the instructional preview bullet, and preserve the
existing split-pane and multi-selection behavior without changing the design.

**Architecture:** Keep `NotesStore` as the frontend façade but publish cached
shell, outline, and per-node projections through a focused subscription hub.
Move draft and command coordination into collaborators, make outline rows read
their own node projection, and keep structural selection and drag state pane
local.

**Tech Stack:** React 19, TypeScript, `useSyncExternalStore`, Vitest, Tauri v2,
Rust workspace tests, SQLite performance fixtures, Vite.

## Global Constraints

- The visual layout, CSS tokens, spacing, typography, colors, window chrome,
  and control placement must not change.
- Vault synchronization, GitHub Notifications, image persistence, image
  rendering, and image-atom editing are outside this plan.
- The existing SQLite schema, IPC payloads, and Rust production code must not
  change.
- A title or note keystroke must notify only its owning node subscription.
- The preview must not create `Press Enter to add another thought.`.
- Empty bullets render an empty editor and caret without instructional text.
- Accepted multi-node structural actions remain one IPC command and one
  session-history entry.
- Do not add list virtualization or replace textarea editing with
  `contenteditable`.
- Initial editable JavaScript must remain at or below 300KB raw and 90KB gzip.
- Input-to-screen p95 remains at or below 20ms with no task above 50ms in the
  fixed input guard.

---

### Task 1: Add cached shell, outline, and node projections

**Files:**
- Create: `apps/desktop/src/storeSubscriptions.ts`
- Create: `apps/desktop/src/storeSubscriptions.test.ts`
- Modify: `apps/desktop/src/notesState.ts`

**Interfaces:**
- Consumes: `NotesState`, `NoteView`, and `PageSummary`.
- Produces:

```ts
export interface NotesShellSnapshot {
  readonly status: NotesState["status"];
  readonly sessionId: string | null;
  readonly revision: number;
  readonly pages: readonly PageSummary[];
  readonly activePageId: string | null;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoDepth: number;
  readonly redoDepth: number;
  readonly beforeCursor: string | null;
  readonly afterCursor: string | null;
  readonly error: string | null;
  readonly pendingWrites: number;
}

export interface NotesOutlineSnapshot {
  readonly revision: number;
  readonly nodes: readonly NoteView[];
  readonly beforeCursor: string | null;
  readonly afterCursor: string | null;
}

export interface NotesNodeSnapshot {
  readonly node: NoteView | null;
  readonly title: string;
  readonly note: string;
  readonly titleDraft: string | undefined;
  readonly noteDraft: string | undefined;
}

export interface StoreInvalidation {
  readonly shell?: boolean;
  readonly outline?: boolean;
  readonly nodeIds?: readonly string[];
}
```

- `StoreSubscriptions` exposes `subscribeShell`, `getShellSnapshot`,
  `subscribeOutline`, `getOutlineSnapshot`, `subscribeNode`,
  `getNodeSnapshot`, `subscribeNodes`, `getNodeEpoch`, and
  `publish(invalidation)`.

- [ ] **Step 1: Write the failing 800-node projection test**

Create literal `NoteView` fixtures whose IDs are `node-0` through `node-799`.
The test must prove the production break: a draft-only state change must not
change shell or outline projection identity or notify an adjacent row.

```ts
function notesStateWithNodes(count: number): NotesState {
  return {
    ...initialNotesState,
    status: "ready",
    sessionId: "session-1",
    revision: 1,
    activePageId: "page-1",
    pages: [{ id: "page-1", title: "Page" }],
    nodes: Array.from({ length: count }, (_, index) => ({
      id: `node-${index}`,
      parentId: "page-1",
      sortKey: (index + 1) * 1_024,
      kind: "bullet" as const,
      text: `Node ${index}`,
      note: "",
      marker: "bullet" as const,
      collapsed: false,
      completed: false,
      starred: false,
      deleted: false
    }))
  };
}

it("publishes an 800-node draft only to its owning row", () => {
  let state = notesStateWithNodes(800);
  const subscriptions = new StoreSubscriptions(() => state);
  const shellBefore = subscriptions.getShellSnapshot();
  const outlineBefore = subscriptions.getOutlineSnapshot();
  const changed = vi.fn();
  const adjacent = vi.fn();
  const shell = vi.fn();
  const outline = vi.fn();
  subscriptions.subscribeNode("node-400", changed);
  subscriptions.subscribeNode("node-399", adjacent);
  subscriptions.subscribeShell(shell);
  subscriptions.subscribeOutline(outline);

  state = {
    ...state,
    drafts: { ...state.drafts, "node-400": "edited" }
  };
  subscriptions.publish({ nodeIds: ["node-400"] });

  expect(subscriptions.getShellSnapshot()).toBe(shellBefore);
  expect(subscriptions.getOutlineSnapshot()).toBe(outlineBefore);
  expect(subscriptions.getNodeSnapshot("node-400")?.title).toBe("edited");
  expect(changed).toHaveBeenCalledOnce();
  expect(adjacent).not.toHaveBeenCalled();
  expect(shell).not.toHaveBeenCalled();
  expect(outline).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the projection test and verify RED**

Run:

```powershell
npm run test --prefix apps/desktop -- src/storeSubscriptions.test.ts
```

Expected: FAIL because `./storeSubscriptions` does not exist.

- [ ] **Step 3: Implement cached projections and exact invalidation**

`StoreSubscriptions` owns separate listener sets and cached snapshot objects.
`publish` rebuilds only the projections named by `StoreInvalidation`, rebuilds
only the named node snapshots, increments those nodes' epochs, and then calls
the matching listeners.

Use the active `PageSummary` as the title fallback when a page node is absent
from the bounded node viewport:

```ts
function nodeSnapshot(state: NotesState, id: string): NotesNodeSnapshot {
  const node = state.nodes.find((candidate) => candidate.id === id) ?? null;
  const page = state.pages.find((candidate) => candidate.id === id);
  const confirmedTitle = node?.text ?? page?.title ?? "";
  return {
    node,
    titleDraft: state.drafts[id],
    noteDraft: state.noteDrafts[id],
    title: state.drafts[id] ?? confirmedTitle,
    note: state.noteDrafts[id] ?? node?.note ?? ""
  };
}
```

`getNodeEpoch(ids)` returns one cached primitive string built from each ID and
its integer epoch, so `useSyncExternalStore` receives the same value until one
selected node changes.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
npm run test --prefix apps/desktop -- src/storeSubscriptions.test.ts
```

Expected: PASS with the 800-node identity and listener assertions.

- [ ] **Step 5: Commit the projection boundary**

```powershell
git add apps/desktop/src/storeSubscriptions.ts apps/desktop/src/storeSubscriptions.test.ts apps/desktop/src/notesState.ts
git commit -m "perf(v2): isolate note subscriptions"
```

### Task 2: Route store updates through the smallest invalidation

**Files:**
- Modify: `apps/desktop/src/notesStore.ts`
- Modify: `apps/desktop/src/notesStore.test.ts`
- Modify: `apps/desktop/src/storeState.ts`
- Test: `apps/desktop/src/storeSubscriptions.test.ts`

**Interfaces:**
- Consumes: `StoreSubscriptions` and `StoreInvalidation` from Task 1.
- Produces the React-facing methods on `NotesStore`:

```ts
readonly subscribeShell = (listener: () => void) =>
  this.subscriptions.subscribeShell(listener);
readonly getShellSnapshot = () =>
  this.subscriptions.getShellSnapshot();
readonly subscribeOutline = (listener: () => void) =>
  this.subscriptions.subscribeOutline(listener);
readonly getOutlineSnapshot = () =>
  this.subscriptions.getOutlineSnapshot();
readonly subscribeNode = (id: string, listener: () => void) =>
  this.subscriptions.subscribeNode(id, listener);
readonly getNodeSnapshot = (id: string) =>
  this.subscriptions.getNodeSnapshot(id);
readonly subscribeNodes = (ids: readonly string[], listener: () => void) =>
  this.subscriptions.subscribeNodes(ids, listener);
readonly getNodeEpoch = (ids: readonly string[]) =>
  this.subscriptions.getNodeEpoch(ids);
```

- Replaces unqualified `update(patch)` with:

```ts
private update(
  patch: Partial<NotesState>,
  invalidation: StoreInvalidation
): void
```

- [ ] **Step 1: Add failing store-level draft and receipt tests**

Add two tests using the real `NotesStore`.

```ts
it("does not publish shell or outline work for a title draft", async () => {
  const notesApi = api(vi.fn());
  const store = new NotesStore(notesApi);
  await store.bootstrap();
  const shell = vi.fn();
  const outline = vi.fn();
  const changed = vi.fn();
  const adjacent = vi.fn();
  store.subscribeShell(shell);
  store.subscribeOutline(outline);
  store.subscribeNode("one", changed);
  store.subscribeNode("two", adjacent);

  store.setDraft("one", "local");

  expect(changed).toHaveBeenCalledOnce();
  expect(adjacent).not.toHaveBeenCalled();
  expect(shell).not.toHaveBeenCalled();
  expect(outline).not.toHaveBeenCalled();
});

it("keeps a confirmed text receipt out of the structural projection", async () => {
  const notesApi = api(vi.fn());
  notesApi.execute = vi.fn().mockResolvedValue({
    revision: 2,
    changedNodes: [{ ...bullet("one", 1_024), text: "confirmed" }],
    deletedIds: [],
    history: {
      canUndo: true,
      canRedo: false,
      undoDepth: 1,
      redoDepth: 0
    }
  });
  const store = new NotesStore(notesApi);
  await store.bootstrap();
  const outlineBefore = store.getOutlineSnapshot();
  store.setDraft("one", "confirmed");
  await store.flushDraft("one");

  expect(store.getOutlineSnapshot()).toBe(outlineBefore);
  expect(store.getNodeSnapshot("one")?.title).toBe("confirmed");
});
```

The API fixture for the second test returns a receipt that changes only
`text`, revision, and history.

- [ ] **Step 2: Run the store tests and verify RED**

Run:

```powershell
npm run test --prefix apps/desktop -- src/notesStore.test.ts src/storeSubscriptions.test.ts
```

Expected: FAIL because `NotesStore` still has one global listener channel.

- [ ] **Step 3: Classify receipt changes by observable structure**

Add this pure comparison to `storeState.ts` and cover it with literal old/new
nodes:

```ts
export function changesOutlineStructure(
  previous: NoteView | undefined,
  next: NoteView
): boolean {
  return !previous ||
    previous.parentId !== next.parentId ||
    previous.sortKey !== next.sortKey ||
    previous.kind !== next.kind ||
    previous.marker !== next.marker ||
    previous.collapsed !== next.collapsed ||
    previous.completed !== next.completed ||
    previous.starred !== next.starred ||
    previous.deleted !== next.deleted;
}
```

`receiptState` returns `changedNodeIds` and `outlineChanged` in addition to its
state patch. Additions, deletions, or any structural-field change set
`outlineChanged` to true. A text/note-only receipt sets it to false.

- [ ] **Step 4: Integrate projection publication**

Construct `StoreSubscriptions` with `() => this.state`. Bootstrap, page open,
viewport append/replacement, optimistic create/split/remove/merge, and
structural receipts publish shell + outline + affected nodes.

Title and note keystrokes publish only their node. Pending writes, errors, and
history publish shell. Confirmed text/note receipts publish shell and affected
nodes but not outline. Removed nodes cancel timers before their node listeners
are notified.

Keep `getSnapshot` for command coordination and non-React imperative reads; do
not connect React components to its legacy global subscription.

- [ ] **Step 5: Run focused store tests and verify GREEN**

Run:

```powershell
npm run test --prefix apps/desktop -- src/notesStore.test.ts src/storeSubscriptions.test.ts src/storeState.test.ts
```

Expected: PASS, including optimistic split/merge rollback, stale viewport, and
draft history-group coverage.

- [ ] **Step 6: Commit store invalidation routing**

```powershell
git add apps/desktop/src/notesStore.ts apps/desktop/src/notesStore.test.ts apps/desktop/src/storeState.ts apps/desktop/src/storeState.test.ts
git commit -m "perf(v2): publish targeted note updates"
```

### Task 3: Make rows consume their own node state

**Files:**
- Create: `apps/desktop/src/useNotesNode.ts`
- Create: `apps/desktop/src/useNotesNode.test.tsx`
- Create: `apps/desktop/src/test/notesStoreFixture.ts`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/NotesOutline.tsx`
- Modify: `apps/desktop/src/OutlineHeader.tsx`
- Modify: `apps/desktop/src/OutlineRow.tsx`
- Modify: `apps/desktop/src/LibraryPageRow.tsx`
- Modify: `apps/desktop/src/useOutlineSelection.ts`
- Modify: `apps/desktop/src/useOutlineDrag.ts`
- Modify: `apps/desktop/src/App.test.tsx`
- Modify: `apps/desktop/src/outlineClipboardIntegration.test.tsx`

**Interfaces:**
- Consumes: Task 2's `NotesStore` subscription methods.
- Produces:

```ts
export function useNotesNode(
  store: NotesStore,
  nodeId: string
): NotesNodeSnapshot
```

- `NotesOutline` receives `store` and pane/navigation props but no complete
  `NotesState`. It receives `status`, `error`, and `pendingWrites` as scalar
  shell props for loading, feedback, and toolbar busy state, and subscribes to
  `NotesOutlineSnapshot` for structure.
- `OutlineRow` receives `nodeId` plus structural/pane props and obtains current
  title, note, drafts, and confirmed node through `useNotesNode`.
- `useOutlineSelection` reads clipboard content from current store state at
  action time and subscribes to `getNodeEpoch(selectedIds)` only while a
  selection exists.

- [ ] **Step 1: Write the failing real-hook isolation test**

Render two probe components using the real store and the wished-for
`useNotesNode` hook. Count the probe function executions, not a mocked row or
mocked subscription.

```ts
// test/notesStoreFixture.ts
export async function readyRealStore(): Promise<NotesStore> {
  const boot: BootSnapshot = {
    sessionId: "session-1",
    revision: 1,
    activePageId: "page-1",
    pages: [{ id: "page-1", title: "Page" }],
    viewport: {
      pageId: "page-1",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      nodes: ["one", "two"].map((id, index) => ({
        id,
        parentId: "page-1",
        sortKey: (index + 1) * 1_024,
        kind: "bullet" as const,
        text: id,
        note: "",
        marker: "bullet" as const,
        collapsed: false,
        completed: false,
        starred: false,
        deleted: false
      }))
    },
    history: {
      canUndo: false,
      canRedo: false,
      undoDepth: 0,
      redoDepth: 0
    }
  };
  const api: NotesApi = {
    bootstrap: vi.fn().mockResolvedValue(boot),
    queryViewport: vi.fn(),
    queryForest: vi.fn().mockResolvedValue({
      revision: 1,
      nodes: [],
      complete: true
    }),
    execute: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    search: vi.fn(),
    closeSession: vi.fn()
  };
  const store = new NotesStore(api);
  await store.bootstrap();
  return store;
}

// useNotesNode.test.tsx
it("rerenders only the probe whose node draft changed", async () => {
  const store = await readyRealStore();
  const renders = new Map<string, number>();
  function Probe({ id }: { readonly id: string }) {
    const state = useNotesNode(store, id);
    renders.set(id, (renders.get(id) ?? 0) + 1);
    return <output data-testid={id}>{state.title}</output>;
  }
  render(<><Probe id="one" /><Probe id="two" /></>);

  act(() => store.setDraft("one", "Focused edit"));

  expect(screen.getByTestId("one")).toHaveTextContent("Focused edit");
  expect(screen.getByTestId("two")).toHaveTextContent("two");
  expect(renders).toEqual(new Map([["one", 2], ["two", 1]]));
});
```

`readyRealStore` constructs the existing `NotesStore` with the complete
`NotesApi` fixture from `notesStore.test.ts`, calls `bootstrap`, and returns
the store. Put the shared fixture in `test/notesStoreFixture.ts` rather than
copying an incomplete mock.

- [ ] **Step 2: Run the React test and verify RED**

Run:

```powershell
npm run test --prefix apps/desktop -- src/useNotesNode.test.tsx
```

Expected: FAIL because `./useNotesNode` does not exist.

- [ ] **Step 3: Add node and selected-node hooks**

`useNotesNode` uses `useSyncExternalStore` with one node subscription.
`useOutlineSelection` derives a selected-node epoch:

```ts
const selectedEpoch = useSyncExternalStore(
  useCallback(
    (listener) => store.subscribeNodes(selectedIds, listener),
    [selectedIds, store]
  ),
  useCallback(
    () => store.getNodeEpoch(selectedIds),
    [selectedIds, store]
  )
);
```

After `selectedEpoch` changes, clipboard and cut eligibility read the current
confirmed nodes and drafts from `store.getSnapshot()`. Structural range and
root calculations continue to use the pane's stable outline nodes.

- [ ] **Step 4: Remove content reads from structural row props**

`OutlineRow`, `OutlineHeader`, and `LibraryPageRow` render current content from
`useNotesNode`. `NotesOutline` may use its cached outline nodes only for ID,
parent, order, marker, completion, collapse, and selection geometry.

Replace the old `state` prop with the exact scalar shell fields still consumed
by the pane:

```ts
interface NotesOutlineProps {
  readonly store: NotesStore;
  readonly status: NotesShellSnapshot["status"];
  readonly error: string | null;
  readonly pendingWrites: number;
  // Existing page, pane, zoom, restore, tag, and close props remain unchanged.
}
```

Pass `labelForId: (id) => store.getNodeSnapshot(id)?.title ?? ""` to
`useOutlineDrag` so drag previews do not read stale structural text.

Use the outline projection inside `NotesOutline`:

```ts
const state = useSyncExternalStore(
  store.subscribeOutline,
  store.getOutlineSnapshot
);
```

Use the shell projection inside `App`:

```ts
const state = useSyncExternalStore(
  store.subscribeShell,
  store.getShellSnapshot
);
```

- [ ] **Step 5: Verify row editing and selection remain GREEN**

Run:

```powershell
npm run test --prefix apps/desktop -- src/App.test.tsx src/outlineClipboardIntegration.test.tsx src/navigationHistoryIntegration.test.tsx
```

Expected: PASS for immediate drafts, Korean IME, repeated keys, structural
clipboard, selection moves, drag/drop, and split navigation.

- [ ] **Step 6: Commit row-owned rendering**

```powershell
git add apps/desktop/src/useNotesNode.ts apps/desktop/src/useNotesNode.test.tsx apps/desktop/src/test/notesStoreFixture.ts apps/desktop/src/App.tsx apps/desktop/src/NotesOutline.tsx apps/desktop/src/OutlineHeader.tsx apps/desktop/src/OutlineRow.tsx apps/desktop/src/LibraryPageRow.tsx apps/desktop/src/useOutlineSelection.ts apps/desktop/src/useOutlineDrag.ts apps/desktop/src/App.test.tsx apps/desktop/src/outlineClipboardIntegration.test.tsx
git commit -m "perf(v2): render drafts in owning rows"
```

### Task 4: Split store and app responsibilities without behavior changes

**Files:**
- Create: `apps/desktop/src/storeCommands.ts`
- Create: `apps/desktop/src/storeCommands.test.ts`
- Create: `apps/desktop/src/storeDrafts.ts`
- Create: `apps/desktop/src/storeDrafts.test.ts`
- Create: `apps/desktop/src/appNavigation.ts`
- Create: `apps/desktop/src/appNavigation.test.ts`
- Create: `apps/desktop/src/NotesDetailPanes.tsx`
- Create: `apps/desktop/src/splitPaneIntegration.test.tsx`
- Modify: `apps/desktop/src/notesStore.ts`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/App.test.tsx`
- Modify: `apps/desktop/src/navigationHistoryIntegration.test.tsx`

**Interfaces:**
- Consumes: the projection and row boundaries from Tasks 1-3.
- Produces:

```ts
export interface StoreCommandHost {
  readonly read: () => NotesState;
  readonly write: (
    patch: Partial<NotesState>,
    invalidation: StoreInvalidation
  ) => void;
  readonly applyReceipt: (receipt: MutationReceipt) => void;
}

export class StoreCommands {
  execute(
    command: IpcNotesCommand,
    historyGroup?: string | null
  ): Promise<MutationReceipt>;
  executeHistory(direction: "undo" | "redo"): Promise<void>;
  settled(): Promise<void>;
}

export interface StoreDraftHost {
  readonly read: () => NotesState;
  readonly write: StoreCommandHost["write"];
  readonly execute: StoreCommands["execute"];
  readonly settled: StoreCommands["settled"];
  readonly breakHistoryGroup: () => void;
}

export class StoreDrafts {
  setTitle(id: string, text: string): void;
  flushTitle(id: string): Promise<void>;
  setNote(id: string, note: string): void;
  flushNote(id: string): Promise<void>;
  flushAll(): Promise<void>;
  beginBackspace(repeat: boolean): string;
  endBackspace(): void;
  cancel(ids: readonly string[]): void;
}
```

- `appNavigation.ts` exports `AppNavigationLocation`, `capturePane`, and
  `emptyPaneLocation`.
- `NotesDetailPanes` owns only the detail-pane DOM, split divider, and the two
  `NotesOutline` instances.

- [ ] **Step 1: Add failing collaborator tests around observable sequencing**

Move the existing command-queue, history-group, flush-before-Undo, and close
drain cases into focused `StoreCommands` and `StoreDrafts` tests. Keep real
`NotesState` transitions and the existing API fake. The break each test catches
must be a reordered command, an unflushed draft, or a split history group.

Add pure navigation tests:

```ts
function paneFixture(): string {
  return `
    <section data-outline-pane-id="primary">
      <div data-outline-id="primary-selected" data-selected="true"></div>
    </section>
    <section data-outline-pane-id="secondary">
      <div data-outline-id="secondary-selected" data-selected="true"></div>
      <textarea
        data-node-id="secondary-focused"
        data-outline-field="title"
      >text</textarea>
    </section>
  `;
}

it("captures selection and focus only from the requested split pane", () => {
  document.body.innerHTML = paneFixture();
  const editor = document.querySelector<HTMLTextAreaElement>(
    "[data-node-id='secondary-focused']"
  )!;
  editor.focus();
  editor.setSelectionRange(2, 4);
  expect(capturePane("secondary")).toEqual({
    selectedIds: ["secondary-selected"],
    focus: {
      nodeId: "secondary-focused",
      field: "title",
      selectionStart: 2,
      selectionEnd: 4
    }
  });
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npm run test --prefix apps/desktop -- src/storeCommands.test.ts src/storeDrafts.test.ts src/appNavigation.test.ts
```

Expected: FAIL because the collaborators and navigation module do not exist.

- [ ] **Step 3: Extract command and draft collaborators**

Move the current behavior without changing IPC payloads:

- `StoreCommands` owns `executeCommand`, history execution, queue chaining,
  pending-write publication, and API error publication.
- `StoreDrafts` owns draft timers, note timers, draft history groups,
  Backspace gesture groups, flush barriers, and timer cancellation.
- `NotesStore` delegates its existing public method names to the collaborators
  and retains optimistic tree operations and feature commands.

Do not introduce a generic dependency-injection container. Construct both
collaborators directly in `NotesStore` with typed host objects.

- [ ] **Step 4: Extract navigation and detail panes**

Move `AppNavigationLocation` and `capturePane` unchanged into
`appNavigation.ts`. Move the current detail-pane JSX into
`NotesDetailPanes.tsx`; preserve every class name, inline CSS variable, ARIA
attribute, divider key handler, and pane ID.

Wrap `NotesDetailPanes` in `memo`. Its props contain the stable `store`, active
page identity, zoom locations, restoration requests, and `useCallback`-backed
navigation handlers. A shell-only Saving/error update must therefore not
reconcile the row subtree.

Move split open/resize/close tests from `App.test.tsx` into
`splitPaneIntegration.test.tsx`, using the real `App` and API fixture rather
than mocking `NotesDetailPanes`.

- [ ] **Step 5: Run all owning frontend tests and architecture budget**

Run:

```powershell
npm run test --prefix apps/desktop -- src/notesStore.test.ts src/storeCommands.test.ts src/storeDrafts.test.ts src/appNavigation.test.ts src/App.test.tsx src/splitPaneIntegration.test.tsx src/navigationHistoryIntegration.test.tsx
npm run test:v2:architecture
```

Expected: all tests pass; `notesStore.ts` and `App.test.tsx` no longer exceed
their advisory budgets. Existing Rust test-file advisories may remain because
this task changes no Rust file.

- [ ] **Step 6: Commit responsibility splits**

```powershell
git add apps/desktop/src/storeCommands.ts apps/desktop/src/storeCommands.test.ts apps/desktop/src/storeDrafts.ts apps/desktop/src/storeDrafts.test.ts apps/desktop/src/appNavigation.ts apps/desktop/src/appNavigation.test.ts apps/desktop/src/NotesDetailPanes.tsx apps/desktop/src/splitPaneIntegration.test.tsx apps/desktop/src/notesStore.ts apps/desktop/src/App.tsx apps/desktop/src/App.test.tsx apps/desktop/src/navigationHistoryIntegration.test.tsx
git commit -m "refactor(v2): split notes coordinators"
```

### Task 5: Remove the instructional seed and freeze interaction parity

**Files:**
- Modify: `apps/desktop/src/previewOutline.ts`
- Modify: `apps/desktop/src/previewApi.test.ts`
- Modify: `apps/desktop/src/App.test.tsx`
- Modify: `apps/desktop/src/outlineClipboardIntegration.test.tsx`
- Modify: `docs/v2/feature-parity-matrix.md`

**Interfaces:**
- Consumes: the current preview bootstrap and existing pane/selection actions.
- Produces no new production API. It removes one seed node and records the
  owning automated evidence for already-supported behavior.

- [ ] **Step 1: Add the failing preview contract**

```ts
it("does not seed instructional text as a bullet", async () => {
  const boot = await previewNotesApi.bootstrap();
  expect(boot.viewport?.nodes.map((node) => node.text)).not.toContain(
    "Press Enter to add another thought."
  );
});
```

Reset the preview module in the test setup so the assertion always observes a
fresh seed rather than mutations from an earlier test.

- [ ] **Step 2: Run the preview test and verify RED**

Run:

```powershell
npm run test --prefix apps/desktop -- src/previewApi.test.ts
```

Expected: FAIL because `preview-second` contains the instructional sentence.

- [ ] **Step 3: Remove only the instructional preview node**

Delete the `preview-second` object from `createInitialPreviewNodes`. Do not add
a textarea placeholder, CSS generated content, or replacement onboarding row.
Keep `Welcome to Yonalist` and `Start writing. Changes appear instantly.`
unchanged because this task removes only the user-identified sentence.

- [ ] **Step 4: Strengthen existing interaction tests only where evidence is missing**

Confirm the existing suites contain observable assertions for:

- split open/close/resize and pane-local focus;
- pointer and keyboard multi-selection;
- one `moveNodes` command for selected indent/outdent and reorder;
- destination-pane projection for cross-pane drag;
- one Undo/Redo history result per accepted structural gesture.

If the final Undo/Redo assertion is absent, add this real integration shape:

```ts
fireEvent.click(screen.getByRole("button", { name: "Indent" }));
await waitFor(() => expect(notesApi.execute).toHaveBeenCalledOnce());
fireEvent.keyDown(window, { key: "z", ctrlKey: true });
await waitFor(() => expect(notesApi.undo).toHaveBeenCalledOnce());
```

Do not duplicate behavior already asserted by an owning test.

- [ ] **Step 5: Run the focused parity tests and verify GREEN**

Run:

```powershell
npm run test --prefix apps/desktop -- src/previewApi.test.ts src/App.test.tsx src/splitPaneIntegration.test.tsx src/outlineClipboardIntegration.test.tsx src/navigationHistoryIntegration.test.tsx
```

Expected: PASS with no seeded instructional bullet and unchanged split,
selection, keyboard-repeat, drag, and history behavior.

- [ ] **Step 6: Update the parity evidence and commit**

Update only the relevant rows in `docs/v2/feature-parity-matrix.md` with the
new owning test files; do not mark image rows complete.

```powershell
git add apps/desktop/src/previewOutline.ts apps/desktop/src/previewApi.test.ts apps/desktop/src/App.test.tsx apps/desktop/src/outlineClipboardIntegration.test.tsx docs/v2/feature-parity-matrix.md
git commit -m "fix(v2): remove instructional bullet"
```

### Task 6: Verify fresh runtime and performance gates

**Files:**
- Modify: `docs/v2/performance.md`
- Modify: `docs/v2/verification.md`

**Interfaces:**
- Consumes the completed Tasks 1-5.
- Produces reproducible performance and runtime evidence for the next
  image-node design.

- [ ] **Step 1: Run the focused input and projection guards**

Run:

```powershell
npm run test --prefix apps/desktop -- src/storeSubscriptions.test.ts src/notesStore.test.ts src/App.test.tsx src/outlineClipboardIntegration.test.tsx
```

Expected: all focused tests pass, including the 800-node projection identity
case and the 200-event input guard.

- [ ] **Step 2: Build and start a fresh preview**

Build:

```powershell
npm run v2:build
```

Start a new process after stopping only the known previous v2 preview process:

```powershell
npm run dev --prefix apps/desktop -- --host 127.0.0.1 --port 1421 --strictPort
```

Reload `http://127.0.0.1:1421/` after the new process reports ready. The
fresh page must show no `Press Enter to add another thought.` bullet.

- [ ] **Step 3: Exercise the real browser path**

In the fresh preview:

1. create at least three adjacent bullets;
2. hold Enter and then Backspace over the created rows;
3. open the first bullet in the secondary split pane and resize the divider;
4. select two contiguous bullets with pointer and keyboard gestures;
5. press Tab, then Shift+Tab, and verify one ordered block moves;
6. move the selected block up and down;
7. drag the selected block into the other split pane;
8. Undo and Redo each accepted structure change; and
9. verify the browser console has no warning or error caused by the path.

Expected: focus ends on the logical destination row, no empty row appears below
the caret after repeated Enter, and each structural gesture reverses in one
Undo.

- [ ] **Step 4: Freeze the diff and run final gates once**

Run:

```powershell
npm run test:v2
npm run test:v2:bundle
npm run test:v2:performance
cargo fmt --all -- --check
cargo check --workspace --all-targets
git diff --check
```

Expected:

- all Rust workspace and frontend tests pass;
- lint, architecture, and generated-contract checks pass;
- editable JavaScript is at or below 300KB raw and 90KB gzip;
- SQLite performance fixtures remain within their recorded thresholds;
- Rust formatting/check succeeds even though Rust production code is
  unchanged; and
- the diff has no whitespace errors.

- [ ] **Step 5: Record exact fresh evidence**

Update `docs/v2/performance.md` with the current bundle bytes, 800-node
subscription result, fixed input-guard result, and SQLite measurements. Update
`docs/v2/verification.md` with current frontend/Rust test counts and the fresh
split/multi-selection browser path. Preserve the macOS and true editor-ready
cold-launch limitations until those machines and measurements exist.

- [ ] **Step 6: Commit verification evidence**

```powershell
git add docs/v2/performance.md docs/v2/verification.md
git commit -m "docs(v2): record performance foundation"
```

## Completion Checklist

- [ ] Draft-only title and note updates retain shell and outline projection
  identity.
- [ ] Only the edited node subscription is notified for a draft.
- [ ] Confirmed text/note receipts do not rebuild structural outline state.
- [ ] `notesStore.ts` and `App.test.tsx` finish below their advisory budgets.
- [ ] The instructional preview bullet is absent.
- [ ] Split and multi-selection operations pass automated and fresh browser
  verification.
- [ ] Initial bundle and input latency budgets pass.
- [ ] No image, schema, IPC, or Rust production change appears in the diff.
