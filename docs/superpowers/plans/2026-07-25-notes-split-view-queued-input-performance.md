# Notes Split View Queued Input Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make split-view caret movement, Enter, and held Backspace respond immediately while every user-initiated Notes write settles through the per-Vault asynchronous coordinator.

**Architecture:** Extend the existing Notes coordinator and draft engine instead of adding another queue. A held Backspace owns a temporary draft lease and an optimistic outline projection, then submits one atomic `notes_apply_batch` operation on keyup so the whole gesture is one history entry. Restore the measured T1–T4 performance paths against current `main`, add compact delta-only mutation receipts, and expose one strict drain barrier to normal close and Vault switching.

**Tech Stack:** React 19, TypeScript, Vitest/Testing Library, Tauri 2, Rust, rusqlite/SQLite.

## Global Constraints

- Preserve current optimistic Enter, authority recovery, data repair, attachment, read-only, plugin-owned, IME, selection, and focus-epoch behavior.
- Queue admission and visible response are the low-latency contract; physical persistence is not required to finish within tens of milliseconds.
- One physical Backspace press, from initial keydown through keyup, is one Undo unit including its text edits and all eligible empty-bullet removals.
- Automatic repeated removal is allowed only when title and supporting note are empty, no attachments exist, and existing protection rules allow removal.
- Releasing Backspace must stop visible deletion immediately; pending persistence must never replay visible deletes.
- Normal window close and Vault switch wait for a successful drain. On failure they remain open/on the current Vault and expose retry.
- Persistent outbox recovery after crash, forced termination, or power loss is out of scope.
- Do not merge the old performance branch wholesale. Port the relevant behavior from commits `9f763c69`, `b5531e38`, `7b57d814`, and `3b78c208` onto current `main`.
- Desktop proof uses an isolated 5,000-node Vault with 50 visible rows in both panes.
- UI p95 gates: Arrow navigation at most 32 ms, provisional Enter at most 35 ms, and each repeated Backspace transition at most 35 ms.
- Do not add a schema version, file-format version, compatibility reader, or migration.

## Scope decision

Keep one implementation plan. The native gesture batch, draft lease,
coordinator settlement, strict drain, and split-view render paths meet at the
same keyboard-to-persistence acceptance scenario and must share one history and
authority-recovery contract. Each task still ends in a separately reviewable
commit and focused test gate, so a failed performance port cannot obscure the
Backspace correctness work.

## File and responsibility map

- `src-tauri/src/notes/types.rs`: wire type for the Backspace gesture batch and conditional full-workspace serialization.
- `src-tauri/src/notes/repository.rs`: one SQLite transaction that performs sequential empty-node removals plus the final surviving title update.
- `src-tauri/src/notes/commands.rs`: existing `notes_apply_batch` dispatch and mutation receipt policy.
- `src/domain/notes.ts`: frontend `ApplyNotesBatchInput` variant and store contract.
- `src/services/notesStore.ts`: batch input validation and compact receipt decoding.
- `src/features/notes/notesBackspaceGesture.ts`: framework-free gesture state, optimistic row projection, and eligibility/focus helpers.
- `src/features/notes/notesDraftEngine.ts`: gesture-owned draft lease that flushes the pre-gesture baseline and suppresses ordinary debounced saves until settlement.
- `src/features/notes/notesWorkspaceCoordinator.ts`: per-Vault optimistic gesture publication, ordered settlement, recovery, and strict drain barrier.
- `src/features/notes/notesCommands.ts`: submits the gesture batch through the existing structural queue and records final history/navigation state.
- `src/features/notes/notesWorkspaceRuntime.ts`: joins the coordinator, draft lease, command, and React state surfaces.
- `src/features/notes/notesWorkspaceTypes.ts`: narrow action/draft types for gesture lifecycle, direct caret reconciliation, and draining state.
- `src/features/notes/OutlineNodeRow.tsx`: starts/extends the gesture, accepts repeated eligible removal, and focuses the next target synchronously.
- `src/features/notes/NotesOutlinePane.tsx`: composes insertion/removal optimistic projections, owns keyup/blur/visibility gesture termination, and batches To-do progress.
- `src/features/notes/outlineDomFocus.ts`: pane-scoped direct DOM caret helper.
- `src/features/notes/NotesPaneScope.tsx` and `NotesDetailSplitHost.tsx`: defer only the inactive split pane.
- `src/features/notes/useFlushDraftsOnWindowClose.ts`: strict close drain with no forced three-second destroy.
- `src/features/notes/notesVaultDrain.ts`: small registry that lets `App.tsx` request the active Notes Vault drain before changing roots.
- `src/App.tsx`: waits for the current Notes Vault before applying a new `vaultFolder`.
- `src/features/notes/notesSplitLatencyProbe.ts`: development-only caret, row-render, Enter, and Backspace phase probes.
- `docs/superpowers/reports/2026-07-25-notes-split-view-queued-input-performance.md`: final repeat audit and fresh desktop measurements.

---

### Task 0: Capture a fresh pre-change desktop benchmark

**Files:**
- Temporarily modify: `src-tauri/src/notes/performance.rs`
- Temporarily modify: `src/main.tsx`
- Temporarily create: `src-tauri/tauri.split-input-benchmark.conf.json`
- Create: `docs/superpowers/reports/2026-07-25-notes-split-view-queued-input-performance.md`

**Interfaces:**
- Consumes: the existing development-only latency probe, the isolated benchmark fixture pattern from `docs/superpowers/plans/2026-07-24-notes-split-view-interaction-performance.md`, and the fixed 5,000-node/50-visible-row contract.
- Produces: reproducible pre-change p50/p95 measurements and one benchmark harness that is kept unchanged until the post-change measurement.

- [ ] **Step 1: Add tested development-only benchmark collection**

Write the collector test first and verify that it fails because the required
Arrow, Enter, repeated Backspace, keyup-stop, Undo, pane-commit, and backlog
measurements are missing. Add the smallest development-port-only collector and
an ignored native fixture seed. The collector must be a no-op outside the
isolated development benchmark origin.

- [ ] **Step 2: Create and seed an isolated benchmark app**

Use a dedicated bundle identifier, Vite port, Vault, and app-data root. Seed
exactly 5,000 active text nodes with 50 visible rows and at least five
consecutive eligible empty rows for held-Backspace measurement. Record and
verify the fixture signature before measuring.

- [ ] **Step 3: Build, restart, and measure the current source**

For primary and secondary panes separately, run 10 warm-ups followed by 50
measured interactions for ArrowUp/ArrowDown and clean/dirty Enter. Record the
current held-Backspace behavior, including whether repeated structural removal
occurs, and capture the current keyup/Undo outcome even when the feature is
absent. Separate visible response from authoritative settlement.

- [ ] **Step 4: Write the pre-change report section**

Record the exact source commit, environment, fixture signature, commands,
sample counts, p50/p95 values, unsupported pre-change scenarios, and observed
queue/backlog behavior. Keep the measurement harness and fixture for the
post-change run; do not edit the harness between the two measurements unless a
test proves a measurement defect and the report invalidates and reruns the
baseline.

---

### Task 1: Add one atomic Backspace gesture batch to the existing native batch command

**Files:**
- Modify: `src/domain/notes.ts:529-558`
- Modify: `src/services/notesStore.ts:1213-1248`
- Modify: `src/services/notesStore.tauri.test.ts:3340-3440`
- Modify: `src-tauri/src/notes/types.rs:1120-1365`
- Modify: `src-tauri/src/notes/types.rs:2000-2335`
- Modify: `src-tauri/src/notes/repository.rs:7053-7115`
- Modify: `src-tauri/src/notes/repository.rs:7393-7465`
- Modify: `src-tauri/src/notes/repository.rs:18150-18290`
- Modify: `src-tauri/src/notes/commands.rs:1379-1410`
- Modify: `src-tauri/src/notes/commands.rs:15210-16180`

**Interfaces:**
- Consumes: existing `notes_apply_batch`, `NotesHistoryContext`, `with_workspace_transaction`, and single-node `remove_empty_node` validation/child-lifting semantics.
- Produces:

```ts
export interface NotesBackspaceTitleUpdate {
  readonly id: NoteId;
  readonly title: string;
}

export interface ApplyNotesBackspaceGestureInput {
  readonly op: "backspaceGesture";
  readonly nodeIds: readonly NoteId[];
  readonly titleUpdate: NotesBackspaceTitleUpdate | null;
}

// Append `| ApplyNotesBackspaceGestureInput` to the current
// `ApplyNotesBatchInput` union; keep every existing branch verbatim.
```

- Rust wire equivalent:

```rust
pub struct BackspaceTitleUpdate {
    pub id: NoteId,
    pub title: String,
}

pub enum BatchOp {
    // existing variants...
    BackspaceGesture {
        title_update: Option<BackspaceTitleUpdate>,
    },
}
```

- `nodeIds` are ordered exactly as the UI removed the rows. The backend replays that order in one transaction because child lifting changes later row ancestry.

- [ ] **Step 1: Write failing wire and repository tests**

Add the exact wire-shape test below:

```rust
const EMPTY_A_ID: &str = "11111111-1111-4111-8111-111111111111";
const EMPTY_B_ID: &str = "22222222-2222-4222-8222-222222222222";
const SURVIVOR_ID: &str = "33333333-3333-4333-8333-333333333333";

#[test]
fn backspace_gesture_wire_accepts_ordered_removals_and_optional_title() {
    let input: ApplyBatchInput = serde_json::from_value(json!({
        "op": "backspaceGesture",
        "nodeIds": [EMPTY_B_ID, EMPTY_A_ID],
        "titleUpdate": { "id": SURVIVOR_ID, "title": "sur" }
    })).expect("valid gesture");
    assert_eq!(input.node_ids, vec![EMPTY_B_ID, EMPTY_A_ID]);
    assert!(matches!(input.op, BatchOp::BackspaceGesture { .. }));
}
```

Add repository/command cases with these exact postconditions:

- Seed survivor + two empty siblings, execute one gesture, assert the survivor
  title changed and both empty rows disappeared; call the existing history
  replay once and compare the complete restored workspace with the starting
  workspace.
- Run nonempty note, attachment, read-only, and plugin-owned cases separately;
  assert each returns `Err` and a fresh workspace load equals its starting
  workspace.
- Remove nested/adjacent empty parents in submitted order and assert the
  promoted children occupy the same order produced by repeated
  `remove_empty_node`.
- Add a frontend transport test expecting one `notes_apply_batch` call with
  `{ op: "backspaceGesture", nodeIds, titleUpdate }` and exactly one history
  context.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm test -- src/services/notesStore.tauri.test.ts
cargo test --manifest-path src-tauri/Cargo.toml backspace_gesture
```

Expected: TypeScript fails because `backspaceGesture` is not in `ApplyNotesBatchInput`; Rust fails because the wire variant and transaction path do not exist.

- [ ] **Step 3: Refactor single-node removal into a transaction helper**

Extract the body currently inside `remove_empty_node`:

```rust
fn remove_empty_node_in_transaction(
    transaction: &Transaction<'_>,
    node_id: &str,
    deletion_batch_id: &str,
) -> Result<(), String> {
    // Keep require_provider_mutable, require_content_mutable,
    // ensure_generic_parent_allowed, readonly descendant, attachment,
    // empty-title/note, child-lifting, and soft-delete checks unchanged.
}
```

Keep public `remove_empty_node` behavior identical by creating one fresh deletion batch ID inside its existing transaction and calling the helper once.

- [ ] **Step 4: Implement the new batch variant**

In `apply_batch_at`, create one deletion batch ID, call `remove_empty_node_in_transaction` for each submitted `node_id`, then apply the optional title update to the surviving mutable text node and rebuild its derived content:

```rust
BatchOp::BackspaceGesture { title_update } => {
    let deletion_batch_id = fresh_deletion_batch_id(transaction)?;
    for node_id in &node_ids {
        remove_empty_node_in_transaction(
            transaction,
            node_id,
            &deletion_batch_id,
        )?;
    }
    if let Some(update) = title_update {
        update_backspace_survivor_title(transaction, update, today)?;
    }
    Ok(())
}
```

Validation rejects an empty operation (`nodeIds` empty and `titleUpdate` null), duplicate title/removal ownership, an image survivor, protected content, or an invalid ID. Extend `notesApplyBatch` so it permits a title-only gesture but keeps the existing nonempty `nodeIds` rule for every other variant.

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
npm test -- src/services/notesStore.tauri.test.ts
cargo test --manifest-path src-tauri/Cargo.toml backspace_gesture
cargo test --manifest-path src-tauri/Cargo.toml remove_empty_node
```

Expected: all focused tests pass and existing single-node removal behavior is unchanged.

Commit:

```bash
git add src/domain/notes.ts src/services/notesStore.ts src/services/notesStore.tauri.test.ts src-tauri/src/notes/types.rs src-tauri/src/notes/repository.rs src-tauri/src/notes/commands.rs
git commit -m "feat(notes): add atomic backspace gesture batch"
```

---

### Task 2: Build the framework-free Backspace gesture and optimistic projection

**Files:**
- Create: `src/features/notes/notesBackspaceGesture.ts`
- Create: `src/features/notes/notesBackspaceGesture.test.ts`
- Modify: `src/features/notes/notesKeyboardInsertion.ts:70-95`
- Modify: `src/features/notes/notesKeyboardInsertion.test.ts:190-320`

**Interfaces:**
- Consumes: `FlattenedOutlineRow`, `NoteNode`, `NotesHistoryPrimarySelection`, and `deriveOutlineGuideMetadata`.
- Produces:

```ts
export interface OptimisticBackspaceGesture {
  readonly token: number;
  readonly ownerPaneId: NotesPaneId;
  readonly startingNodeId: NoteId;
  readonly startingSelection: NotesHistoryPrimarySelection;
  readonly removedNodeIds: readonly NoteId[];
  readonly titleUpdate: NotesBackspaceTitleUpdate | null;
  readonly focusNodeId: NoteId | null;
  readonly status: "active" | "queued" | "running" | "checking";
}

export function appendBackspaceRemoval(
  gesture: OptimisticBackspaceGesture,
  input: {
    nodeId: NoteId;
    focusNodeId: NoteId | null;
    titleUpdate: NotesBackspaceTitleUpdate | null;
  }
): OptimisticBackspaceGesture;

export function projectOptimisticBackspaceGesture(
  rows: readonly FlattenedOutlineRow[],
  nodesById: Readonly<Record<NoteId, NoteNode>>,
  gesture: OptimisticBackspaceGesture | null
): OptimisticOutlineProjection;
```

- [ ] **Step 1: Write failing pure-state and projection tests**

Define local `row()` and `note()` fixtures by copying the current helpers from
`notesKeyboardInsertion.test.ts`, then add this concrete adjacency/title test:

```ts
it("removes adjacent rows once and overrides the final survivor title", () => {
  const rows = [row("survivor"), row("empty-a"), row("empty-b")];
  const nodes = Object.fromEntries([
    ["survivor", note("survivor", "survivor")],
    ["empty-a", note("empty-a", "")],
    ["empty-b", note("empty-b", "")],
  ]);
  const gesture: OptimisticBackspaceGesture = {
    token: 1,
    ownerPaneId: "primary",
    startingNodeId: "empty-b",
    startingSelection: { anchorUtf16: 0, focusUtf16: 0 },
    removedNodeIds: ["empty-b", "empty-a", "empty-a"],
    titleUpdate: { id: "survivor", title: "sur" },
    focusNodeId: "survivor",
    status: "active",
  };

  const projected = projectOptimisticBackspaceGesture(rows, nodes, gesture);

  expect(projected.rows.map(({ id }) => id)).toEqual(["survivor"]);
  expect(projected.nodeOverrides.get("survivor")?.title).toBe("sur");
  expect(rows.map(({ id }) => id)).toEqual([
    "survivor",
    "empty-a",
    "empty-b",
  ]);
});
```

Add separate cases whose exact assertions are: lifted descendants have
`depth - 1`; direct children receive the removed row's `parentId`; nested
children retain their immediate parent; guide metadata equals
`deriveOutlineGuideMetadata(projected.rows)`; and the input row/node
collections retain their original identities and values.
- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npm test -- src/features/notes/notesBackspaceGesture.test.ts
```

Expected: module import failure.

- [ ] **Step 3: Implement the immutable gesture helpers**

For each removed row:

1. locate it in the currently projected rows;
2. drop only that row;
3. decrement every visible descendant depth and remove the deleted ancestor ID;
4. rewrite only direct children to the removed row's parent;
5. preserve current row order;
6. apply the final survivor title through `nodeOverrides`;
7. recompute guide metadata once after all removals.

Move the shared `sameNumbers`/guide finalization helper out of insertion-only code so insertion and removal projections use the same identity-preserving final pass.

- [ ] **Step 4: Compose insertion then removal without changing insertion behavior**

Export:

```ts
export function projectOptimisticOutline(
  rows: readonly FlattenedOutlineRow[],
  nodesById: Readonly<Record<NoteId, NoteNode>>,
  insertions: readonly OptimisticKeyboardInsertion[],
  backspaceGesture: OptimisticBackspaceGesture | null
): OptimisticOutlineProjection;
```

Apply insertions first, then the Backspace gesture, merging both `nodeOverrides` maps. Existing insertion tests must continue to pass unchanged.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm test -- src/features/notes/notesBackspaceGesture.test.ts src/features/notes/notesKeyboardInsertion.test.ts
```

Commit:

```bash
git add src/features/notes/notesBackspaceGesture.ts src/features/notes/notesBackspaceGesture.test.ts src/features/notes/notesKeyboardInsertion.ts src/features/notes/notesKeyboardInsertion.test.ts
git commit -m "feat(notes): project held backspace gestures"
```

---

### Task 3: Give held Backspace exclusive ownership of its draft revisions

**Files:**
- Modify: `src/features/notes/notesDraftEngine.ts:45-105`
- Modify: `src/features/notes/notesDraftEngine.ts:1125-1315`
- Modify: `src/features/notes/notesDraftEngine.test.ts`
- Modify: `src/features/notes/useNotesDraftWorkflow.ts:130-215`
- Modify: `src/features/notes/notesWorkspaceTypes.ts:200-330`

**Interfaces:**
- Consumes: existing per-node draft revision, retry, debounce, history, and `NotesWriteQueue` behavior.
- Produces:

```ts
export interface NotesBackspaceDraftCommit {
  readonly baselineFlushed: boolean;
  readonly titleUpdate: NotesBackspaceTitleUpdate | null;
}

export interface NotesBackspaceDraftLease {
  readonly token: number;
  touch(nodeId: NoteId): void;
  prepare(removedNodeIds: readonly NoteId[]): Promise<NotesBackspaceDraftCommit>;
  settle(outcome: "committed" | "failed" | "cancelled"): void;
}

class NotesDraftEngine {
  beginBackspaceGesture(token: number, nodeId: NoteId): NotesBackspaceDraftLease | null;
}
```

- [ ] **Step 1: Write failing engine tests**

Use fake timers and the existing `createHarness()` helper for this concrete
debounce-ownership case:

```ts
it("keeps gesture revisions out of the ordinary debounce", async () => {
  vi.useFakeTimers();
  const store = repository();
  const { engine } = createHarness({ store });
  engine.updateNodeDraft(
    "root",
    { title: "before", note: "", imageOffsetUtf16: 0 },
    "title",
  );
  const lease = engine.beginBackspaceGesture(7, "root");
  expect(lease).not.toBeNull();
  engine.updateNodeDraft(
    "root",
    { title: "after", note: "", imageOffsetUtf16: 0 },
    "title",
  );

  await vi.advanceTimersByTimeAsync(MAX_DEBOUNCE_LATENCY_MS + 1);

  expect(store.updateNode).toHaveBeenCalledTimes(1);
  const prepared = await lease!.prepare([]);
  expect(prepared).toEqual({
    baselineFlushed: true,
    titleUpdate: { id: "root", title: "after" },
  });
});
```

Add separate assertions that touching a second node flushes its baseline,
removed-node drafts are omitted from `titleUpdate`, committed settlement
retires held drafts, failed settlement restores the starting draft map, and
`session.history.closeTextBurst` runs before the first gesture-owned revision.
- [ ] **Step 2: Run the engine tests and verify RED**

Run:

```bash
npm test -- src/features/notes/notesDraftEngine.test.ts
```

Expected: missing `beginBackspaceGesture`.

- [ ] **Step 3: Add lease bookkeeping**

Add one active lease per engine record:

```ts
interface BackspaceDraftLeaseState {
  readonly token: number;
  readonly touchedNodeIds: Set<NoteId>;
  readonly startingDrafts: Map<NoteId, NotesNodeDraft | null>;
  readonly baselineFlushes: Promise<boolean>[];
  active: boolean;
}
```

`touch(nodeId)` must synchronously mark the node as held before the browser's following `input` event. It captures the current attempt, closes its text burst, forces that captured attempt into the write queue, then keeps later revisions out of `scheduleDraftWrite`, `flushDraftsThroughCutoff`, and ordinary `flushAllDrafts`.

- [ ] **Step 4: Implement prepare and settlement**

`prepare` waits for all captured baseline flushes. If any returns false, it returns `baselineFlushed: false` and no batch may run. Otherwise it returns the latest title for the one surviving touched node; removed nodes remain represented only by `nodeIds`.

On committed settlement, retire all held revisions without another write. On failure/cancel, restore the starting draft map and normal scheduling. Publish the draft slice once per state change.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm test -- src/features/notes/notesDraftEngine.test.ts src/features/notes/useNotesWorkspace.operations.test.tsx
```

Commit:

```bash
git add src/features/notes/notesDraftEngine.ts src/features/notes/notesDraftEngine.test.ts src/features/notes/useNotesDraftWorkflow.ts src/features/notes/notesWorkspaceTypes.ts
git commit -m "feat(notes): hold drafts for backspace gestures"
```

---

### Task 4: Integrate repeated optimistic Backspace through the coordinator and UI

**Files:**
- Modify: `src/features/notes/outlineKeyboard.ts:540-850`
- Modify: `src/features/notes/outlineKeyboard.test.ts`
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts:130-360`
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts:2250-2965`
- Modify: `src/features/notes/notesWorkspaceCoordinator.test.ts`
- Modify: `src/features/notes/notesCommands.ts:3050-3190`
- Modify: `src/features/notes/useNotesCommandActions.ts:300-345`
- Modify: `src/features/notes/notesWorkspaceRuntime.ts:780-850`
- Modify: `src/features/notes/notesWorkspaceRuntime.ts:1260-1330`
- Modify: `src/features/notes/notesWorkspaceTypes.ts:207-440`
- Modify: `src/features/notes/OutlineNodeRow.tsx:1150-1510`
- Modify: `src/features/notes/NotesOutlinePane.tsx:840-875`
- Modify: `src/features/notes/NotesOutlinePane.tsx:1520-1590`
- Modify: `src/features/notes/NotesWorkspace.test.tsx:11630-11820`

**Interfaces:**
- Consumes: Tasks 1–3, existing coordinator queue/history recovery, `focusedUiUpdate`, and pane interaction epochs.
- Produces on `NotesWorkspaceActions`:

```ts
beginBackspaceGesture(
  paneId: NotesPaneId,
  nodeId: NoteId,
  selection: NotesHistoryPrimarySelection
): number | null;
touchBackspaceGesture(token: number, nodeId: NoteId): void;
removeEmptyNodeInBackspaceGesture(
  token: number,
  nodeId: NoteId,
  focusNodeId: NoteId | null
): boolean;
finishBackspaceGesture(reason: "keyup" | "blur" | "hidden" | "drain"): Promise<void>;
cancelBackspaceGesture(): void;
```

The drafts slice gains:

```ts
optimisticBackspaceGesture?: OptimisticBackspaceGesture | null;
```

- [ ] **Step 1: Change resolver tests before production code**

Add explicit cases:

```ts
it("resolves repeat Backspace on an eligible empty row to remove", () => {
  expect(resolveOutlineKey({ ...eligibleInput, repeat: true }))
    .toEqual({ type: "remove", focusNodeId: "previous" });
});

expect(
  resolveOutlineKey(
    input({
      key: "Backspace",
      repeat: true,
      title: "",
      note: "keep",
      selectionStart: 0,
      selectionEnd: 0,
    }),
  ),
).not.toMatchObject({ type: "remove" });

// Add `repeat: true` to the file's existing `withAttachment` Backspace
// fixture and retain its `toBeNull()` assertion. Read-only and plugin-owned
// protection is asserted in NotesWorkspace integration tests because those
// guards belong to OutlineNodeRow, not the pure resolver.
```

Update the old test that codified `repeat: true` suppression. Repeat suppression remains for indentation, structural move/duplicate/toggle/delete shortcuts, Shift+Enter, Command/Ctrl+Enter, zoom, and F6.

- [ ] **Step 2: Run resolver and workspace tests and verify RED**

Run:

```bash
npm test -- src/features/notes/outlineKeyboard.test.ts src/features/notes/NotesWorkspace.test.tsx
```

Expected: resolver still returns `null` for repeated Backspace and the workspace has no gesture action.

- [ ] **Step 3: Add coordinator gesture publication and batch settlement**

Store at most one active gesture in each per-Vault coordinator entry. `begin` reserves one structural history entry and publishes the active snapshot. `remove` updates the snapshot immediately and never adds a persistence item. `finish`:

1. freezes the optimistic snapshot;
2. awaits `NotesBackspaceDraftLease.prepare`;
3. calls `session.enqueueStructural` once with `requireAllBarriers: true`;
4. invokes `repository.applyBatch(vaultRoot, { op: "backspaceGesture", ... }, historyContext)`;
5. projects the returned delta, remembers history after, and settles the draft lease;
6. clears the optimistic snapshot only after authoritative adoption;
7. on known failure, restores the checkpoint and draft lease;
8. on unknown outcome, keeps status `checking` and uses the existing entry-ID authority recovery.

Add coordinator tests that hold the repository promise and assert ten optimistic removals publish before exactly one queued repository call.

- [ ] **Step 4: Wire row events and lifecycle termination**

In `handleTitleKeyDown`, start a gesture for plain, non-composing Backspace before native deletion. For `resolution.type === "remove"`:

```ts
event.preventDefault();
const token = actions.beginBackspaceGesture?.(
  paneId,
  nodeId,
  {
    anchorUtf16: event.currentTarget.selectionStart,
    focusUtf16: event.currentTarget.selectionEnd,
  },
);
if (token === null || token === undefined) return;
actions.touchBackspaceGesture?.(token, resolution.focusNodeId ?? nodeId);
if (focusPreviousTitleSynchronously(...)) {
  actions.removeEmptyNodeInBackspaceGesture?.(
    token,
    nodeId,
    resolution.focusNodeId,
  );
}
```

Do not use `structuralCommandInFlightRef` for gesture removals. Keep it for every one-shot structural command.

At `NotesOutlinePane` scope, register capture listeners for Backspace `keyup`, window `blur`, and `visibilitychange`; each calls `finishBackspaceGesture` once. Unmount/drain calls the same close path. Keyup clears visible gesture acceptance before awaiting persistence.

- [ ] **Step 5: Prove the complete UI/history behavior**

Add integration tests that:

- delete characters natively, cross five empty rows with `repeat: true`, and stop at keyup;
- observe all removals before the deferred repository batch resolves;
- see no extra removal after keyup;
- verify one `applyBatch` call and one history entry;
- invoke one Undo and restore every row, original title, and starting selection;
- roll back the full gesture on known failure;
- enter authority recovery without duplicate application on unknown outcome;
- preserve collapsed-parent child lifting and focus fallback;
- leave note/attachment/read-only/plugin rows intact.

Run:

```bash
npm test -- src/features/notes/outlineKeyboard.test.ts src/features/notes/notesBackspaceGesture.test.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/NotesWorkspace.test.tsx
```

Commit:

```bash
git add src/features/notes/outlineKeyboard.ts src/features/notes/outlineKeyboard.test.ts src/features/notes/notesWorkspaceCoordinator.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/notesCommands.ts src/features/notes/useNotesCommandActions.ts src/features/notes/notesWorkspaceRuntime.ts src/features/notes/notesWorkspaceTypes.ts src/features/notes/OutlineNodeRow.tsx src/features/notes/NotesOutlinePane.tsx src/features/notes/NotesWorkspace.test.tsx
git commit -m "feat(notes): repeat held backspace as one undo"
```

- [ ] **Step 6: Prove the first desktop vertical slice**

Build and restart the Tauri app from the current source, create an isolated small Vault, open split view, hold Backspace across at least five empty bullets, release, and press Command-Z once.

Expected:

- the active pane removes rows at key-repeat cadence;
- the inactive pane catches up;
- release stops immediately;
- one Undo restores all five rows and starting text;
- no second write or deletion appears after waiting two seconds.

If the first unexplained runtime failure occurs, inspect Web Inspector/logs before editing. After two failed fixes for the same symptom, stop and gather new evidence.

---

### Task 5: Add a strict per-Vault drain for normal close and Vault switching

**Files:**
- Create: `src/features/notes/notesVaultDrain.ts`
- Create: `src/features/notes/notesVaultDrain.test.ts`
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts:203-325`
- Modify: `src/features/notes/notesWorkspaceCoordinator.test.ts`
- Modify: `src/features/notes/notesDraftEngine.ts:890-980`
- Modify: `src/features/notes/notesWorkspaceRuntime.ts:1260-1330`
- Modify: `src/features/notes/notesWorkspaceTypes.ts:315-330`
- Modify: `src/features/notes/NotesFeature.tsx:180-200`
- Modify: `src/features/notes/useFlushDraftsOnWindowClose.ts`
- Modify: `src/features/notes/useFlushDraftsOnWindowClose.test.tsx`
- Modify: `src/App.tsx:2040-2070`
- Modify: `src/App.test.tsx`

**Interfaces:**
- Consumes: coordinator structural tail, draft write queue, attachment structural commands, history cleanup, `notesSyncFlush`, and Task 4 gesture close.
- Produces:

```ts
export interface NotesVaultDrainParticipant {
  drain(): Promise<boolean>;
}

export function registerNotesVaultDrain(
  vaultRoot: string,
  participant: NotesVaultDrainParticipant
): () => void;

export async function drainNotesVault(vaultRoot: string): Promise<boolean>;

export interface NotesWorkspaceCoordinatorSession {
  // existing methods...
  drain(): Promise<boolean>;
}
```

- [ ] **Step 1: Replace close-anyway expectations with strict failing tests**

Replace the current timeout test with this concrete pending-drain assertion:

```ts
it("keeps the window open until the strict drain succeeds", async () => {
  vi.useFakeTimers();
  let resolveDrain!: (value: boolean) => void;
  const drain = new Promise<boolean>((resolve) => {
    resolveDrain = resolve;
  });
  await act(async () => {
    render(<Harness flush={() => drain} />);
    await flushMicrotasks();
  });
  const handler = onCloseRequested.mock.calls[0][0] as (
    event: { preventDefault(): void },
  ) => Promise<void>;
  const closing = handler({ preventDefault: vi.fn() });

  await vi.advanceTimersByTimeAsync(10_000);
  expect(destroy).not.toHaveBeenCalled();

  resolveDrain(true);
  await closing;
  expect(destroy).toHaveBeenCalledTimes(1);
});
```

Add separate cases asserting draft/coordinator/sync ordering, no destroy on
false or rejection, and two close requests sharing one drain promise.
Add App tests proving `vaultFolder` remains the old value until `drainNotesVault(oldRoot)` resolves true and remains unchanged on false/rejection.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm test -- src/features/notes/useFlushDraftsOnWindowClose.test.tsx src/features/notes/notesVaultDrain.test.ts src/App.test.tsx
```

Expected: current hook destroys after timeout/failure and App switches immediately.

- [ ] **Step 3: Implement coordinator and draft drain**

`session.drain()` waits for:

1. active Backspace gesture finalization;
2. every structural barrier already admitted;
3. current and queued coordinator items;
4. draft queue flush;
5. attachment work already represented by structural items;
6. pending history cleanup.

Use a serialized observer barrier after `entry.structuralTail`; do not poll or add a timeout. While a lifecycle drain owns the session, reject new user writes but allow its own flush/observer work. Release the drain lock if the drain fails so the current Vault remains editable.

- [ ] **Step 4: Register the active Notes drain and gate both lifecycle exits**

`NotesFeature` registers one participant for its `vaultRoot`. Close calls `drainNotesVault(vaultRoot)` then `notesSyncFlush(vaultRoot)` and invokes `appWindow.destroy()` only after both succeed.

In `App.updateSetting`, special-case `vaultFolder`:

```ts
async function switchVaultFolder(nextVaultFolder: string): Promise<void> {
  const currentRoot = vaultRoot;
  setSettingsStatus("Saving current Vault…");
  if (!(await drainNotesVault(currentRoot))) {
    setSettingsStatus("Could not save the current Vault. Try again.");
    return;
  }
  setSettings((current) => ({ ...current, vaultFolder: nextVaultFolder }));
  setSettingsStatus("");
}
```

Use a monotonically increasing request token so a stale folder-picker result cannot win after a later request.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm test -- src/features/notes/notesVaultDrain.test.ts src/features/notes/useFlushDraftsOnWindowClose.test.tsx src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/notesDraftEngine.test.ts src/App.test.tsx
```

Commit:

```bash
git add src/features/notes/notesVaultDrain.ts src/features/notes/notesVaultDrain.test.ts src/features/notes/notesWorkspaceCoordinator.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/notesDraftEngine.ts src/features/notes/notesWorkspaceRuntime.ts src/features/notes/notesWorkspaceTypes.ts src/features/notes/NotesFeature.tsx src/features/notes/useFlushDraftsOnWindowClose.ts src/features/notes/useFlushDraftsOnWindowClose.test.tsx src/App.tsx src/App.test.tsx
git commit -m "feat(notes): drain writes before close and vault switch"
```

---

### Task 6: Restore T1 direct DOM caret movement

**Files:**
- Create: `src/features/notes/outlineDomFocus.ts`
- Create: `src/features/notes/outlineDomFocus.test.ts`
- Modify: `src/features/notes/notesWorkspaceReducer.ts:185-220`
- Modify: `src/features/notes/notesWorkspaceReducer.ts:700-775`
- Modify: `src/features/notes/notesWorkspaceReducer.test.ts`
- Modify: `src/features/notes/notesWorkspaceTypes.ts:245-285`
- Modify: `src/features/notes/notesWorkspaceRuntime.ts:1260-1320`
- Modify: `src/features/notes/OutlineNodeRow.tsx:1390-1450`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**
- Consumes: pane root `.notes-outline`, row `data-outline-id`, title textarea class, and focus epoch.
- Produces:

```ts
export type OutlineCaretEdge =
  | "start"
  | "end"
  | { readonly start: number; readonly end: number };

export function focusOutlineEditorDom(
  paneRoot: HTMLElement,
  nodeId: NoteId,
  field: "title" | "note",
  edge: OutlineCaretEdge | null
): boolean;

notifyCaretMovedByDom?(nodeId: NoteId, field: NotesHistoryFocusField): void;
```

- [ ] **Step 1: Restore the historical failing tests**

Port the behavioral tests from commit `9f763c69` and update them for current action types. Prove selector escaping, start/end/range placement, missing target fallback, and no stale pending-focus request.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
npm test -- src/features/notes/outlineDomFocus.test.ts src/features/notes/notesWorkspaceReducer.test.ts src/features/notes/NotesWorkspace.test.tsx
```

- [ ] **Step 3: Implement direct focus and reducer catch-up**

On `resolution.type === "focus"`, call `focusOutlineEditorDom` synchronously. When it succeeds, dispatch `caretMovedByDom`, which updates selected/editing state and clears pending focus. When it fails, retain the existing `actions.focusNode` path.

Use `"end"` for cross-bullet Left and held-Backspace fallback, `"start"` for Right, the explicit selection for preserved ranges, and `null` for Up/Down.

- [ ] **Step 4: Verify repeat has no reducer-focus backlog**

Add a 50-event test in both pane directions. Assert the target receives focus for every event, `focusNode` fallback is not called, and pending-focus effects do not refocus after the final event.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm test -- src/features/notes/outlineDomFocus.test.ts src/features/notes/notesWorkspaceReducer.test.ts src/features/notes/NotesWorkspace.test.tsx
```

Commit:

```bash
git add src/features/notes/outlineDomFocus.ts src/features/notes/outlineDomFocus.test.ts src/features/notes/notesWorkspaceReducer.ts src/features/notes/notesWorkspaceReducer.test.ts src/features/notes/notesWorkspaceTypes.ts src/features/notes/notesWorkspaceRuntime.ts src/features/notes/OutlineNodeRow.tsx src/features/notes/NotesWorkspace.test.tsx
git commit -m "perf(notes): move caret through direct dom focus"
```

---

### Task 7: Restore T3 batched row work and T4 inactive-pane deferral

**Files:**
- Modify: `src/features/notes/notesTodoProgress.ts`
- Modify: `src/features/notes/notesTodoProgress.test.ts`
- Modify: `src/features/notes/NotesOutlinePane.tsx:4400-4490`
- Modify: `src/features/notes/NotesPaneScope.tsx`
- Modify: `src/features/notes/NotesPaneScope.test.tsx`
- Modify: `src/features/notes/NotesDetailSplitHost.tsx:215-275`
- Modify: `src/features/notes/notesWorkspaceContextSplit.test.tsx`
- Modify: `src/features/notes/notesSplitLatencyProbe.ts`
- Modify: `src/features/notes/notesSplitLatencyProbe.test.ts`
- Modify: `src/features/notes/OutlineNodeRow.tsx:220-255`

**Interfaces:**
- Consumes: stable `nodesById`/`childIdsByParent` references, pane registry `activePaneId`, and React `useDeferredValue`.
- Produces:

```ts
export function buildTodoProgressMap(
  nodesById: Readonly<Record<NoteId, NoteNode>>,
  childIdsByParent: Readonly<Record<NoteId, readonly NoteId[]>>
): ReadonlyMap<NoteId, NotesTodoProgressValue>;

export function NotesPaneScope(props: PropsWithChildren<{
  paneId: NotesPaneId;
  deferWhenInactive?: boolean;
}>): ReactElement;
```

- [ ] **Step 1: Port focused T3/T4 tests and verify RED**

Port the behavior from commits `b5531e38` and `3b78c208`:

- one O(N) progress build per stable workspace reference;
- per-row lookup only;
- active pane receives the current slice;
- inactive pane first retains the previous structural slice, then converges;
- actions are never deferred;
- 50 caret-only active-pane moves produce zero inactive outline commits.

Run:

```bash
npm test -- src/features/notes/notesTodoProgress.test.ts src/features/notes/NotesPaneScope.test.tsx src/features/notes/notesWorkspaceContextSplit.test.tsx src/features/notes/notesSplitLatencyProbe.test.ts
```

- [ ] **Step 2: Implement the batched To-do map**

Build once in `NotesOutlinePane` with:

```ts
const todoProgressByParent = useMemo(
  () => buildTodoProgressMap(state.nodesById, state.childIdsByParent),
  [state.nodesById, state.childIdsByParent]
);
```

Replace each row's `directTodoProgress` scan with `todoProgressByParent.get(row.id) ?? null`.

- [ ] **Step 3: Defer only inactive state and draft slices**

In `NotesPaneScope`, always call `useDeferredValue` for state and drafts, select deferred values only when `deferWhenInactive && activePaneId !== paneId`, and always pass current actions. `NotesDetailSplitHost` sets `deferWhenInactive={layout.splitOpen}` on both scopes.

- [ ] **Step 4: Restore development-only render probes**

Restore `markRowRender`, caret phase marks, and counters as guarded no-ops when the development probe is disabled. Do not leave console output or production timing allocations enabled.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm test -- src/features/notes/notesTodoProgress.test.ts src/features/notes/NotesPaneScope.test.tsx src/features/notes/notesWorkspaceContextSplit.test.tsx src/features/notes/notesSplitLatencyProbe.test.ts src/features/notes/outlineRowMemo.test.tsx
```

Commit:

```bash
git add src/features/notes/notesTodoProgress.ts src/features/notes/notesTodoProgress.test.ts src/features/notes/NotesOutlinePane.tsx src/features/notes/NotesPaneScope.tsx src/features/notes/NotesPaneScope.test.tsx src/features/notes/NotesDetailSplitHost.tsx src/features/notes/notesWorkspaceContextSplit.test.tsx src/features/notes/notesSplitLatencyProbe.ts src/features/notes/notesSplitLatencyProbe.test.ts src/features/notes/OutlineNodeRow.tsx
git commit -m "perf(notes): defer inactive split rendering"
```

---

### Task 8: Restore T2 compact delta-only mutation receipts

**Files:**
- Modify: `src-tauri/src/notes/types.rs:220-275`
- Modify: `src-tauri/src/notes/types.rs:2520-2680`
- Modify: `src-tauri/src/notes/history.rs`
- Modify: `src-tauri/src/notes/commands.rs`
- Modify: `src-tauri/src/notes/image_atom.rs`
- Modify: `src/services/notesStore.ts:1300-1410`
- Modify: `src/services/notesStore.test.ts`
- Modify: `src/services/notesStore.tauri.test.ts`
- Modify: `src/features/notes/notesWorkspaceProjection.ts`
- Modify: `src/features/notes/notesWorkspaceProjection.test.ts`
- Modify: `src/features/notes/notesWorkspaceReducer.ts`
- Modify: `src/features/notes/notesWorkspaceReducer.test.ts`

**Interfaces:**
- Consumes: mutation audit deltas, current `NotesMutationResult`, projection fallback, and historical behavior from commit `7b57d814`.
- Produces: IPC mutation payloads may omit `workspace` only when a complete nonempty delta is present and the command is not an explicit full-workspace consumer.

- [ ] **Step 1: Restore exact wire-shape tests and verify RED**

Restore this exact historical delta-only assertion, adapted only for current
required fields:

```rust
#[test]
fn delta_only_mutation_omits_the_workspace_from_the_wire() {
    let node = note_node();
    let mutation = NotesMutationResult {
        workspace: NotesWorkspace {
            nodes: vec![node.clone()],
            attachments_by_node_id: std::collections::BTreeMap::new(),
        },
        serialize_workspace: false,
        history_entry_id: Some(SECOND_ID.to_string()),
        state: history_state(),
        changed_nodes: Some(vec![node]),
        removed_node_ids: Some(vec![THIRD_ID.to_string()]),
        changed_attachments: Some(Vec::new()),
        imported_root_ids: None,
        duplicated_root_ids: None,
    };
    let value = serde_json::to_value(mutation).expect("delta-only mutation");
    assert!(value.get("workspace").is_none());
    assert!(value.get("changedNodes").is_some());
    assert_eq!(value["removedNodeIds"], json!([THIRD_ID]));
    assert_eq!(value["historyEntryId"], json!(SECOND_ID));
}
```

Keep the existing full-workspace serialization test with
`serialize_workspace: true` and assert `value["workspace"]` equals the complete
workspace object.
Frontend decoding must accept `{ changedNodes, removedNodeIds, ...history }` without `workspace`, reject a payload with neither workspace nor a complete delta, and preserve existing full-workspace fallback.

Run:

```bash
npm test -- src/services/notesStore.test.ts src/services/notesStore.tauri.test.ts src/features/notes/notesWorkspaceProjection.test.ts src/features/notes/notesWorkspaceReducer.test.ts
cargo test --manifest-path src-tauri/Cargo.toml mutation_delta
```

- [ ] **Step 2: Port conditional Rust serialization**

Restore an internal `serialize_workspace: bool` decision and a manual `Serialize` implementation equivalent to commit `7b57d814`. Keep the full workspace in Rust memory. Default mutation construction omits it only when the delta is sufficient.

Explicitly retain wire `workspace` for image-node import/paste and any command whose frontend decoder reads full workspace fields not represented by the delta.

- [ ] **Step 3: Decode and settle compact receipts**

Change the frontend mutation result type to `workspace?: NotesWorkspace`. `projectNotesMutation` reconstructs the next workspace from the coordinator's confirmed base plus delta. Authority recovery and mismatched-scope paths load a full workspace when they cannot prove that base/delta pair.

- [ ] **Step 4: Run native/frontend owning tests**

Run:

```bash
npm test -- src/services/notesStore.test.ts src/services/notesStore.tauri.test.ts src/features/notes/notesWorkspaceProjection.test.ts src/features/notes/notesWorkspaceReducer.test.ts src/features/notes/notesWorkspaceCoordinator.test.ts
cargo test --manifest-path src-tauri/Cargo.toml mutation_delta
cargo test --manifest-path src-tauri/Cargo.toml image_atom
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/notes/types.rs src-tauri/src/notes/history.rs src-tauri/src/notes/commands.rs src-tauri/src/notes/image_atom.rs src/services/notesStore.ts src/services/notesStore.test.ts src/services/notesStore.tauri.test.ts src/features/notes/notesWorkspaceProjection.ts src/features/notes/notesWorkspaceProjection.test.ts src/features/notes/notesWorkspaceReducer.ts src/features/notes/notesWorkspaceReducer.test.ts
git commit -m "perf(notes): omit redundant mutation workspaces"
```

---

### Task 9: Audit keyboard repeat and complete fresh runtime verification

**Files:**
- Modify: `src/features/notes/outlineKeyboard.test.ts`
- Modify: `src/features/notes/notesSplitLatencyProbe.ts`
- Modify: `src/features/notes/notesSplitLatencyProbe.test.ts`
- Create: `docs/superpowers/reports/2026-07-25-notes-split-view-queued-input-performance.md`

**Interfaces:**
- Consumes: all prior tasks and the benchmark method from `docs/superpowers/reports/2026-07-24-notes-split-view-interaction-performance.md`.
- Produces: final repeat-support table, before/after p50/p95, settlement timings, and reproducible pass/fail evidence.

- [ ] **Step 1: Freeze an exhaustive repeat policy test**

Use a table-driven test covering:

```ts
const repeatPolicy = [
  ["plain text Backspace", "native-repeat"],
  ["eligible empty-row Backspace", "app-repeat"],
  ["ArrowUp/ArrowDown", "app-repeat"],
  ["cross-row ArrowLeft/ArrowRight", "app-repeat"],
  ["plain Enter", "app-repeat"],
  ["Shift+Enter", "one-shot"],
  ["Command/Ctrl+Enter", "one-shot"],
  ["Tab/Shift+Tab", "one-shot"],
  ["move/duplicate/toggle/delete shortcuts", "one-shot"],
  ["zoom shortcuts", "one-shot"],
  ["F6", "one-shot"]
] as const;
```

Assert every one-shot repeat is consumed or ignored without mutation and every repeatable command resolves consistently.

- [ ] **Step 2: Run the complete focused Notes set**

Run:

```bash
npm test -- src/features/notes/outlineKeyboard.test.ts src/features/notes/outlineDomFocus.test.ts src/features/notes/notesBackspaceGesture.test.ts src/features/notes/notesDraftEngine.test.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/NotesPaneScope.test.tsx src/features/notes/NotesWorkspace.test.tsx src/features/notes/useFlushDraftsOnWindowClose.test.tsx src/features/notes/notesVaultDrain.test.ts src/services/notesStore.test.ts src/services/notesStore.tauri.test.ts
cargo test --manifest-path src-tauri/Cargo.toml backspace_gesture
cargo test --manifest-path src-tauri/Cargo.toml mutation_delta
```

Expected: all focused tests pass with no order-dependent rerun.

- [ ] **Step 3: Run the fresh desktop benchmark**

Build and restart the exact source under test. Use an isolated 5,000-node Vault with 50 visible rows and split view open. For primary and secondary panes separately, run 10 warm-ups then 50 measured interactions for:

1. ArrowUp/ArrowDown;
2. clean and dirty Enter;
3. held Backspace crossing at least five eligible empty rows;
4. keyup immediately after a structural delete;
5. one Undo of that gesture.

Record:

- keydown to DOM/provisional caret/visible Backspace transition;
- keyup to last visible deletion count;
- provisional UI to authoritative settlement;
- active and inactive pane commit counts;
- command/focus/history backlog after two seconds.

- [ ] **Step 4: Write the report and fix only evidence-backed misses**

The report contains:

- environment and fixed data signature;
- p50/p95 before/after table;
- pass/fail against 32/35/35 ms UI gates;
- persistence settlement distribution without a tens-of-milliseconds claim;
- close and Vault-switch drain proof;
- one-Undo restoration proof;
- final intentional one-shot/repeatable key table;
- any remaining risk.

If a metric misses, use the phase probe to identify the first divergent boundary before changing code. Do not combine speculative fixes.

- [ ] **Step 5: Run final gates once after the diff is frozen**

Run:

```bash
npm test
npm run lint
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
git diff --check
```

Expected: all applicable frontend and Rust gates pass. Compare any warning with the recorded baseline instead of hiding it.

- [ ] **Step 6: Review, commit the report, and hand off**

Review the complete diff for unrelated edits, debug probes, temporary Vault data, and generated artifacts. Then commit:

```bash
git add docs/superpowers/reports/2026-07-25-notes-split-view-queued-input-performance.md src/features/notes/outlineKeyboard.test.ts src/features/notes/notesSplitLatencyProbe.ts src/features/notes/notesSplitLatencyProbe.test.ts
git commit -m "test(notes): verify queued split input performance"
```

Report the exact gate results, desktop measurements, repeat-policy list, remaining risks, and commit hashes.
