# Notes Split View Interaction Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep split-view Enter and caret navigation on the existing fast path by preserving the origin publication and preventing inactive-pane commits.

**Architecture:** Retain the current session-level publication and prefer its pane candidate carrying the keyboard insertion disposition. Keep pane runtime slices referentially stable by depending only on their true shared and pane-local fields, then pass those slices through a memoized split-pane boundary instead of subscribing each pane scope to the aggregate registry.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Tauri 2, macOS Web Inspector, existing Notes latency and layout-motion probes.

## Global Constraints

- The representative fixture is 5,000 total text nodes with 50 visible rows.
- Each desktop scenario uses 10 warm-ups followed by 50 measured interactions.
- Enter must satisfy `p95(focus - IPC end) <= 16 ms`.
- Enter-owned FLIP rectangle reads and animations must both be zero.
- Caret-only movement must commit the inactive pane zero times.
- Do not change Enter semantics, optimistic state, motion policy for unrelated commands, Rust/IPC/SQLite/filesystem contracts, persistence, history, or Undo/Redo.
- Do not add a general external store, pane selector framework, or permanent benchmark framework.
- Preserve the existing merge-conflicted worktree; all work stays in `/Users/doortts/Documents/yonalist/.worktrees/split-view-interaction-performance`.

---

## File Map

- Modify `src/features/notes/notesWorkspaceCoordinator.ts`: retain the pane candidate carrying `keyboardInsertionDisposition` when reducing to a session publication.
- Modify `src/features/notes/notesWorkspaceCoordinator.test.ts`: prove the retained disposition for primary and secondary origin directions.
- Modify `src/features/notes/useNotesEditingLease.ts`: make lease predicates stable callbacks.
- Modify `src/features/notes/useNotesEditingLease.test.tsx`: prove method identity survives lease/composition value changes.
- Modify `src/features/notes/useNotesWorkspacePaneRegistry.ts`: depend on stable lease methods and assemble secondary slices from exact fields.
- Modify `src/features/notes/notesWorkspaceContextSplit.test.tsx`: prove inactive runtime slice identity survives 50 opposite-pane focus moves.
- Modify `src/features/notes/NotesPaneScope.tsx`: accept an already-resolved `NotesPaneRuntimeSlice`.
- Modify `src/features/notes/NotesPaneScope.test.tsx`: update the pane-slice provider contract.
- Modify `src/features/notes/NotesDetailSplitHost.tsx`: add a memoized pane boundary and keep its toolbar element stable.
- Create `src/features/notes/NotesDetailSplitHost.test.tsx`: prove both inactive outline subtrees commit zero times across 50 opposite-pane updates.
- Temporarily modify `src-tauri/src/notes/performance.rs`: seed the isolated desktop benchmark Vault through the existing native Notes connection; remove this change before final verification.
- Temporarily create `src-tauri/tauri.split-benchmark.conf.json`: isolate the benchmark product, bundle identifier, local storage, app data, and Vite port; remove it before final verification.
- Create `docs/superpowers/reports/2026-07-24-notes-split-view-interaction-performance.md`: record reproducible before/after evidence and final gates.

---

### Task 1: Capture the Fresh Tauri Baseline

**Files:**
- Temporarily modify: `src-tauri/src/notes/performance.rs:337-430`
- Temporarily create: `src-tauri/tauri.split-benchmark.conf.json`
- Do not commit the temporary fixture helper.

**Interfaces:**
- Consumes: existing `connect_notes_db`, `node_id`, `params`, and `FIXED_TIMESTAMP`.
- Produces: one isolated Vault containing exactly 5,000 active text nodes and 50 visible roots, plus baseline p50/p95 observations.

- [ ] **Step 1: Add the temporary native fixture seed**

Append this ignored test beside the existing performance fixture tests:

```rust
#[test]
#[ignore = "manual split-view desktop benchmark fixture"]
fn seed_split_view_interaction_benchmark_vault() {
    let vault_path = std::env::var("YONALIST_SPLIT_BENCH_VAULT")
        .expect("YONALIST_SPLIT_BENCH_VAULT must name the isolated Vault");
    let mut connection =
        connect_notes_db(&vault_path).expect("initialize benchmark Vault");
    connection
        .execute("DELETE FROM notes_nodes", [])
        .expect("remove existing benchmark nodes");
    let transaction = connection
        .transaction()
        .expect("start benchmark fixture transaction");
    {
        let mut insert = transaction
            .prepare(
                "INSERT INTO notes_nodes \
                 (id, parent_id, sort_key, title, note, is_collapsed, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, '', ?5, ?6, ?6)",
            )
            .expect("prepare benchmark node insert");
        for index in 0..5_000 {
            let is_root = index < 50;
            let parent_id = (!is_root).then(|| node_id((index - 50) % 49));
            let sibling_index = if is_root {
                index
            } else {
                (index - 50) / 49
            };
            insert
                .execute(params![
                    node_id(index),
                    parent_id,
                    i64::try_from(sibling_index + 1).expect("sort key") * 1_024,
                    if index == 49 {
                        "Benchmark leaf".to_string()
                    } else {
                        format!("Benchmark node {index:04}")
                    },
                    is_root && index < 49,
                    FIXED_TIMESTAMP
                ])
                .expect("insert benchmark node");
        }
    }
    transaction
        .commit()
        .expect("commit benchmark fixture");

    let loaded = load_workspace(&connection, NotesWorkspaceScope::Active)
        .expect("load benchmark fixture");
    assert_eq!(loaded.nodes.len(), 5_000);
    assert_eq!(
        loaded.nodes.iter().filter(|node| node.parent_id.is_none()).count(),
        50
    );
}
```

- [ ] **Step 2: Create the isolated Tauri configuration**

Create `src-tauri/tauri.split-benchmark.conf.json`:

```json
{
  "productName": "Yonalist Split Benchmark",
  "identifier": "com.doortts.yonalist.split-benchmark",
  "build": {
    "beforeDevCommand": "npm run dev -- --port 1437 --strictPort",
    "devUrl": "http://127.0.0.1:1437"
  }
}
```

This keeps the benchmark process, browser origin/local storage, native app
data, and frontend port separate from the user's ordinary Yonalist process.

- [ ] **Step 3: Create and seed an isolated Vault**

Run:

```bash
bench_root="$(mktemp -d /tmp/yonalist-split-bench.XXXXXX)"
bench_vault="$bench_root/vault"
mkdir -p "$bench_vault"
YONALIST_SPLIT_BENCH_VAULT="$bench_vault" \
  cargo test --manifest-path src-tauri/Cargo.toml \
  notes::performance::seed_split_view_interaction_benchmark_vault \
  -- --ignored --exact
```

Expected: one ignored test runs and passes; `$bench_vault/.yonalist/notes.sqlite` exists. Keep `bench_root` and `bench_vault` as task-specific variables; do not alter `HOME`.

- [ ] **Step 4: Start a fresh baseline Tauri process**

Run:

```bash
npm run tauri:dev -- --config src-tauri/tauri.split-benchmark.conf.json
```

Expected: the worktree's current `main`-based frontend and Tauri binary rebuild and a new Yonalist window appears. In Settings, set the Vault folder to the printed value of `bench_vault`, save, open Notes, and open split view. Confirm 50 visible root rows.

- [ ] **Step 5: Install renderer-clock measurement listeners in Web Inspector**

Open Web Inspector for the benchmark window and run:

```js
window.__splitViewBench = {
  pendingCursor: null,
  cursor: [],
  enter: []
};

window.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  const field = event.target.closest(".notes-node-title");
  const row = field?.closest("[data-outline-id]");
  const pane = field?.closest("[data-notes-pane-id]");
  if (!row || !pane) return;
  window.__splitViewBench.pendingCursor = {
    startedAt: performance.now(),
    fromId: row.dataset.outlineId,
    paneId: pane.dataset.notesPaneId
  };
}, true);

window.addEventListener("focusin", (event) => {
  const pending = window.__splitViewBench.pendingCursor;
  const field = event.target.closest?.(".notes-node-title");
  const row = field?.closest("[data-outline-id]");
  const pane = field?.closest("[data-notes-pane-id]");
  if (!pending || !row || !pane || row.dataset.outlineId === pending.fromId) {
    return;
  }
  if (pane.dataset.notesPaneId === pending.paneId) {
    window.__splitViewBench.cursor.push(performance.now() - pending.startedAt);
  }
  window.__splitViewBench.pendingCursor = null;
}, true);

const originalLog = console.log.bind(console);
console.log = (...args) => {
  const line = String(args[0] ?? "");
  if (line.startsWith("notes split-latency ")) {
    const number = (label) =>
      Number(line.match(new RegExp(`${label}=([0-9.]+)ms`))?.[1]);
    window.__splitViewBench.enter.push({
      total: number("total"),
      ipcToSettled: number("ipc-done->settled"),
      settledToCaret: number("settled->caret")
    });
  }
  originalLog(...args);
};

window.__summarizeSplitViewBench = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const quantile = (ratio) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
  return { count: sorted.length, p50: quantile(0.5), p95: quantile(0.95) };
};
```

Expected: `window.__splitViewBench.cursor` and `.enter` are empty arrays and no console error appears.

- [ ] **Step 6: Measure both pane directions**

For primary and secondary separately:

1. Focus a title field in that pane.
2. Run 10 ArrowUp/ArrowDown warm-ups; clear `window.__splitViewBench.cursor`.
3. Run 50 alternating ArrowUp/ArrowDown key pairs.
4. Evaluate `window.__summarizeSplitViewBench(window.__splitViewBench.cursor)`.
5. For clean split, dirty split, and dirty first-child, run 10 warm-ups, clear `.enter`, then run 50 measured Enter interactions. Undo after each measured structural insertion so the fixture returns to 50 visible rows; dirty split requires the existing two Undo steps.
6. Evaluate:

```js
({
  endToEnd: window.__summarizeSplitViewBench(
    window.__splitViewBench.enter.map((sample) => sample.total)
  ),
  postIpc: window.__summarizeSplitViewBench(
    window.__splitViewBench.enter.map(
      (sample) => sample.ipcToSettled + sample.settledToCaret
    )
  )
})
```

Expected: every measured result has `count: 50`. Record all p50/p95 values as the baseline even when they fail the final gates.

- [ ] **Step 7: Stop the baseline process and preserve only evidence**

Quit the benchmark Tauri process and its Vite child. Keep the isolated Vault for the after measurement. Leave the temporary Rust seed test uncommitted and verify no other file changed:

```bash
git status --short
```

Expected: only `src-tauri/src/notes/performance.rs` and
`src-tauri/tauri.split-benchmark.conf.json` are uncommitted.

---

### Task 2: Preserve the Origin Pane's Enter Publication

**Files:**
- Modify: `src/features/notes/notesWorkspaceCoordinator.test.ts:165-790`
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts:733-847`

**Interfaces:**
- Consumes: existing `NotesProjectionPublication.keyboardInsertionDisposition`.
- Produces: the current `Map<SessionState, NotesProjectionPublication>` contract with disposition-bearing candidates preferred over later generic candidates.

- [ ] **Step 1: Write the two-pane failing coordinator test**

Add this table-driven regression near the keyboard insertion coordinator tests:

```ts
it.each(["primary", "secondary"] as const)(
  "retains the %s origin publication when one session owns two panes",
  async (originPaneId) => {
    const store = repository();
    const registry = createNotesWorkspaceCoordinatorRegistry();
    const pool = createNotesExpansionSnapshotPool();
    const events = vi.fn();
    const session = registry.openSession(writableOptions(pool, {
      repository: store,
      vaultRoot: `/two-pane-${originPaneId}-insertion`,
      onEvent: events
    }));
    await session.activation;
    events.mockClear();

    const basePane = {
      scope: { kind: "active" } as const,
      zoomedNodeId: null,
      showCompleted: true,
      collapsedNodeIds: new Set<string>(),
      locallyExpandedNodeIds: new Set<string>(),
      interactionEpoch: 1,
      visibleSignature: JSON.stringify([["root", null, 0, false]]),
      geometryGeneration: 0,
      activeDrag: false
    };
    session.publishOutlinePaneState({ ...basePane, paneId: "primary" });
    session.publishOutlinePaneState({ ...basePane, paneId: "secondary" });

    const preparation = session.prepareKeyboardInsertion({
      ownerPaneId: originPaneId,
      interactionEpochAtDispatch: 1,
      intent: {
        token: 51,
        sourceId: "root",
        expectedNodeId: "split",
        postcondition: {
          kind: "split",
          expectedSourceTitle: "Root",
          expectedInsertedTitle: ""
        }
      }
    })!;

    await session.enqueueStructural(
      () => ({
        kind: "authoritative" as const,
        workspace: workspace([
          node({ id: "root", title: "Root", sortKey: 1024 }),
          node({ id: "split", title: "", sortKey: 2048 })
        ]),
        uiUpdate: {
          selectedId: "split",
          editingNoteId: "split",
          pendingFocusId: "split",
          pendingFocusField: "title" as const
        },
        historyStatus: projectedHistoryState(
          preparation.historyContext.entryId
        ),
        committedHistoryEntryIds: [preparation.historyContext.entryId]
      }),
      { keyboardInsertion: preparation }
    );

    const settled = events.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === "settled");
    expect(
      settled?.result.projectionPublication?.keyboardInsertionDisposition
    ).toMatchObject({
      kind: "exact",
      pending: { ownerPaneId: originPaneId },
      settlement: { ownerPaneId: originPaneId, focusEligible: true }
    });
    session.close();
  }
);
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npm test -- src/features/notes/notesWorkspaceCoordinator.test.ts \
  -t "retains the .* origin publication when one session owns two panes"
```

Expected: the primary case fails because its disposition is `undefined`; the secondary case passes. This directional failure proves the overwrite bug.

- [ ] **Step 3: Implement the minimal publication preference**

Replace the unconditional `publications.set(session, publication)` with:

```ts
const currentPublication = publications.get(session);
if (
  keyboardInsertionDisposition ||
  !currentPublication?.keyboardInsertionDisposition
) {
  publications.set(session, publication);
}
```

This preserves the existing last-pane result for generic publications, lets a later origin candidate replace a generic one, and prevents a later generic candidate from replacing the origin candidate.

- [ ] **Step 4: Run the coordinator and motion tests**

Run:

```bash
npm test -- \
  src/features/notes/notesWorkspaceCoordinator.test.ts \
  src/features/notes/useOutlineLayoutMotion.test.tsx
```

Expected: both files pass; the existing exact/mixed tests still report zero rectangle reads and zero animations.

- [ ] **Step 5: Commit the publication fix**

Run:

```bash
git add \
  src/features/notes/notesWorkspaceCoordinator.ts \
  src/features/notes/notesWorkspaceCoordinator.test.ts
git commit -m "fix(notes): preserve split enter publication"
```

Expected: the temporary Rust benchmark helper remains unstaged.

---

### Task 3: Stabilize Lease Methods and Inactive Pane Slices

**Files:**
- Modify: `src/features/notes/useNotesEditingLease.test.tsx:1-100`
- Modify: `src/features/notes/useNotesEditingLease.ts:29-118`
- Modify: `src/features/notes/notesWorkspaceContextSplit.test.tsx:180-300`
- Modify: `src/features/notes/useNotesWorkspacePaneRegistry.ts:55-424`

**Interfaces:**
- Consumes: `NotesEditingLeaseController` and existing `NotesStateSlice`/`NotesDraftsSlice` fields.
- Produces: stable `claim`, `release`, `canEdit`, `setCompositionActive`, and `structuralCommandsAllowed` methods; a secondary `NotesPaneRuntimeSlice` that changes only for shared data or secondary-local state.

- [ ] **Step 1: Write the lease identity RED test**

Add:

```ts
it("keeps controller methods stable while lease and composition values change", async () => {
  const flush = vi.fn().mockResolvedValue(true);
  const { result } = renderHook(() => useNotesEditingLease());
  const methodsBefore = {
    claim: result.current.claim,
    release: result.current.release,
    canEdit: result.current.canEdit,
    setCompositionActive: result.current.setCompositionActive,
    structuralCommandsAllowed: result.current.structuralCommandsAllowed
  };

  await act(async () => {
    await result.current.claim(
      { paneId: "primary", nodeId: "a", field: "title" },
      flush
    );
    result.current.setCompositionActive("secondary", true);
  });

  expect({
    claim: result.current.claim,
    release: result.current.release,
    canEdit: result.current.canEdit,
    setCompositionActive: result.current.setCompositionActive,
    structuralCommandsAllowed: result.current.structuralCommandsAllowed
  }).toEqual(methodsBefore);
});
```

- [ ] **Step 2: Write the pane slice identity RED test**

Add to `notesWorkspaceContextSplit.test.tsx`:

```ts
it("keeps the inactive pane slice stable across 50 opposite-pane focus moves", async () => {
  const store = repository({
    loadWorkspace: vi.fn().mockResolvedValue(
      workspace([
        node({ id: "root", sortKey: 1024 }),
        node({ id: "other", sortKey: 2048 })
      ])
    )
  });
  const { result } = renderHook(() =>
    useNotesWorkspace({ vaultRoot: "/pane-identity", repository: store })
  );
  await waitFor(() => expect(result.current.status).toBe("ready"));

  const secondaryBefore =
    result.current.paneRegistrySlice.panes.secondary;
  for (let index = 0; index < 50; index += 1) {
    await act(async () => {
      await result.current.paneRegistrySlice.panes.primary.actionsSlice.actions
        .focusNode(index % 2 === 0 ? "other" : "root");
    });
  }
  expect(result.current.paneRegistrySlice.panes.secondary).toBe(
    secondaryBefore
  );

  const primaryBefore = result.current.paneRegistrySlice.panes.primary;
  for (let index = 0; index < 50; index += 1) {
    await act(async () => {
      await result.current.paneRegistrySlice.panes.secondary.actionsSlice.actions
        .focusNode(index % 2 === 0 ? "other" : "root");
    });
  }
  expect(result.current.paneRegistrySlice.panes.primary).toBe(primaryBefore);
});
```

- [ ] **Step 3: Run both tests and verify RED**

Run:

```bash
npm test -- \
  src/features/notes/useNotesEditingLease.test.tsx \
  src/features/notes/notesWorkspaceContextSplit.test.tsx
```

Expected: the method identity assertion fails for `canEdit` and `structuralCommandsAllowed`; the secondary pane identity assertion fails after primary focus movement.

- [ ] **Step 4: Make lease predicates stable**

In `useNotesEditingLease.ts`, add:

```ts
const canEdit = useCallback((request: NotesEditingLease): boolean => {
  const current = leaseRef.current;
  return (
    current === null ||
    (current.paneId === request.paneId &&
      current.nodeId === request.nodeId &&
      current.field === request.field)
  );
}, []);

const structuralCommandsAllowed = useCallback(
  (): boolean =>
    !composingRef.current.primary && !composingRef.current.secondary,
  []
);
```

Return those callbacks directly:

```ts
return useMemo(
  () => ({
    lease,
    composing,
    setCompositionActive,
    claim,
    release,
    canEdit,
    structuralCommandsAllowed
  }),
  [
    canEdit,
    claim,
    composing,
    lease,
    release,
    setCompositionActive,
    structuralCommandsAllowed
  ]
);
```

- [ ] **Step 5: Depend on lease methods instead of the controller object**

At the top of `useNotesWorkspacePaneRegistry`, destructure:

```ts
const {
  canEdit,
  claim,
  release,
  setCompositionActive,
  structuralCommandsAllowed
} = editingLease;
```

Use those functions inside `claimEditing`, `setPaneComposition`,
`primaryActions`, and `secondaryActions`, and replace each `editingLease`
dependency with only the functions that callback reads. For example:

```ts
const claimed = await claim(
  { paneId, nodeId, field },
  actionsSlice.actions.flushNodeDraft
);
```

and:

```ts
releaseEditingFocus: (nodeId) => release("secondary", nodeId),
updateNodeDraft: (nodeId, patch, field) => {
  if (!field || canEdit({ paneId: "secondary", nodeId, field })) {
    actionsSlice.actions.updateNodeDraft(nodeId, patch, field);
  }
}
```

- [ ] **Step 6: Assemble the secondary workspace from exact fields**

Replace the broad spread/dependency with:

```ts
const secondaryPane = panes.secondary;
const secondaryState = useMemo<NormalizedNotesWorkspace>(
  () => ({
    nodesById: state.nodesById,
    childIdsByParent: state.childIdsByParent,
    rootIds: state.rootIds,
    attachmentsByNodeId: state.attachmentsByNodeId,
    selectedId: secondaryPane.selectedId,
    zoomRootId: secondaryPane.zoomRootId,
    editingNoteId: secondaryPane.editingNoteId,
    pendingFocusId: secondaryPane.pendingFocusId,
    pendingFocusField: secondaryPane.pendingFocusField,
    status: state.status,
    error: state.error
  }),
  [
    secondaryPane.editingNoteId,
    secondaryPane.pendingFocusField,
    secondaryPane.pendingFocusId,
    secondaryPane.selectedId,
    secondaryPane.zoomRootId,
    state.attachmentsByNodeId,
    state.childIdsByParent,
    state.error,
    state.nodesById,
    state.rootIds,
    state.status
  ]
);
```

Build `secondaryStateSlice` and `secondaryDraftsSlice` from their exact fields:

```ts
const secondaryStateSlice = useMemo<NotesStateSlice>(
  () => ({
    state: secondaryState,
    deletingNotesData: stateSlice.deletingNotesData,
    libraryView: stateSlice.libraryView,
    activeTagFilters: stateSlice.activeTagFilters,
    tagSummaries: stateSlice.tagSummaries,
    locallyExpandedNodeIds: secondaryPane.locallyExpandedNodeIds,
    status: stateSlice.status,
    loading: stateSlice.loading,
    error: stateSlice.error,
    canUndo: stateSlice.canUndo,
    canRedo: stateSlice.canRedo,
    authorityRecovery: stateSlice.authorityRecovery,
    projectionPublication: stateSlice.projectionPublication,
    retryAuthorityRecovery: stateSlice.retryAuthorityRecovery,
    pendingPrimarySelection: secondaryPane.pendingPrimarySelection
  }),
  [
    secondaryPane.locallyExpandedNodeIds,
    secondaryPane.pendingPrimarySelection,
    secondaryState,
    stateSlice.activeTagFilters,
    stateSlice.authorityRecovery,
    stateSlice.canRedo,
    stateSlice.canUndo,
    stateSlice.deletingNotesData,
    stateSlice.error,
    stateSlice.libraryView,
    stateSlice.loading,
    stateSlice.projectionPublication,
    stateSlice.retryAuthorityRecovery,
    stateSlice.status,
    stateSlice.tagSummaries
  ]
);

const secondaryDraftsSlice = useMemo<NotesDraftsSlice>(
  () => ({
    draftsByNodeId: draftsSlice.draftsByNodeId,
    writeError: draftsSlice.writeError,
    attachmentUploadErrorsByNodeId:
      draftsSlice.attachmentUploadErrorsByNodeId,
    attachmentUploadRetryAttemptIdsByNodeId:
      draftsSlice.attachmentUploadRetryAttemptIdsByNodeId,
    selection: secondaryPane.selection,
    selectionRevision: secondaryPane.selectionRevision
  }),
  [
    draftsSlice.attachmentUploadErrorsByNodeId,
    draftsSlice.attachmentUploadRetryAttemptIdsByNodeId,
    draftsSlice.draftsByNodeId,
    draftsSlice.writeError,
    secondaryPane.selection,
    secondaryPane.selectionRevision
  ]
);
```

- [ ] **Step 7: Run the owning tests and verify GREEN**

Run:

```bash
npm test -- \
  src/features/notes/useNotesEditingLease.test.tsx \
  src/features/notes/notesWorkspaceContextSplit.test.tsx \
  src/features/notes/useNotesWorkspace.navigation.test.tsx
```

Expected: all three files pass; both pane slice identities survive 50 opposite-pane focus moves.

- [ ] **Step 8: Commit the identity fix**

Run:

```bash
git add \
  src/features/notes/useNotesEditingLease.ts \
  src/features/notes/useNotesEditingLease.test.tsx \
  src/features/notes/useNotesWorkspacePaneRegistry.ts \
  src/features/notes/notesWorkspaceContextSplit.test.tsx
git commit -m "perf(notes): stabilize inactive pane slices"
```

Expected: the temporary Rust benchmark helper remains unstaged.

---

### Task 4: Stop Aggregate Registry Updates at the Pane Boundary

**Files:**
- Modify: `src/features/notes/NotesPaneScope.tsx:1-36`
- Modify: `src/features/notes/NotesPaneScope.test.tsx:1-75`
- Modify: `src/features/notes/NotesDetailSplitHost.tsx:1-245`
- Create: `src/features/notes/NotesDetailSplitHost.test.tsx`

**Interfaces:**
- Consumes: `NotesPaneRuntimeSlice`.
- Produces: `NotesPaneScope({ pane, children })` and a memoized split-pane subtree whose only volatile prop is its own pane slice.

- [ ] **Step 1: Update the scope contract test first**

Change the existing scope render to:

```tsx
render(
  <NotesPaneScope pane={secondary}>
    <Probe />
  </NotesPaneScope>
);
```

Remove the unused `NotesPaneRegistryContext` test provider and import. Do not edit production yet.

- [ ] **Step 2: Add the split host render-count RED test**

Create `NotesDetailSplitHost.test.tsx`:

```tsx
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VaultRootContext } from "../../VaultRootContext";
import {
  NotesActionsContext,
  NotesDraftsContext,
  NotesPaneRegistryContext,
  NotesStateContext
} from "./NotesWorkspaceContext";
import { NotesDetailSplitHost } from "./NotesDetailSplitHost";
import {
  createInitialNotesPaneSession,
  type NotesPaneId
} from "./notesPaneSession";
import {
  defaultNotesSplitLayout,
  saveNotesSplitLayout
} from "./notesSplitLayoutStore";
import type {
  NotesPaneRegistrySlice,
  NotesPaneRuntimeSlice,
  NotesWorkspaceActions
} from "./notesWorkspaceTypes";

const outlineRenders = vi.hoisted(() => ({
  primary: 0,
  secondary: 0
}));

vi.mock("./NotesOutlinePane", async () => {
  const { useNotesPaneId } = await import("./NotesPaneScope");
  return {
    NotesOutlinePane: () => {
      outlineRenders[useNotesPaneId()] += 1;
      return null;
    }
  };
});

vi.mock("./NotesSplitDndContext", () => ({
  NotesSplitDndContext: ({ children }: { children: ReactNode }) => children
}));

vi.mock("../../components/ui/Tooltip", () => ({
  IconTooltip: ({ children }: { children: ReactNode }) => children
}));

const actions = {
  flushAllDrafts: vi.fn().mockResolvedValue(true),
  focusNode: vi.fn().mockResolvedValue(undefined),
  acknowledgeFocus: vi.fn().mockResolvedValue(undefined),
  zoomTo: vi.fn().mockResolvedValue(undefined)
} as unknown as NotesWorkspaceActions;

function pane(
  paneId: NotesPaneId,
  selectedId: string | null
): NotesPaneRuntimeSlice {
  return {
    paneId,
    stateSlice: {
      state: {
        nodesById: {},
        childIdsByParent: {},
        rootIds: [],
        attachmentsByNodeId: {},
        selectedId,
        zoomRootId: null,
        editingNoteId: null,
        pendingFocusId: null,
        pendingFocusField: null,
        status: "loading",
        error: null
      },
      deletingNotesData: false,
      libraryView: "all",
      activeTagFilters: [],
      tagSummaries: [],
      locallyExpandedNodeIds: new Set(),
      status: "loading",
      loading: true,
      error: null
    },
    draftsSlice: {
      draftsByNodeId: {},
      writeError: null
    },
    actionsSlice: { actions } as NotesPaneRuntimeSlice["actionsSlice"]
  };
}

const setActivePaneId = vi.fn();
const dispatchPane = vi.fn();

function registry(
  primary: NotesPaneRuntimeSlice,
  secondary: NotesPaneRuntimeSlice
): NotesPaneRegistrySlice {
  return {
    activePaneId: "primary",
    panes: { primary, secondary },
    setActivePaneId,
    getPaneSession: (paneId) => createInitialNotesPaneSession(paneId),
    dispatchPane
  };
}

function Harness({
  primary,
  secondary
}: {
  readonly primary: NotesPaneRuntimeSlice;
  readonly secondary: NotesPaneRuntimeSlice;
}) {
  return (
    <VaultRootContext.Provider value="/render-vault">
      <NotesPaneRegistryContext.Provider value={registry(primary, secondary)}>
        <NotesActionsContext.Provider value={primary.actionsSlice}>
          <NotesStateContext.Provider value={primary.stateSlice}>
            <NotesDraftsContext.Provider value={primary.draftsSlice}>
              <NotesDetailSplitHost />
            </NotesDraftsContext.Provider>
          </NotesStateContext.Provider>
        </NotesActionsContext.Provider>
      </NotesPaneRegistryContext.Provider>
    </VaultRootContext.Provider>
  );
}

describe("NotesDetailSplitHost render boundary", () => {
  beforeEach(() => {
    localStorage.clear();
    outlineRenders.primary = 0;
    outlineRenders.secondary = 0;
    vi.clearAllMocks();
    saveNotesSplitLayout(localStorage, "/render-vault", {
      ...defaultNotesSplitLayout(),
      splitOpen: true
    });
  });

  it("does not commit the inactive pane across 50 opposite-pane updates", () => {
    let primary = pane("primary", "primary-0");
    let secondary = pane("secondary", "secondary-0");
    const rendered = render(
      <Harness primary={primary} secondary={secondary} />
    );

    const primaryBeforeSecondaryMoves = outlineRenders.primary;
    for (let index = 1; index <= 50; index += 1) {
      secondary = pane("secondary", `secondary-${index}`);
      rendered.rerender(
        <Harness primary={primary} secondary={secondary} />
      );
    }
    expect(outlineRenders.primary).toBe(primaryBeforeSecondaryMoves);

    const secondaryBeforePrimaryMoves = outlineRenders.secondary;
    for (let index = 1; index <= 50; index += 1) {
      primary = pane("primary", `primary-${index}`);
      rendered.rerender(
        <Harness primary={primary} secondary={secondary} />
      );
    }
    expect(outlineRenders.secondary).toBe(secondaryBeforePrimaryMoves);
  });
});
```

- [ ] **Step 3: Run the boundary tests and verify RED**

Run:

```bash
npm test -- \
  src/features/notes/NotesPaneScope.test.tsx \
  src/features/notes/NotesDetailSplitHost.test.tsx
```

Expected: the scope contract fails because `pane` is not accepted yet, and the host test shows both outline counters increasing on aggregate registry changes.

- [ ] **Step 4: Make NotesPaneScope provide an explicit pane**

Replace `NotesPaneScope.tsx` with:

```tsx
import {
  createContext,
  type PropsWithChildren,
  useContext
} from "react";
import type { NotesPaneId } from "./notesPaneSession";
import type { NotesPaneRuntimeSlice } from "./notesWorkspaceTypes";
import {
  NotesActionsContext,
  NotesDraftsContext,
  NotesStateContext
} from "./NotesWorkspaceContext";

const NotesPaneIdContext = createContext<NotesPaneId>("primary");

export function useNotesPaneId(): NotesPaneId {
  return useContext(NotesPaneIdContext);
}

export function NotesPaneScope({
  pane,
  children
}: PropsWithChildren<{ readonly pane: NotesPaneRuntimeSlice }>) {
  return (
    <NotesPaneIdContext.Provider value={pane.paneId}>
      <NotesActionsContext.Provider value={pane.actionsSlice}>
        <NotesStateContext.Provider value={pane.stateSlice}>
          <NotesDraftsContext.Provider value={pane.draftsSlice}>
            {children}
          </NotesDraftsContext.Provider>
        </NotesStateContext.Provider>
      </NotesActionsContext.Provider>
    </NotesPaneIdContext.Provider>
  );
}
```

- [ ] **Step 5: Add one memoized host-owned pane boundary**

In `NotesDetailSplitHost.tsx`, import `memo`, `useMemo`, `ReactNode`, and
`NotesPaneRuntimeSlice`, then add:

```tsx
const NotesScopedPane = memo(function NotesScopedPane({
  pane,
  toolbarTrailing
}: {
  readonly pane: NotesPaneRuntimeSlice;
  readonly toolbarTrailing?: ReactNode;
}) {
  return (
    <NotesPaneScope pane={pane}>
      <NotesOutlinePane toolbarTrailing={toolbarTrailing} />
    </NotesPaneScope>
  );
});
```

Keep the live registry behind a ref so `toggleSplit` does not change on every
pane update:

```ts
const registryRef = useRef(registry);
registryRef.current = registry;
```

Inside `toggleSplit`, read `const currentRegistry = registryRef.current`, use it
for secondary release, active pane, and `setActivePaneId`, and change the
dependency list to:

```ts
[actions, layout.splitOpen]
```

Memoize the toolbar element:

```tsx
const splitToggle = useMemo(
  () => (
    <IconTooltip
      label={layout.splitOpen ? "Close split view" : "Open split view"}
      side="bottom"
    >
      <button
        ref={splitButtonRef}
        className="notes-export-trigger notes-split-toggle"
        type="button"
        aria-label="Split view"
        aria-pressed={layout.splitOpen}
        onClick={() => void toggleSplit()}
      >
        <Columns2 size={16} aria-hidden="true" />
      </button>
    </IconTooltip>
  ),
  [layout.splitOpen, toggleSplit]
);
```

Replace the two scope/outline pairs with:

```tsx
<NotesScopedPane
  pane={registry.panes.primary}
  toolbarTrailing={splitToggle}
/>
```

and:

```tsx
<NotesScopedPane pane={registry.panes.secondary} />
```

- [ ] **Step 6: Run boundary and split behavior tests**

Run:

```bash
npm test -- \
  src/features/notes/NotesPaneScope.test.tsx \
  src/features/notes/NotesDetailSplitHost.test.tsx \
  src/features/notes/notesSplitLayoutStore.test.ts
```

Expected: all files pass; each inactive pane counter is unchanged across 50 opposite-pane updates.

- [ ] **Step 7: Commit the pane boundary**

Run:

```bash
git add \
  src/features/notes/NotesPaneScope.tsx \
  src/features/notes/NotesPaneScope.test.tsx \
  src/features/notes/NotesDetailSplitHost.tsx \
  src/features/notes/NotesDetailSplitHost.test.tsx
git commit -m "perf(notes): isolate split pane render boundaries"
```

Expected: the temporary Rust benchmark helper remains unstaged.

---

### Task 5: Run Focused Regression and Deterministic Performance Evidence

**Files:**
- No production edits expected.

**Interfaces:**
- Consumes: the three implementation commits.
- Produces: focused evidence for publication ownership, pane identity, rect reads, animations, row memoization, and split behavior.

- [ ] **Step 1: Run the focused performance contract**

Run:

```bash
npm test -- \
  src/features/notes/notesWorkspaceCoordinator.test.ts \
  src/features/notes/notesWorkspaceContextSplit.test.tsx \
  src/features/notes/NotesPaneScope.test.tsx \
  src/features/notes/NotesDetailSplitHost.test.tsx \
  src/features/notes/useNotesEditingLease.test.tsx \
  src/features/notes/useOutlineLayoutMotion.test.tsx \
  src/features/notes/outlineRowMemo.test.tsx \
  src/features/notes/notesSplitLatencyProbe.test.ts
```

Expected: all files pass. Record the exact file/test counts. Confirm the
coordinator test covers both origin directions, the host test covers 50 moves
in both directions, and existing motion assertions report zero reads and zero
animations.

- [ ] **Step 2: Inspect the diff for accidental scope growth**

Run:

```bash
git diff main...HEAD -- \
  src/features/notes \
  docs/superpowers/specs \
  docs/superpowers/plans
git diff --check
```

Expected: no Rust, IPC, SQLite, persistence, history, Enter rule, or general
store change is present; whitespace check passes.

---

### Task 6: Capture the Fresh Tauri After Benchmark

**Files:**
- Temporarily modify: `src-tauri/src/notes/performance.rs`
- Remove the temporary modification before Task 7.

**Interfaces:**
- Consumes: the same isolated Vault, seed helper, measurement listeners, key sequence, and renderer clock used in Task 1.
- Produces: directly comparable after p50/p95 values.

- [ ] **Step 1: Reset the fixture with the same seed**

Ensure no benchmark app process has the database open, then run:

```bash
YONALIST_SPLIT_BENCH_VAULT="$bench_vault" \
  cargo test --manifest-path src-tauri/Cargo.toml \
  notes::performance::seed_split_view_interaction_benchmark_vault \
  -- --ignored --exact
```

Expected: the seed test passes and restores exactly 5,000 active nodes and 50 roots.

- [ ] **Step 2: Start a newly rebuilt fixed process**

Run:

```bash
npm run tauri:dev -- --config src-tauri/tauri.split-benchmark.conf.json
```

Expected: Vite and Tauri rebuild from the fixed branch and a new process starts. Point Settings at the same `bench_vault`, open Notes, and open split view.

- [ ] **Step 3: Repeat the identical measurement protocol**

Install the exact Task 1 Web Inspector listener, then repeat primary and
secondary cursor, clean split, dirty split, and dirty first-child runs with 10
warm-ups and 50 measured samples each. Use the same Undo restoration between
Enter samples.

Expected:

- every summary has `count: 50`;
- every Enter post-IPC p95 is at most 16 ms;
- no focus, command, animation, or rebaseline work remains 650 ms after the final key;
- after values are recorded beside the corresponding baseline values.

- [ ] **Step 4: Remove temporary benchmark code and data**

Quit only the benchmark Tauri/Vite process. Remove the temporary seed test from
`src-tauri/src/notes/performance.rs` and delete
`src-tauri/tauri.split-benchmark.conf.json` with `apply_patch`. Move
`bench_root` to Trash after confirming it equals the
`/tmp/yonalist-split-bench.*` directory created in Task 1.

Run:

```bash
git status --short
```

Expected: `src-tauri/src/notes/performance.rs` is clean and only the permanent
frontend/test changes or the verification report remain.

---

### Task 7: Final Verification and Evidence Report

**Files:**
- Create: `docs/superpowers/reports/2026-07-24-notes-split-view-interaction-performance.md`

**Interfaces:**
- Consumes: baseline/after measurements, focused test results, and final gate output.
- Produces: one reproducible evidence report and a clean frontend-only branch.

- [ ] **Step 1: Run the final frontend gates once**

Run:

```bash
npm test
npm run lint
npm run build
git diff --check
```

Expected: every command exits zero. Do not run Cargo formatting, full Cargo
tests, or Clippy because the temporary Rust helper has been removed and no
native, IPC, persistence, or configuration boundary changed.

- [ ] **Step 2: Write the verification report**

Create the report with these sections and the actual observed values:

```markdown
# Notes Split View Interaction Performance Verification

## Scope

- Baseline commit and fixed commits
- Frontend-only production boundary
- 5,000-node / 50-visible-row isolated Vault

## Deterministic evidence

| Contract | Result |
| --- | --- |
| Primary and secondary origin publication | PASS with owning test count |
| Enter FLIP rectangle reads | 0 |
| Enter animations | 0 |
| Inactive primary commits over 50 secondary moves | 0 |
| Inactive secondary commits over 50 primary moves | 0 |
| Unchanged heavy editor commits | 0 |

## Desktop before/after

| Pane | Scenario | Baseline p50 | Baseline p95 | Fixed p50 | Fixed p95 |
| --- | --- | ---: | ---: | ---: | ---: |

Include rows for cursor keydown-to-focus and for each Enter scenario's
keydown-to-focus and IPC-end-to-focus measurements.

## Fresh runtime proof

- Build/restart evidence
- Isolated Vault path pattern, node count, visible count
- Warm-up and measured sample counts
- Final backlog check

## Final gates

List each exact command and result.

## Residual risk

State whether desktop wall-clock noise or any pre-existing warning remains;
do not call a failed or unavailable proof a pass.
```

- [ ] **Step 3: Review the final diff**

Run:

```bash
git status --short
git diff --stat main...HEAD
git diff --check
git log --oneline --decorate main..HEAD
```

Expected: only the design, plan, report, frontend implementation, and owning
tests are present. No temporary config, fixture code, Vault data, or benchmark
listener is tracked.

- [ ] **Step 4: Commit the report**

Run:

```bash
git add docs/superpowers/reports/2026-07-24-notes-split-view-interaction-performance.md
git commit -m "docs(notes): record split view performance verification"
```

Expected: the branch is clean and contains reproducible before/after evidence.
