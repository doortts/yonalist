# Notes Optimistic Enter Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make clean/dirty split and first-child Enter show and focus the new bullet within one frame in either split pane, while the existing serial structural queue persists the command and reports or recovers every save failure without losing in-app provisional text.

**Architecture:** Extend the existing keyboard-insertion preparation with a small pane-owned optimistic record. `NotesOutlinePane` overlays that record onto its already-derived visible rows, so Enter does not publish or reconcile a speculative shared workspace. The existing coordinator queue remains the only persistence queue and owns dependency order, authoritative adoption, failure rollback, unknown-outcome recovery, pending Undo, and graceful drain.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Tauri 2, existing Notes coordinator/history/draft engine, SQLite-backed `NotesStore`, and the existing split latency probe.

## Global Constraints

- Scope is only keyboard Enter for clean split, dirty split, and first-child insertion in primary and secondary panes.
- Reuse `PendingKeyboardInsertion`, the existing serial coordinator queue, structural history reservation, owner-pane routing, draft engine, authority recovery, error banner, clipboard helper, and latency probe.
- The owner pane alone shows provisional rows. Other panes keep their authoritative projection until normal settlement synchronization.
- A provisional row uses its reserved final node ID from first render through authoritative adoption. Success must not remount the editor or request focus a second time.
- Typing into a provisional row stays in memory until the node exists. It must never call the repository for a nonexistent node.
- Rapid Enter commands remain in existing queue order and record only a direct dependency on the prior provisional node.
- A definite failure restores the pre-command checkpoint, cancels its dependent queue suffix, preserves recoverable provisional text, and states both cause and rollback.
- An unknown outcome keeps the provisional presentation, blocks later structural writes through existing write authority, reloads authority, and never rolls back before proving non-commit.
- Failed or canceled structural commands never enter structural Undo history. A dirty draft already confirmed before the split remains confirmed.
- Graceful close and Notes Vault change wait for optimistic insertions. Unknown authority cancels the close/switch and leaves the recovery message visible.
- Forced renderer crash, process kill, power loss, and operating-system forced termination remain outside the durability guarantee; a durable outbox is not part of this change.
- Do not add a second queue, general external store, event log, persistent outbox, custom scheduler, native schema, IPC command, database migration, or optimistic behavior for non-Enter commands.
- The isolated desktop fixture remains 5,000 total text nodes with 50 visible rows. Each scenario uses 10 warm-ups and 50 measured physical interactions.
- Acceptance is `p95(keydown → provisional caret) <= 16 ms` in all six Enter scenarios. Persistence latency is recorded separately and is not folded into the UI threshold.
- Preserve the benchmark-only working-tree changes until desktop acceptance:
  - `src-tauri/src/notes/performance.rs`
  - `src/main.tsx`
  - `src-tauri/tauri.split-benchmark.conf.json`
- Stage named files only. Never stage those three benchmark artifacts with implementation commits.
- Work only in `/Users/doortts/Documents/yonalist/.worktrees/split-view-interaction-performance`.

---

## File Map

- Modify `src/features/notes/notesKeyboardInsertion.ts`: add the optimistic record, recovery payload, pane-local row projection, dependency traversal, and failure-message helpers beside the existing insertion registry.
- Modify `src/features/notes/notesKeyboardInsertion.test.ts`: test split/first-child projection, dependent ordering, authoritative de-duplication, and recovery text.
- Modify `src/features/notes/notesWorkspaceTypes.ts`: carry the pre-Enter checkpoint through preparation and expose pane-owned optimistic state/actions.
- Modify `src/features/notes/notesWorkspaceCoordinator.ts`: store optimistic records beside the existing insertion registry, emit snapshots synchronously, track queue state/dependencies, reconcile settlement, cancel a failed suffix, resolve unknown outcomes, implement pending Undo, and expose a drain.
- Modify `src/features/notes/notesWorkspaceCoordinator.test.ts`: prove lifecycle, queue order, rollback, recovery, history, Undo, close, and owner/session behavior.
- Modify `src/features/notes/notesWorkspaceRuntime.ts`: adopt optimistic events, route rollback/adoption navigation, feed confirmed provisional typing into the existing draft workflow, and gate ordinary Undo.
- Modify `src/features/notes/notesWorkspaceSettlementRuntime.ts`: route owner-pane navigation on optimistic adoption without requesting a second focus.
- Modify `src/features/notes/useNotesWorkspace.sharedSession.test.tsx`: prove shared-session visibility, provisional typing, and authoritative adoption.
- Modify `src/features/notes/notesWorkspaceContextSplit.test.tsx`: prove primary/secondary ownership and focus routing.
- Modify `src/features/notes/useNotesWorkspacePaneRegistry.ts`: expose only each pane's owned optimistic records and actions.
- Modify `src/features/notes/NotesOutlinePane.tsx`: splice optimistic rows into the already-derived body rows and reuse the persistent Notes error surface for retry/copy.
- Modify `src/features/notes/OutlineNodeRow.tsx`: prepare the checkpoint, render/edit provisional nodes through the same editor component, acknowledge provisional focus, and allow dependent Enter.
- Modify `src/features/notes/outlineKeyboard.ts`: let the existing Enter resolver accept one explicitly pane-local current node without adding it to shared workspace state.
- Modify `src/features/notes/outlineKeyboard.test.ts`: prove the override applies only to Enter and preserves modifier/composition/repeat guards.
- Modify `src/features/notes/outlineRowMemo.test.tsx`: prove only the source/new editors commit on provisional insertion and unchanged rows stay memoized.
- Modify `src/features/notes/NotesWorkspace.test.tsx`: test DOM timing, editor identity, focus count, rollback selection, retry/copy, IME/read-only guards, and accessibility.
- Modify `src/features/notes/notesSplitLatencyProbe.ts`: record provisional-caret and authoritative-settlement phases separately.
- Modify `src/features/notes/notesSplitLatencyProbe.test.ts`: test phase pairing and stale-sample cleanup.
- Modify `src/features/notes/useNotesHistoryController.ts`: flush post-commit provisional typing through the existing update path and ask the coordinator to consume pending Undo before replaying confirmed history.
- Modify `src/features/notes/useFlushDraftsOnWindowClose.ts`: drain optimistic insertions before destroying the Tauri window and leave it open when authority is unknown.
- Modify `src/features/notes/useFlushDraftsOnWindowClose.test.tsx`: test settled, failed, unknown, timeout, and re-entrant close branches.
- Modify `src/features/notes/NotesFeature.tsx`: pass the optimistic drain to close handling and hold the old Notes Vault root until the drain succeeds.
- Modify `src/features/notes/NotesFeature.test.tsx`: prove Vault switching waits and remains on the old Vault when authority is unknown.
- Create or update `docs/superpowers/reports/2026-07-24-notes-split-view-interaction-performance.md`: record deterministic and physical before/after evidence.
- Update `/Users/doortts/.codex/visualizations/2026/07/24/019f9296-5e76-74b0-a74e-c404baae8ed3/2026-07-24-yonalist-split-view-performance-design.html`: explain the implemented flow and benchmark result after acceptance.

---

### Task 1: Model the Pane-Local Optimistic Projection

**Files:**
- Modify: `src/features/notes/notesKeyboardInsertion.ts`
- Test: `src/features/notes/notesKeyboardInsertion.test.ts`

**Interfaces:**

```ts
export type OptimisticKeyboardInsertionStatus =
  | "prepared"
  | "queued"
  | "running"
  | "checking"
  | "settled";

export interface OptimisticKeyboardInsertionCheckpoint {
  readonly sourceNode: NoteNode;
  readonly sourceRow: FlattenedOutlineRow;
  readonly sourceSelection: NotesHistoryPrimarySelection;
}

export interface OptimisticKeyboardInsertion {
  readonly pending: PendingKeyboardInsertion;
  readonly historyContext: NotesHistoryContext;
  readonly dependencyId: NoteId | null;
  readonly checkpoint: OptimisticKeyboardInsertionCheckpoint;
  readonly sourceTitle: string;
  readonly insertedTitle: string;
  readonly status: OptimisticKeyboardInsertionStatus;
  readonly focusAcknowledged: boolean;
  readonly undoRequested: boolean;
}

export interface OptimisticInsertionFailure {
  readonly insertion: OptimisticKeyboardInsertion;
  readonly message: string;
  readonly recoveryText: string;
  readonly retryable: boolean;
}

export interface OptimisticInsertionSnapshot {
  readonly insertions: readonly OptimisticKeyboardInsertion[];
  readonly failure: OptimisticInsertionFailure | null;
}

export interface OptimisticOutlineProjection {
  readonly rows: readonly FlattenedOutlineRow[];
  readonly nodeOverrides: ReadonlyMap<NoteId, NoteNode>;
}

export function projectOptimisticKeyboardInsertions(
  rows: readonly FlattenedOutlineRow[],
  nodesById: Readonly<Record<NoteId, NoteNode>>,
  insertions: readonly OptimisticKeyboardInsertion[]
): OptimisticOutlineProjection;

export function dependentOptimisticInsertionIds(
  insertions: readonly OptimisticKeyboardInsertion[],
  failedNodeId: NoteId
): readonly NoteId[];
```

- [ ] **Step 1: Add failing pure projection tests**

Add tests for:

1. split replaces only the source title override and inserts the suffix directly after the source;
2. first-child inserts an empty child at depth `source.depth + 1` and presents
   a collapsed source as expanded;
3. both operations preserve existing row IDs and recompute guide metadata with `deriveOutlineGuideMetadata`;
4. two dependent splits apply in insertion order;
5. an expected node already present in `nodesById` is not duplicated or overridden;
6. rows whose placement and guide metadata did not change retain object identity;
7. dependency traversal returns only the failed node and its transitive suffix;
8. recovery text contains the latest provisional source/inserted text.

The core assertion shape is:

```ts
const projection = projectOptimisticKeyboardInsertions(
  rows,
  nodesById,
  [optimisticSplit]
);

expect(projection.rows.map((row) => row.id)).toEqual([
  "source",
  "expected",
  "sibling"
]);
expect(projection.nodeOverrides.get("source")?.title).toBe("pre");
expect(projection.nodeOverrides.get("expected")?.title).toBe("fix");
expect(nodesById.expected).toBeUndefined();
```

- [ ] **Step 2: Run the tests and confirm the red state**

```bash
npm test -- src/features/notes/notesKeyboardInsertion.test.ts
```

Expected: failure because the optimistic types and projection functions do not exist.

- [ ] **Step 3: Implement the minimum pure model in the existing module**

Import `NoteNode`, `NotesHistoryContext`, and `NotesHistoryPrimarySelection`.
Apply each descriptor to a shallow copy of the 50 visible rows and a small
`Map` containing only source/new node overrides. For first-child, set the
source row/node `isCollapsed` override to `false`. Reuse
`deriveOutlineGuideMetadata`; reuse the original row object whenever its
placement and two guide fields are equal. Do not normalize or clone the full
workspace.

For a provisional text node, derive display-safe fields from the source node
and replace only identity, parent, title, note, image offset, collapse,
completion, archive, and deletion fields needed for a new text bullet:

```ts
const insertedNode: NoteNode = {
  ...sourceNode,
  id: insertion.pending.intent.expectedNodeId,
  nodeKind: "text",
  markerKind: "bullet",
  parentId,
  title: insertion.insertedTitle,
  note: "",
  imageOffsetUtf16: 0,
  markdownImageWidth: null,
  isCollapsed: false,
  isStarred: false,
  completedAt: null,
  deletedAt: null,
  archivedAt: null,
  archiveRootId: null
};
```

If the source row or relationship cannot be found, skip that descriptor so
the caller falls back to the current authoritative presentation.

- [ ] **Step 4: Run the focused test and type check**

```bash
npm test -- src/features/notes/notesKeyboardInsertion.test.ts
npx tsc --noEmit
```

Expected: the focused file passes and TypeScript reports no errors.

- [ ] **Step 5: Commit the model**

```bash
git add src/features/notes/notesKeyboardInsertion.ts src/features/notes/notesKeyboardInsertion.test.ts
git commit -m "feat(notes): model optimistic enter presentation"
```

---

### Task 2: Publish Prepared and Queued State from the Existing Coordinator

**Files:**
- Modify: `src/features/notes/notesWorkspaceTypes.ts`
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts`
- Test: `src/features/notes/notesWorkspaceCoordinator.test.ts`

**Interfaces:**

Extend the request rather than adding another preparation API:

```ts
export interface NotesKeyboardInsertionRequest {
  readonly ownerPaneId: string;
  readonly interactionEpochAtDispatch: number;
  readonly intent: Omit<KeyboardInsertionIntent, "ownerSessionGeneration">;
  readonly optimistic?: {
    readonly checkpoint: OptimisticKeyboardInsertionCheckpoint;
    readonly sourceTitle: string;
    readonly insertedTitle: string;
    readonly dependencyId?: NoteId;
  };
}

export interface NotesOptimisticInsertionEvent {
  readonly type: "optimisticInsertion";
  readonly snapshot: OptimisticInsertionSnapshot;
  readonly rollback?: {
    readonly ownerPaneId: string;
    readonly sourceId: NoteId;
    readonly selection: NotesHistoryPrimarySelection;
  };
}
```

Add `NotesOptimisticInsertionEvent` as one member of
`NotesWorkspaceCoordinatorEvent`.

Add only one map to `CoordinatorEntry`:

```ts
optimisticKeyboardInsertions: Map<NoteId, OptimisticKeyboardInsertion>;
optimisticInsertionFailure: OptimisticInsertionFailure | null;
```

Do not add a new queue or a second registry.

- [ ] **Step 1: Add failing coordinator preparation tests**

Prove:

- `prepareKeyboardInsertion` synchronously emits one owner snapshot with status
  `prepared`;
- the optimistic record contains the same pending/history objects returned to
  the caller;
- enqueueing that preparation changes the status to `queued`;
- canceling before enqueue removes it and discards the reserved history entry;
- a different session and the non-owner pane receive no owner-local record;
- a stale interaction epoch returns `null` and emits nothing.

Use the current deferred repository helper so no IPC promise resolves during
the first two assertions.

- [ ] **Step 2: Run the coordinator test and confirm failure**

```bash
npm test -- src/features/notes/notesWorkspaceCoordinator.test.ts
```

Expected: new snapshot assertions fail because preparation currently registers
only `PendingKeyboardInsertion`.

- [ ] **Step 3: Add optimistic state beside the current registry**

When `input.optimistic` is present, create the optimistic record only after
history reservation and `keyboardInsertions.register` succeed. Emit a frozen
array snapshot synchronously before returning the preparation. An omitted
payload preserves the current authoritative-only preparation path.

When `enqueueStructural` accepts the same preparation, replace only that map
entry's status:

```ts
setOptimisticInsertionStatus(entry, expectedNodeId, "queued");
```

When queue execution selects the item, change it to `running` immediately
before `executeItem(item)`.

Keep `preparedKeyboardInsertions` and `keyboardInsertions` as the identity and
history authorities. The optimistic map is presentation data only.

- [ ] **Step 4: Run coordinator and existing preparation callers**

```bash
npm test -- \
  src/features/notes/notesWorkspaceCoordinator.test.ts \
  src/features/notes/useNotesWorkspace.operations.test.tsx \
  src/features/notes/useNotesWorkspace.sharedSession.test.tsx
```

Expected: all selected files pass.

- [ ] **Step 5: Commit coordinator publication**

```bash
git add src/features/notes/notesWorkspaceTypes.ts src/features/notes/notesWorkspaceCoordinator.ts src/features/notes/notesWorkspaceCoordinator.test.ts
git commit -m "feat(notes): queue optimistic enter state"
```

---

### Task 3: Expose Only the Owner Pane's Optimistic Records

**Files:**
- Modify: `src/features/notes/notesWorkspaceTypes.ts`
- Modify: `src/features/notes/notesWorkspaceRuntime.ts`
- Modify: `src/features/notes/useNotesWorkspacePaneRegistry.ts`
- Test: `src/features/notes/useNotesWorkspace.sharedSession.test.tsx`
- Test: `src/features/notes/notesWorkspaceContextSplit.test.tsx`

**Interfaces:**

Add these members to `NotesDraftsSlice` and `NotesWorkspaceActions`:

```ts
optimisticKeyboardInsertions?: readonly OptimisticKeyboardInsertion[];
optimisticInsertionFailure?: OptimisticInsertionFailure | null;

updateOptimisticKeyboardInsertion?(
  nodeId: NoteId,
  title: string
): void;
acknowledgeOptimisticKeyboardInsertionFocus?(
  nodeId: NoteId,
  intentToken: number
): void;
retryOptimisticKeyboardInsertion?(): Promise<boolean>;
dismissOptimisticInsertionFailure?(): void;
drainOptimisticKeyboardInsertions?(): Promise<boolean>;
```

The base runtime stores the latest `OptimisticInsertionSnapshot`. The pane
registry derives:

```ts
optimisticKeyboardInsertions: base.insertions.filter(
  (item) => item.pending.ownerPaneId === paneId
);
```

Filter the failure by `failure.insertion.pending.ownerPaneId` as well. Do not
expose a primary-owned descriptor to secondary or vice versa.

- [ ] **Step 1: Add failing primary/secondary ownership tests**

In the shared-session test, prepare a primary insertion and assert that the
base owner sees it while a sibling session does not receive a speculative
workspace.

In the split context test, prepare a secondary insertion and assert:

```ts
expect(panes().primary.draftsSlice.optimisticKeyboardInsertions).toEqual([]);
expect(
  panes().secondary.draftsSlice.optimisticKeyboardInsertions[0]
    .pending.intent.expectedNodeId
).toBe("secondary-new");
expect(panes().primary.stateSlice.state.nodesById["secondary-new"]).toBeUndefined();
expect(panes().secondary.stateSlice.state.nodesById["secondary-new"]).toBeUndefined();
```

The last two checks enforce pane-local overlay rather than speculative shared
workspace mutation.

- [ ] **Step 2: Run both tests and confirm failure**

```bash
npm test -- \
  src/features/notes/useNotesWorkspace.sharedSession.test.tsx \
  src/features/notes/notesWorkspaceContextSplit.test.tsx
```

Expected: the new drafts-slice fields are absent.

- [ ] **Step 3: Handle the coordinator event in the runtime**

Add one `useState<OptimisticInsertionSnapshot>` initialized to:

```ts
{ insertions: [], failure: null }
```

In `onEvent`, handle `optimisticInsertion` before reading `event.result`. If a
rollback is present, dispatch its selection/focus checkpoint to the named pane
through the existing pane session controller.

Reset the snapshot when a different Vault session activates. Do not clear an
old session's coordinator-owned recovery payload during ordinary pane
unmount.

- [ ] **Step 4: Filter state/actions in the pane registry**

Create memoized `primaryDraftsSlice` and `secondaryDraftsSlice`; do not pass
the unfiltered base drafts slice directly to primary. Each slice includes only
records/failure owned by its pane, and uses one shared empty-array constant
when none are owned so the inactive pane retains reference identity. Preserve
the existing action proxy rules. Do not create a context or subscription per
row.

- [ ] **Step 5: Run the focused tests and memo regression**

```bash
npm test -- \
  src/features/notes/useNotesWorkspace.sharedSession.test.tsx \
  src/features/notes/notesWorkspaceContextSplit.test.tsx \
  src/features/notes/outlineRowMemo.test.tsx
```

Expected: all selected files pass and the existing row memo tests remain
unchanged.

- [ ] **Step 6: Commit pane ownership**

```bash
git add src/features/notes/notesWorkspaceTypes.ts src/features/notes/notesWorkspaceRuntime.ts src/features/notes/useNotesWorkspacePaneRegistry.ts src/features/notes/useNotesWorkspace.sharedSession.test.tsx src/features/notes/notesWorkspaceContextSplit.test.tsx
git commit -m "feat(notes): expose pane-owned optimistic inserts"
```

---

### Task 4: Render and Focus the Provisional Row Before Persistence

**Files:**
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/notesSplitLatencyProbe.ts`
- Test: `src/features/notes/NotesWorkspace.test.tsx`
- Test: `src/features/notes/outlineRowMemo.test.tsx`
- Test: `src/features/notes/notesSplitLatencyProbe.test.ts`

**Interfaces:**

Add a stable row accessor and the optional optimistic descriptor to the
existing editor props:

Add these members to `OutlineNodeEditorProps`:

```ts
getOutlineRow(nodeId: NoteId): FlattenedOutlineRow | undefined;
optimisticInsertion?: OptimisticKeyboardInsertion;
```

Extend the existing phase type without removing `barrier`:

```ts
export type SplitLatencyPhase =
  | "keydown"
  | "barrier"
  | "provisional-caret"
  | "ipc-done"
  | "settled"
  | "rollback"
  | "recovered"
  | "caret";
```

`provisional-caret` logs the UI latency but keeps the record. `settled` is
terminal only when that provisional mark exists; `rollback` and `recovered`
are always terminal. `caret` remains the terminal phase for authoritative
fallback paths.

- [ ] **Step 1: Add failing unresolved-repository DOM tests**

For primary and secondary, cover split and first-child with a deferred
repository promise:

```tsx
fireEvent.keyDown(editor, { key: "Enter" });

expect(repository.splitNode).toHaveBeenCalledTimes(1);
expect(deferred.settled).toBe(false);
expect(screen.getByDisplayValue("suffix")).toHaveFocus();
```

For dirty split, assert the source displays the prefix and the provisional row
displays the suffix before either repository promise resolves. Resolve the
draft step and assert repository order remains `updateNode` then `splitNode`.

Also assert:

- read-only archive/trash mode does not prepare an optimistic record;
- composing Enter does not prepare one;
- a preparation rejected by current epoch produces no provisional row;
- a missing source row runs the existing authoritative insertion path.

- [ ] **Step 2: Add failing render-isolation and probe tests**

Render 50 rows, press Enter in the active row, and assert:

- the source editor commits once;
- the provisional editor mounts once;
- all 49 unaffected editors commit zero times;
- the inactive pane's editor set commits zero times;
- `keydown → provisional-caret` is recorded independently from
  `keydown → settled`.

- [ ] **Step 3: Run the three files and confirm failure**

```bash
npm test -- \
  src/features/notes/NotesWorkspace.test.tsx \
  src/features/notes/outlineRowMemo.test.tsx \
  src/features/notes/notesSplitLatencyProbe.test.ts
```

Expected: the deferred-repository focus and new probe assertions fail.

- [ ] **Step 4: Prepare complete checkpoints in `OutlineNodeRow`**

For split:

```ts
const sourceDraft = draftToSave();
const optimistic = {
  checkpoint: {
    sourceNode: { ...node, ...sourceDraft },
    sourceRow,
    sourceSelection: {
      anchorUtf16: event.currentTarget.selectionStart,
      focusUtf16: event.currentTarget.selectionEnd
    }
  },
  sourceTitle: resolution.prefix,
  insertedTitle: resolution.suffix,
  dependencyId: optimisticInsertion?.pending.intent.expectedNodeId
} satisfies NonNullable<NotesKeyboardInsertionRequest["optimistic"]>;
```

For first-child, use the same checkpoint, the unchanged source title, and an
empty inserted title. Resolve `sourceRow` before preparation. If it is absent,
call the current `splitNode`/`createChild` authoritative path without a
keyboard-insertion preparation. Pass the same `sourceDraft` object to dirty
split persistence so presentation and the first compound queue step share one
pre-Enter value.

Keep `event.preventDefault()` and all existing Enter eligibility rules
unchanged.

- [ ] **Step 5: Overlay only the already-derived body rows**

In `NotesOutlinePane`, call `projectOptimisticKeyboardInsertions` after
`deriveOutlineBodyRows` and before the current row render loop. Resolve each
node as:

```ts
const node =
  optimisticProjection.nodeOverrides.get(row.id) ??
  state.nodesById[row.id];
```

Render through the existing `OutlineEditorExportBridge` with `key={row.id}`.
Do not introduce a different provisional component type.

Keep `getOutlineRow` stable through a ref, matching the existing
`getVisibleNodeIds` pattern. Do not pass each `FlattenedOutlineRow` object as a
row prop, because recomputed guide metadata would defeat editor memoization.

For the provisional node, pass its matching descriptor. Its `onChange` calls
`updateOptimisticKeyboardInsertion`; it does not call `updateNodeDraft`.

- [ ] **Step 6: Focus in the first owner-pane commit**

The existing title focus effect handles the provisional row. After the DOM
selection is applied:

```ts
actions.acknowledgeOptimisticKeyboardInsertionFocus?.(
  nodeId,
  optimisticInsertion.pending.intent.token
);
markSplitPhase(nodeId, "provisional-caret");
```

Do not call ordinary authoritative `acknowledgeFocus` for this branch.

- [ ] **Step 7: Run focused tests**

```bash
npm test -- \
  src/features/notes/NotesWorkspace.test.tsx \
  src/features/notes/outlineRowMemo.test.tsx \
  src/features/notes/notesSplitLatencyProbe.test.ts
npx tsc --noEmit
```

Expected: all selected tests and the type check pass.

- [ ] **Step 8: Commit the fast path**

```bash
git add src/features/notes/NotesOutlinePane.tsx src/features/notes/OutlineNodeRow.tsx src/features/notes/notesSplitLatencyProbe.ts src/features/notes/NotesWorkspace.test.tsx src/features/notes/outlineRowMemo.test.tsx src/features/notes/notesSplitLatencyProbe.test.ts
git commit -m "feat(notes): render enter rows before persistence"
```

---

### Task 5: Preserve Queue Order for Typing and Rapid Dependent Enter

**Files:**
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts`
- Modify: `src/features/notes/notesWorkspaceRuntime.ts`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/outlineKeyboard.ts`
- Test: `src/features/notes/notesWorkspaceCoordinator.test.ts`
- Test: `src/features/notes/useNotesWorkspace.sharedSession.test.tsx`
- Test: `src/features/notes/NotesWorkspace.test.tsx`
- Test: `src/features/notes/outlineKeyboard.test.ts`

**Interfaces:**

Add coordinator session methods that mutate only the matching presentation
record:

```ts
updateOptimisticKeyboardInsertion(
  expectedNodeId: NoteId,
  title: string
): void;

acknowledgeOptimisticKeyboardInsertionFocus(
  expectedNodeId: NoteId,
  intentToken: number
): void;
```

At queue turn, a dependent command validates that its `dependencyId` exists in
the latest confirmed workspace. A missing dependency after its predecessor
failed is a definite cancellation, not a repository call.

The existing key resolver gets one narrow optional input:

Add this member to `ResolveOutlineKeyInput`:

```ts
readonly optimisticEnter?: {
  readonly hasChildren: boolean;
};
```

It treats the current node as present only for an eligible Enter. Every other
key still requires the node in the authoritative workspace.

- [ ] **Step 1: Add failing provisional typing tests**

With the create/split repository promise unresolved:

- type into the provisional editor;
- assert `repository.updateNode` has not been called;
- assert the owner pane immediately displays the new text;
- resolve insertion;
- assert the next ordinary update carries the final provisional text.

If the final text equals the insertion command's initial inserted title,
assert no follow-up update is queued.

- [ ] **Step 2: Add failing rapid Enter dependency tests**

Create a provisional row, change its text, and press Enter again before the
first repository call resolves. Assert:

- both provisional rows remain visible;
- only the first structural call has started;
- resolving the first starts the second;
- the second command sees the first node in the confirmed workspace;
- repository call order matches optimistic record order;
- history order is first insertion, second insertion, then any remaining text
  update.

Add resolver tests proving a provisional current node can split on Enter while
IME composition, key repeat, modifiers, Tab, Backspace, and movement retain
their current behavior.

- [ ] **Step 3: Run focused tests and confirm failure**

```bash
npm test -- \
  src/features/notes/notesWorkspaceCoordinator.test.ts \
  src/features/notes/useNotesWorkspace.sharedSession.test.tsx \
  src/features/notes/NotesWorkspace.test.tsx \
  src/features/notes/outlineKeyboard.test.ts
```

Expected: typing and dependent Enter assertions fail.

- [ ] **Step 4: Wire text updates to the coordinator record**

Validate owner session, expected node ID, and non-settled status before
updating. Emit the owner snapshot synchronously. Keep the current map insertion
order so dependency traversal and visual order agree.

- [ ] **Step 5: Reuse the existing Enter resolver for provisional rows**

Pass `optimisticEnter: { hasChildren: false }` only when the current editor is
the provisional text node and the key is Enter. In `resolveOutlineKey`, accept
that narrow current-node presence after the existing modifier, IME, repeat,
selection, and offset validation. Keep all non-Enter branches authoritative.

- [ ] **Step 6: Revalidate dependencies at queue turn**

Immediately before running a keyboard insertion:

```ts
if (
  optimistic.dependencyId !== null &&
  !normalizeWorkspace(entry.confirmedWorkspace)
    .nodesById[optimistic.dependencyId]
) {
  return definiteOptimisticFailure(
    entry,
    item,
    "The preceding bullet was not saved."
  );
}
```

Use the existing queue's serial execution; do not add promises or a scheduler
outside it.

- [ ] **Step 7: Flush newer provisional text only after authority exists**

When the insertion settles authoritatively, compare the record's current
inserted title with the command postcondition title. Pass only a changed title
to the existing draft/update workflow. If a dependent insertion already
consumes that title, do not enqueue a redundant update before it.

- [ ] **Step 8: Run focused tests**

```bash
npm test -- \
  src/features/notes/notesWorkspaceCoordinator.test.ts \
  src/features/notes/useNotesWorkspace.sharedSession.test.tsx \
  src/features/notes/NotesWorkspace.test.tsx \
  src/features/notes/outlineKeyboard.test.ts
```

Expected: all selected files pass.

- [ ] **Step 9: Commit queue ordering**

```bash
git add src/features/notes/notesWorkspaceCoordinator.ts src/features/notes/notesWorkspaceRuntime.ts src/features/notes/OutlineNodeRow.tsx src/features/notes/outlineKeyboard.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/useNotesWorkspace.sharedSession.test.tsx src/features/notes/NotesWorkspace.test.tsx src/features/notes/outlineKeyboard.test.ts
git commit -m "feat(notes): preserve optimistic enter order"
```

---

### Task 6: Adopt Authoritative Rows Without Remount or Refocus

**Files:**
- Modify: `src/features/notes/notesKeyboardInsertion.ts`
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts`
- Modify: `src/features/notes/notesWorkspaceSettlementRuntime.ts`
- Modify: `src/features/notes/notesWorkspaceRuntime.ts`
- Test: `src/features/notes/notesWorkspaceCoordinator.test.ts`
- Test: `src/features/notes/notesWorkspaceContextSplit.test.tsx`
- Test: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**

Extend the existing settlement identity:

Add this member to `KeyboardInsertionSettlement`:

```ts
readonly provisionalFocusAcknowledged?: boolean;
```

`settleItem` removes the optimistic record only after it has accepted the
authoritative workspace. Before notifying the owner, strip
`pendingFocusId/pendingFocusField` when provisional focus was acknowledged,
while retaining `selectedId` and `editingNoteId`.

- [ ] **Step 1: Add failing adoption tests**

Use a mount counter in the real editor path:

1. press Enter and focus the provisional node;
2. resolve the repository with the same expected node ID;
3. assert the editor mount count remains one;
4. assert focus/selection application count remains one;
5. assert the node now comes from authoritative state;
6. assert selection/editing stays on the new node.

Run the same ownership assertion for secondary: primary navigation remains
unchanged, secondary keeps selected/editing, and no secondary pending-focus
request is delivered after provisional acknowledgment.

- [ ] **Step 2: Run the tests and confirm failure**

```bash
npm test -- \
  src/features/notes/notesWorkspaceCoordinator.test.ts \
  src/features/notes/notesWorkspaceContextSplit.test.tsx \
  src/features/notes/NotesWorkspace.test.tsx
```

Expected: the current authoritative settlement asks for focus again or removes
the optimistic record without proving identity preservation.

- [ ] **Step 3: Reconcile at `settleItem`**

Read `focusAcknowledged` from the record before removal. Add it to the accepted
keyboard insertion settlement, mark the internal transition `settled`, remove
the record, and notify the owner with the authoritative result and new
optimistic snapshot in the same settlement turn.

`projectOptimisticKeyboardInsertions` already ignores a node present in
authoritative `nodesById`, so notification ordering cannot duplicate the row.

- [ ] **Step 4: Route secondary navigation without secondary refocus**

Update `routeKeyboardInsertionNavigation` so exact/mixed secondary adoption is
routed when either:

```ts
disposition.settlement.focusEligible ||
disposition.settlement.provisionalFocusAcknowledged
```

When provisional focus was acknowledged, omit pending-focus fields from the
secondary patch. Preserve the existing interaction-epoch behavior for every
non-optimistic settlement.

- [ ] **Step 5: Run the focused tests**

```bash
npm test -- \
  src/features/notes/notesWorkspaceCoordinator.test.ts \
  src/features/notes/notesWorkspaceContextSplit.test.tsx \
  src/features/notes/NotesWorkspace.test.tsx
```

Expected: all selected files pass with one mount and one focus.

- [ ] **Step 6: Commit reconciliation**

```bash
git add src/features/notes/notesKeyboardInsertion.ts src/features/notes/notesWorkspaceCoordinator.ts src/features/notes/notesWorkspaceSettlementRuntime.ts src/features/notes/notesWorkspaceRuntime.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/notesWorkspaceContextSplit.test.tsx src/features/notes/NotesWorkspace.test.tsx
git commit -m "feat(notes): adopt optimistic enter saves"
```

---

### Task 7: Roll Back Definite Failures and Offer Safe Retry or Copy

**Files:**
- Modify: `src/features/notes/notesKeyboardInsertion.ts`
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts`
- Modify: `src/features/notes/notesWorkspaceRuntime.ts`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Test: `src/features/notes/notesWorkspaceCoordinator.test.ts`
- Test: `src/features/notes/useNotesWorkspace.sharedSession.test.tsx`
- Test: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**

Use the existing persistent `notes-inline-error` surface. The optimistic
failure record supplies:

- parsed cause;
- statement that the action was reverted;
- latest provisional text;
- whether current authority permits Retry.

Retry creates a fresh node ID and a fresh preparation after validating the
current source/pane/history epoch. It never invokes a stored closure.

- [ ] **Step 1: Add failing definite-failure coordinator tests**

Cover source removed, expected ID collision, unsupported source, stale session
or pane epoch, and repository rejection. For each, assert:

- failed record and every transitive dependent record disappear;
- their queued repository calls do not run;
- their reserved structural history entries are discarded;
- an unrelated confirmed command remains;
- the owner's rollback event carries source ID and exact selection;
- recovery text contains the last provisional typing.

For dirty split, return a failure workspace containing the already-confirmed
draft and assert that title remains authoritative.

In the DOM test, assert rollback restores the exact source text, row order,
source focus, and `anchorUtf16`/`focusUtf16` selection from the checkpoint.

- [ ] **Step 2: Add failing UI error/retry/copy tests**

Assert the persistent `role="alert"`:

- contains the backend cause;
- says the last bullet action was reverted;
- remains after timers advance;
- exposes `Retry` only while revalidation succeeds;
- exposes `Copy text` when retry is no longer valid;
- copies recovery text through `writeNotesClipboardText`;
- dismisses only on explicit dismiss or successful retry.

- [ ] **Step 3: Run focused tests and confirm failure**

```bash
npm test -- \
  src/features/notes/notesWorkspaceCoordinator.test.ts \
  src/features/notes/useNotesWorkspace.sharedSession.test.tsx \
  src/features/notes/NotesWorkspace.test.tsx
```

Expected: rollback/recovery assertions fail.

- [ ] **Step 4: Centralize definite failure in the coordinator**

Add one internal helper called by queue-time validation, returned repository
failure, queued dependency cancellation, and explicit cancel:

```ts
definiteOptimisticFailure(
  entry: CoordinatorEntry,
  item: CommandItem,
  error: string
): OptimisticInsertionFailure;
```

It scans the small existing queue for the failed expected ID and transitive
`dependencyId` matches, calls the existing item cancellation/history discard
paths, removes their optimistic records, and emits one rollback snapshot.
The runtime marks the failed expected node's probe phase `rollback`.

Do not call repository Undo: a failed structural entry was never accepted.

- [ ] **Step 5: Implement revalidated Retry**

The runtime reads the current authoritative source and current pane snapshot,
then rebuilds split/first-child input from the failure record with a newly
generated node ID. Reuse `prepareKeyboardInsertion`, `splitNode`, and
`createChild`. Clear the failure only after the new preparation succeeds.

If source kind, placement, ownership, or authority no longer validates, set
`retryable: false` and retain recovery text.

- [ ] **Step 6: Render the persistent recovery actions**

Place optimistic failure before the generic draft `writeError` banner so the
specific cause is not hidden. Reuse `notes-write-error-retry`,
`writeNotesClipboardText`, and the existing live alert styling.

- [ ] **Step 7: Run focused tests**

```bash
npm test -- \
  src/features/notes/notesWorkspaceCoordinator.test.ts \
  src/features/notes/useNotesWorkspace.sharedSession.test.tsx \
  src/features/notes/NotesWorkspace.test.tsx
```

Expected: all selected files pass.

- [ ] **Step 8: Commit definite failure recovery**

```bash
git add src/features/notes/notesKeyboardInsertion.ts src/features/notes/notesWorkspaceCoordinator.ts src/features/notes/notesWorkspaceRuntime.ts src/features/notes/NotesOutlinePane.tsx src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/useNotesWorkspace.sharedSession.test.tsx src/features/notes/NotesWorkspace.test.tsx
git commit -m "fix(notes): recover failed optimistic inserts"
```

---

### Task 8: Keep Unknown Outcomes Visible Until Authority Recovery

**Files:**
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts`
- Modify: `src/features/notes/notesWorkspaceRuntime.ts`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Test: `src/features/notes/notesWorkspaceCoordinator.test.ts`
- Test: `src/features/notes/useNotesWorkspace.sharedSession.test.tsx`
- Test: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**

Reuse `recoverUnknownOutcomeForEntry`,
`NotesUnknownOutcomeExpectation`, and `NotesWriteAuthority`. The optimistic
record's status becomes `checking` before reload begins.

- [ ] **Step 1: Add failing unknown-outcome tests**

Cover all three authority decisions:

- committed and history-current: keep provisional row during reload, then
  adopt authority without refocus;
- not proven committed: keep provisional row during reload, then use the
  definite-failure rollback;
- authority still unknown: keep provisional row and recovery text, retain
  structural write block, and expose `Retry recovery`.

During each unresolved reload, assert that a later structural command returns
`skipped` and no rollback event is emitted. Type in the provisional editor
during `checking` and assert the retained recovery payload receives that text
without a repository update.

- [ ] **Step 2: Run focused tests and confirm failure**

```bash
npm test -- \
  src/features/notes/notesWorkspaceCoordinator.test.ts \
  src/features/notes/useNotesWorkspace.sharedSession.test.tsx \
  src/features/notes/NotesWorkspace.test.tsx
```

Expected: the current queue converts unknown recovery to a generic failure
without retaining the optimistic presentation state.

- [ ] **Step 3: Mark `checking` at the existing catch boundary**

Before awaiting `recoveredQueueResult(item)`, update the matching record to
`checking` and emit the snapshot. The existing `setWriteAuthority` call
continues to block structural writes.

Classify recovery with an exhaustive `switch`: committed decisions adopt the
reloaded workspace, `notProvenCommitted` calls the Task 7 rollback helper, and
`authorityUnknown` retains the record and recovery payload.

If history proof is unavailable after a committed workspace reload, preserve
the current history-recovery safety rule; do not manufacture an Undo entry.
When recovery reaches a terminal decision, mark the probe phase `recovered`.

- [ ] **Step 4: Reuse the authority banner**

While checking, display `Saving status is being checked.` When still unknown,
display the existing manual recovery guidance plus the insertion recovery
text. Do not use `NotesFeedbackContext`, because it auto-clears.

- [ ] **Step 5: Run focused tests**

```bash
npm test -- \
  src/features/notes/notesWorkspaceCoordinator.test.ts \
  src/features/notes/useNotesWorkspace.sharedSession.test.tsx \
  src/features/notes/NotesWorkspace.test.tsx
```

Expected: all selected files pass.

- [ ] **Step 6: Commit unknown-outcome handling**

```bash
git add src/features/notes/notesWorkspaceCoordinator.ts src/features/notes/notesWorkspaceRuntime.ts src/features/notes/NotesOutlinePane.tsx src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/useNotesWorkspace.sharedSession.test.tsx src/features/notes/NotesWorkspace.test.tsx
git commit -m "fix(notes): reconcile unknown optimistic saves"
```

---

### Task 9: Resolve Undo Against Pending Optimistic Work First

**Files:**
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts`
- Modify: `src/features/notes/useNotesHistoryController.ts`
- Test: `src/features/notes/notesWorkspaceCoordinator.test.ts`
- Test: `src/features/notes/useNotesWorkspace.sharedSession.test.tsx`

**Interfaces:**

```ts
export type OptimisticUndoResolution =
  | "notHandled"
  | "handledWithoutHistory"
  | "replayConfirmedHistory";

requestOptimisticUndo(): Promise<OptimisticUndoResolution>;
```

`requestOptimisticUndo` targets the most recently prepared pending insertion
owned by the writable session.

- [ ] **Step 1: Add failing queued and running Undo tests**

Queued branch:

- remove the queue item;
- restore presentation immediately;
- discard its history reservation;
- cancel its dependent suffix;
- resolve `handledWithoutHistory`;
- never call repository Undo.

Running branch:

- restore presentation immediately and mark `undoRequested`;
- if the mutation fails/not committed, resolve `handledWithoutHistory`;
- if the mutation commits, resolve `replayConfirmedHistory`;
- if outcome is unknown, do not decide until authority recovery completes.

- [ ] **Step 2: Add failing history integration tests**

Press Undo while the insertion promise is unresolved. Assert immediate DOM
rollback. Then:

- resolve a committed insertion and assert exactly one existing backend Undo
  runs after the insertion;
- reject without commit and assert backend Undo never runs;
- leave authority unknown and assert no unrelated prior history entry is
  undone.

- [ ] **Step 3: Run focused tests and confirm failure**

```bash
npm test -- \
  src/features/notes/notesWorkspaceCoordinator.test.ts \
  src/features/notes/useNotesWorkspace.sharedSession.test.tsx
```

Expected: ordinary history replay currently runs without consuming optimistic
work.

- [ ] **Step 4: Implement coordinator resolution by scanning the existing queue**

Do not add an item index. The queue is short and the coordinator already owns
all items. For a queued item, call `removeQueuedItem`. For `entry.running`,
set `undoRequested` on the record and keep a resolver completed from
`settleItem` or unknown recovery.

Cancel dependent suffixes through the Task 7 helper.

- [ ] **Step 5: Gate existing `replayHistory("undo")`**

At the start of Undo:

```ts
const optimistic = await session.requestOptimisticUndo();
if (optimistic === "handledWithoutHistory") return;
if (optimistic === "replayConfirmedHistory") {
  // Continue through the existing replay path.
}
```

Redo remains unchanged because unconfirmed optimistic work never enters
history.

- [ ] **Step 6: Run focused tests**

```bash
npm test -- \
  src/features/notes/notesWorkspaceCoordinator.test.ts \
  src/features/notes/useNotesWorkspace.sharedSession.test.tsx
```

Expected: all selected files pass.

- [ ] **Step 7: Commit pending Undo**

```bash
git add src/features/notes/notesWorkspaceCoordinator.ts src/features/notes/useNotesHistoryController.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/useNotesWorkspace.sharedSession.test.tsx
git commit -m "feat(notes): undo pending optimistic inserts"
```

---

### Task 10: Drain Optimistic Inserts on Close, Vault Change, and Unmount

**Files:**
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts`
- Modify: `src/features/notes/notesWorkspaceRuntime.ts`
- Modify: `src/features/notes/useFlushDraftsOnWindowClose.ts`
- Modify: `src/features/notes/NotesFeature.tsx`
- Test: `src/features/notes/notesWorkspaceCoordinator.test.ts`
- Test: `src/features/notes/useFlushDraftsOnWindowClose.test.tsx`
- Test: `src/features/notes/NotesFeature.test.tsx`

**Interfaces:**

```ts
drainOptimisticKeyboardInsertions(): Promise<boolean>;
```

Return `true` only when every optimistic insertion is authoritatively settled
or definitely rolled back. Return `false` while authority remains unknown.

- [ ] **Step 1: Add failing coordinator lifecycle tests**

Prove:

- drain waits for queued/running insertion settlement;
- definite failure completes the drain with `true`;
- unknown authority completes with `false`;
- unregistering the owner pane invalidates future focus but does not cancel an
  already queued/running insertion or erase its recovery text;
- closing one pane does not orphan a queue item while another writable session
  for the Vault remains;
- final session close retains the command until settlement and then releases
  the coordinator entry;
- provisional text remains in the recovery payload throughout.

- [ ] **Step 2: Add failing window-close tests**

Extend the hook harness with an optimistic drain. Assert:

- drain runs before draft and sync flush;
- known settlement eventually calls `appWindow.destroy()`;
- unknown outcome does not destroy, resets the close guard, and permits a
  later retry;
- an optimistic-drain timeout does not destroy or classify the write as
  failed, and a later close can retry;
- a second close request while the first drain is active is prevented rather
  than passing through;
- existing draft timeout behavior remains unchanged after optimistic drain
  succeeds.

- [ ] **Step 3: Add failing Vault-root tests**

Render `NotesFeatureProvider` with an old root, start a pending insertion, and
rerender with a new requested root. Assert:

- the nested Notes subtree continues using the old root until drain succeeds;
- after success it activates the new root;
- if drain returns `false`, it stays on the old root and the persistent
  authority message remains;
- with no optimistic insertion, the drain resolves immediately and activates
  the new root.

- [ ] **Step 4: Run tests and confirm failure**

```bash
npm test -- \
  src/features/notes/notesWorkspaceCoordinator.test.ts \
  src/features/notes/useFlushDraftsOnWindowClose.test.tsx \
  src/features/notes/NotesFeature.test.tsx
```

Expected: current close/session cleanup does not wait for optimistic work.

- [ ] **Step 5: Add the coordinator drain**

Resolve waiters from the same insertion add/remove/recovery transitions; do
not poll. `closeSession` must retain accepted keyboard insertion queue items
and their recovery payload until they settle, while removing the closed
session's callback references. `unregisterOutlinePane` discards only a
prepared-but-never-enqueued insertion; queued/running records remain and have
their eventual focus invalidated.

- [ ] **Step 6: Gate window destruction**

Change the hook signature:

```ts
export function useFlushDraftsOnWindowClose(
  flushAllDrafts: () => Promise<boolean>,
  flushSyncExports?: () => Promise<void>,
  drainOptimisticInsertions?: () => Promise<boolean>
): void;
```

If the optimistic drain returns `false`, leave the window open and set
`closing = false`. Race it against the existing 3-second deadline; a timeout
also leaves the window open without changing write authority. Prevent
re-entrant close requests while the first drain is active. Preserve the
existing draft/sync deadline after the optimistic drain succeeds.

- [ ] **Step 7: Hold the Notes Vault root inside the feature provider**

Track `activeVaultRoot` separately from the requested outer context. On a
change, await `workspace.actions.drainOptimisticKeyboardInsertions()`. Wrap the
Notes subtree in a nested `VaultRootContext.Provider` using the active root so
workspace, outline, split host, and sync badge remain consistent during the
wait. Move `NotesImageResidencyProvider` under that nested active-root
boundary so image residency does not switch early.

- [ ] **Step 8: Run lifecycle tests**

```bash
npm test -- \
  src/features/notes/notesWorkspaceCoordinator.test.ts \
  src/features/notes/useFlushDraftsOnWindowClose.test.tsx \
  src/features/notes/NotesFeature.test.tsx
```

Expected: all selected files pass.

- [ ] **Step 9: Commit lifecycle safety**

```bash
git add src/features/notes/notesWorkspaceCoordinator.ts src/features/notes/notesWorkspaceRuntime.ts src/features/notes/useFlushDraftsOnWindowClose.ts src/features/notes/NotesFeature.tsx src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/useFlushDraftsOnWindowClose.test.tsx src/features/notes/NotesFeature.test.tsx
git commit -m "feat(notes): drain optimistic inserts on exit"
```

---

### Task 11: Run Deterministic Gates and Review the Diff

**Files:**
- Verify all implementation files from Tasks 1–10.
- Do not modify the three retained benchmark artifacts in this task.

- [ ] **Step 1: Run the focused optimistic suite**

```bash
npm test -- \
  src/features/notes/notesKeyboardInsertion.test.ts \
  src/features/notes/notesWorkspaceCoordinator.test.ts \
  src/features/notes/useNotesWorkspace.sharedSession.test.tsx \
  src/features/notes/notesWorkspaceContextSplit.test.tsx \
  src/features/notes/NotesWorkspace.test.tsx \
  src/features/notes/outlineKeyboard.test.ts \
  src/features/notes/outlineRowMemo.test.tsx \
  src/features/notes/notesSplitLatencyProbe.test.ts \
  src/features/notes/useFlushDraftsOnWindowClose.test.tsx \
  src/features/notes/NotesFeature.test.tsx
```

Expected: every selected test passes.

- [ ] **Step 2: Run repository gates**

```bash
npm test
npm run lint
npm run test:architecture
npm run build
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 3: Audit the minimum-change boundary**

Confirm from the diff:

- one existing coordinator queue remains;
- no native or persistence contract changed;
- no general store, outbox, scheduler, or new dependency was added;
- only the owner pane receives optimistic descriptors;
- provisional typing never calls `updateNode` before insertion authority;
- known failure and unknown outcome use different branches;
- every optimistic history reservation is either accepted or discarded;
- all success/failure/Undo/close branches resolve their waiters.

- [ ] **Step 4: Inspect the worktree before benchmarking**

```bash
git status --short
git log --oneline --decorate -12
```

Expected: only the three known benchmark artifacts remain uncommitted.

---

### Task 12: Repeat the Isolated Desktop Benchmark and Publish Evidence

**Files:**
- Temporarily retain, then remove after acceptance:
  - `src-tauri/src/notes/performance.rs`
  - `src/main.tsx`
  - `src-tauri/tauri.split-benchmark.conf.json`
- Create or update: `docs/superpowers/reports/2026-07-24-notes-split-view-interaction-performance.md`
- Update: `/Users/doortts/.codex/visualizations/2026/07/24/019f9296-5e76-74b0-a74e-c404baae8ed3/2026-07-24-yonalist-split-view-performance-design.html`

**Preserved benchmark paths:**

```text
/tmp/yonalist-split-bench.tzmf7H
/tmp/yonalist-split-bench.tzmf7H/vault
/Users/doortts/Library/Application Support/com.doortts.yonalist.split-benchmark
/Users/doortts/Library/Application Support/com.doortts.yonalist.split-benchmark/notes
```

- [ ] **Step 1: Extend the retained benchmark result shape**

Record per sample:

```ts
{
  keydownToProvisionalCaretMs: number;
  keydownToAuthoritativeSettlementMs: number;
  provisionalDurationMs: number;
  remountCount: number;
  focusApplicationCount: number;
  lateWorkAfter650Ms: number;
}
```

Keep persistence timing separate from provisional-caret acceptance. Do not add
these probes to production after the benchmark.

- [ ] **Step 2: Reseed the fixed fixture**

With no benchmark process holding the database:

```bash
YONALIST_SPLIT_BENCH_VAULT="/tmp/yonalist-split-bench.tzmf7H/vault" \
YONALIST_SPLIT_BENCH_NOTES_ROOT="/Users/doortts/Library/Application Support/com.doortts.yonalist.split-benchmark/notes" \
  cargo test --manifest-path src-tauri/Cargo.toml \
  notes::performance::seed_split_view_interaction_benchmark_vault \
  -- --ignored --exact
```

Expected: seed test reports `1 passed` and the fixture reports `5000|50|49|1`.

- [ ] **Step 3: Start the isolated desktop build**

```bash
npm run tauri:dev -- --config src-tauri/tauri.split-benchmark.conf.json
```

Expected: one isolated benchmark app uses port 1437 and the benchmark bundle
identifier.

- [ ] **Step 4: Run all physical protocols**

For primary and secondary, measure:

- clean split;
- dirty split;
- clean first-child.

For each scenario:

1. run 10 warm-ups;
2. reset the collector;
3. run 50 physical Enter interactions;
4. use one physical Command-Z after clean split/first-child and two after dirty
   split to restore the fixture;
5. wait 650 ms after the final key sequence before reading results.

Also repeat 50 caret-only ArrowUp/ArrowDown interactions in each pane to
confirm the earlier cursor regression remains fixed.

Expected:

- every applicable Enter sample count is 50;
- all six `p95(keydown → provisional caret)` values are at most 16 ms;
- persistence values are present but do not gate the one-frame metric;
- source/new-row text is correct before IPC completion;
- remount count is 0 at adoption;
- focus application count is 1 per insertion;
- exact physical Undo restores `5000|50|49|1`;
- inactive-pane commits remain 0 for caret-only movement;
- no focus, queue, animation, recovery, or presentation work appears after
  650 ms.

If any provisional-caret p95 exceeds 16 ms, preserve all three benchmark
artifacts and fixture data, capture one React profile of the owner pane, and
stop. Do not add a scheduling layer without a new approved design.

- [ ] **Step 5: Record before/after evidence**

The report must include:

- prior measured post-IPC baselines:
  - primary clean `35/39 ms` p50/p95;
  - primary dirty `29/33 ms`;
  - secondary clean `70/75 ms`;
  - secondary dirty `71/86 ms`;
  - active secondary outline profile `45 ms`;
- all six new provisional-caret p50/p95 values;
- all six authoritative-settlement p50/p95 values;
- sample counts, fixture signature, hardware/runtime, and exact commands;
- deterministic test counts and full gate results;
- known forced-termination limitation.

- [ ] **Step 6: Remove benchmark-only changes after acceptance**

Stop only the isolated benchmark Tauri/Vite process. Use `apply_patch` to:

- remove the benchmark seed helper from
  `src-tauri/src/notes/performance.rs`;
- remove the benchmark probe from `src/main.tsx`;
- delete `src-tauri/tauri.split-benchmark.conf.json`.

After validating the exact two paths, move the isolated fixture and app data
to Trash so recovery remains possible.

Expected `git status --short`: no benchmark Rust, probe, config, Vault, or app
data remains.

- [ ] **Step 7: Update the HTML explanation**

Use the existing `explain-diff-html` artifact and show:

- why waiting for authoritative workspace caused the delay;
- the pane-local provisional row boundary;
- existing queue order and failure branches;
- definite failure versus unknown outcome;
- optimistic Undo and graceful drain;
- the measured before/after table.

Open the local HTML once and verify layout, labels, and benchmark values.

- [ ] **Step 8: Run final gates after cleanup**

```bash
npm test
npm run lint
npm run test:architecture
npm run build
git diff --check
git status --short
```

Expected: every command exits 0 and only the intended report/HTML delivery
changes remain.

- [ ] **Step 9: Commit the evidence**

```bash
git add docs/superpowers/reports/2026-07-24-notes-split-view-interaction-performance.md
git commit -m "docs(notes): report optimistic enter latency"
```

The HTML file lives outside the repository and is not part of the Git commit.
