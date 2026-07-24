# Notes Split View Interaction Performance Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route settled Enter focus to its owning pane and let that pane commit before React reconciles the inactive pane's structural projection.

**Architecture:** Partition a validated keyboard-insertion navigation update at the existing settlement boundary: primary-owned navigation keeps the current reducer path, while secondary-owned navigation goes to the secondary pane session and is omitted from the primary reducer. In `NotesDetailSplitHost`, pass the active pane's current runtime slice and React-deferred runtime data to the inactive pane, using React's native scheduling instead of a custom frame queue.

**Tech Stack:** React 19 `useDeferredValue`, TypeScript, Vitest, Testing Library, Tauri 2, existing Notes coordinator/pane sessions and split latency probe.

## Global Constraints

- The representative fixture is 5,000 total text nodes with 50 visible rows.
- Each desktop scenario uses 10 warm-ups followed by 50 measured interactions.
- Split Enter must satisfy `p95(focus - IPC end) <= 16 ms`; first-child Enter records keydown-to-focus because the existing split phase probe does not own that command.
- Enter-owned FLIP rectangle reads and animations must both be zero.
- Caret-only movement must commit the inactive pane zero times.
- A secondary-owned insertion must leave primary navigation unchanged and deliver `selectedId`, `editingNoteId`, `pendingFocusId`, and `pendingFocusField` to the secondary pane.
- The inactive pane may retain its prior structural projection for one deferred render, but it must converge automatically to the same final workspace.
- Keep the interaction-epoch guard unchanged.
- Do not change Enter semantics, optimistic state, motion policy for unrelated commands, Rust/IPC/SQLite/filesystem contracts, persistence, history, or Undo/Redo.
- Do not add a general external store, pane selector framework, custom frame scheduler, or permanent benchmark framework.
- Preserve the existing merge-conflicted worktree; all work stays in `/Users/doortts/Documents/yonalist/.worktrees/split-view-interaction-performance`.

---

## File Map

- Modify `src/features/notes/notesWorkspaceSettlementRuntime.ts`: partition a focus-eligible secondary keyboard-insertion navigation patch from the primary reducer result.
- Modify `src/features/notes/notesWorkspaceRuntime.ts`: dispatch the routed secondary navigation before settling the shared workspace.
- Modify `src/features/notes/useNotesWorkspacePaneRegistry.ts`: let a successful secondary DOM focus acknowledge the shared pending insertion record.
- Modify `src/features/notes/notesWorkspaceContextSplit.test.tsx`: prove a real secondary split routes focus to secondary and leaves primary navigation unchanged.
- Modify `src/features/notes/NotesDetailSplitHost.tsx`: use current active-pane slices and React-deferred inactive-pane slices.
- Modify `src/features/notes/NotesDetailSplitHost.test.tsx`: prove the active structural commit precedes the inactive outline and the inactive outline later converges, in both directions.
- Reuse temporarily modified `src-tauri/src/notes/performance.rs`, `src/main.tsx`, and `src-tauri/tauri.split-benchmark.conf.json` for the fixed rerun; remove all three after acceptance.
- Update `docs/superpowers/reports/2026-07-24-notes-split-view-interaction-performance.md` during the existing final verification task.

---

### Task 1: Route Keyboard-Insertion Navigation to the Owner Pane

**Files:**
- Modify: `src/features/notes/notesWorkspaceSettlementRuntime.ts`
- Modify: `src/features/notes/notesWorkspaceRuntime.ts`
- Modify: `src/features/notes/useNotesWorkspacePaneRegistry.ts`
- Test: `src/features/notes/notesWorkspaceContextSplit.test.tsx`

**Interfaces:**
- Consumes: `NotesWorkspaceQueueSettlement`, `NotesWorkspaceUiUpdate`, `NotesPaneSessionsController.dispatchPane`, and the existing exact/mixed `keyboardInsertionDisposition`.
- Produces:

```ts
export interface RoutedKeyboardInsertionNavigation {
  readonly primaryResult: NotesWorkspaceQueueSettlement;
  readonly secondaryNavigation: NotesWorkspaceUiUpdate | null;
}

export function routeKeyboardInsertionNavigation(
  result: NotesWorkspaceQueueSettlement
): RoutedKeyboardInsertionNavigation;
```

- [ ] **Step 1: Write the failing different-projection secondary split test**

Add the required imports to
`src/features/notes/notesWorkspaceContextSplit.test.tsx`:

```ts
import { createOutlineVisibleSignature } from "./notesKeyboardInsertion";
```

Add this test beside the existing pane-independence tests. Use the file's
existing `node`, `workspace`, and `repository` helpers:

```tsx
it("routes a secondary split focus only to the secondary pane", async () => {
  const initial = workspace([
    node({ id: "root", title: "Root", sortKey: 1024 }),
    node({ id: "other", title: "Other", sortKey: 2048 })
  ]);
  const settled = workspace([
    node({ id: "root", title: "Ro", sortKey: 1024 }),
    node({ id: "split", title: "ot", sortKey: 1536 }),
    node({ id: "other", title: "Other", sortKey: 2048 })
  ]);
  const store = repository({
    loadWorkspace: vi.fn().mockResolvedValue(initial),
    splitNode: vi.fn().mockResolvedValue(settled)
  });
  const { result } = renderHook(() =>
    useNotesWorkspace({
      vaultRoot: "/secondary-insertion-routing",
      repository: store
    })
  );
  await waitFor(() => expect(result.current.status).toBe("ready"));
  const panes = () => result.current.paneRegistrySlice.panes;

  await act(async () => panes().primary.actionsSlice.actions.zoomTo("other"));
  result.current.actions.publishOutlinePaneState?.({
    paneId: "primary",
    scope: { kind: "active" },
    zoomedNodeId: "other",
    showCompleted: true,
    collapsedNodeIds: new Set(),
    locallyExpandedNodeIds: new Set(),
    interactionEpoch: 0,
    visibleSignature: createOutlineVisibleSignature([]),
    geometryGeneration: 0,
    activeDrag: false
  });
  result.current.actions.publishOutlinePaneState?.({
    paneId: "secondary",
    scope: { kind: "active" },
    zoomedNodeId: null,
    showCompleted: true,
    collapsedNodeIds: new Set(),
    locallyExpandedNodeIds: new Set(),
    interactionEpoch: 0,
    visibleSignature: createOutlineVisibleSignature([
      {
        id: "root",
        parentId: null,
        depth: 0,
        isCollapsed: false,
        ancestorIds: [],
        ancestorGuideDepths: [],
        visibleDescendantEndId: null
      },
      {
        id: "other",
        parentId: null,
        depth: 0,
        isCollapsed: false,
        ancestorIds: [],
        ancestorGuideDepths: [],
        visibleDescendantEndId: null
      }
    ]),
    geometryGeneration: 0,
    activeDrag: false
  });
  const preparation =
    panes().secondary.actionsSlice.actions.prepareKeyboardInsertion?.({
      ownerPaneId: "secondary",
      interactionEpochAtDispatch: 0,
      intent: {
        token: 41,
        sourceId: "root",
        expectedNodeId: "split",
        postcondition: {
          kind: "split",
          expectedSourceTitle: "Ro",
          expectedInsertedTitle: "ot"
        }
      }
    });
  expect(preparation).not.toBeNull();

  await act(async () => {
    await panes().secondary.actionsSlice.actions.splitNode(
      "root",
      "split",
      "Ro",
      "ot",
      { keyboardInsertion: preparation! }
    );
  });

  expect(panes().primary.stateSlice.state).toMatchObject({
    selectedId: "other",
    pendingFocusId: null
  });
  expect(panes().secondary.stateSlice.state).toMatchObject({
    selectedId: "split",
    editingNoteId: "split",
    pendingFocusId: "split",
    pendingFocusField: "title"
  });
  expect(
    panes().secondary.actionsSlice.actions
      .pendingKeyboardInsertionInteractionEpoch?.("split")
  ).toBe(0);

  await act(async () => {
    await panes().secondary.actionsSlice.actions.acknowledgeFocus("split");
  });
  expect(panes().secondary.stateSlice.state.pendingFocusId).toBeNull();
  expect(
    panes().secondary.actionsSlice.actions
      .pendingKeyboardInsertionInteractionEpoch?.("split")
  ).toBeUndefined();
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npm test -- src/features/notes/notesWorkspaceContextSplit.test.tsx
```

Expected: the new assertion fails because primary has `pendingFocusId:
"split"` and secondary has no pending focus. Record the exact failure before
editing production files.

- [ ] **Step 3: Add the smallest settlement router**

In `src/features/notes/notesWorkspaceSettlementRuntime.ts`, import
`NotesWorkspaceUiUpdate` from `notesWorkspaceCoordinator` and add:

```ts
export interface RoutedKeyboardInsertionNavigation {
  readonly primaryResult: NotesWorkspaceQueueSettlement;
  readonly secondaryNavigation: NotesWorkspaceUiUpdate | null;
}

export function routeKeyboardInsertionNavigation(
  result: NotesWorkspaceQueueSettlement
): RoutedKeyboardInsertionNavigation {
  if (result.kind === "skipped") {
    return { primaryResult: result, secondaryNavigation: null };
  }
  const disposition =
    result.projectionPublication?.keyboardInsertionDisposition;
  if (
    (disposition?.kind !== "exact" && disposition?.kind !== "mixed") ||
    !disposition.settlement.focusEligible ||
    disposition.settlement.ownerPaneId !== "secondary" ||
    !result.uiUpdate
  ) {
    return { primaryResult: result, secondaryNavigation: null };
  }
  const {
    selectedId,
    editingNoteId,
    pendingFocusId,
    pendingFocusField,
    ...primaryUiUpdate
  } = result.uiUpdate;
  const secondaryNavigation = {
    selectedId,
    editingNoteId,
    pendingFocusId,
    pendingFocusField
  };
  return {
    primaryResult: {
      ...result,
      uiUpdate:
        Object.keys(primaryUiUpdate).length === 0
          ? undefined
          : primaryUiUpdate
    },
    secondaryNavigation
  };
}
```

Do not modify the interaction-epoch helpers.

- [ ] **Step 4: Apply the routed result at the existing event boundary**

In the settled/synchronized branch of
`src/features/notes/notesWorkspaceRuntime.ts`, immediately after the
`pending` and `authorityRecovery` early returns, route the result once:

```ts
const routed =
  settlementRuntime.routeKeyboardInsertionNavigation(event.result);
if (routed.secondaryNavigation) {
  paneSessions.dispatchPane("secondary", {
    type: "setNavigation",
    patch: routed.secondaryNavigation
  });
}
const settledResult = routed.primaryResult;
```

Use `settledResult` instead of `event.result` for history status, tag
invalidation, pending insertion focus, local expansion, publication, and the
`settleQueueWork` reducer action. Keep `event.sourceScope` and
`event.hasPendingWork` unchanged.

In the secondary `acknowledgeFocus` implementation in
`src/features/notes/useNotesWorkspacePaneRegistry.ts`, after the editing claim
and pending-selection guard succeed, retire the shared focus record before the
secondary pane dispatches:

```ts
await actionsSlice.actions.acknowledgeFocus(nodeId, requestId);
```

- [ ] **Step 5: Run GREEN and focused ownership regressions**

Run:

```bash
npm test -- \
  src/features/notes/notesWorkspaceContextSplit.test.tsx \
  src/features/notes/notesWorkspaceCoordinator.test.ts \
  src/features/notes/useNotesEditingLease.test.tsx
```

Expected: all pass; the new test proves primary navigation is unchanged,
secondary pending focus is `"split"`, and acknowledgement clears both the
secondary request and shared insertion epoch.

- [ ] **Step 6: Commit**

```bash
git add \
  src/features/notes/notesWorkspaceSettlementRuntime.ts \
  src/features/notes/notesWorkspaceRuntime.ts \
  src/features/notes/useNotesWorkspacePaneRegistry.ts \
  src/features/notes/notesWorkspaceContextSplit.test.tsx
git commit -m "fix(notes): route split focus to owner pane"
```

---

### Task 2: Defer Only the Inactive Pane's Structural Render

**Files:**
- Modify: `src/features/notes/NotesDetailSplitHost.tsx`
- Test: `src/features/notes/NotesDetailSplitHost.test.tsx`

**Interfaces:**
- Consumes: `registry.activePaneId` and the current primary/secondary
  `NotesPaneRuntimeSlice` values.
- Produces: the active pane receives the current slice synchronously; the
  inactive pane receives `useDeferredValue(currentSlice)` and later converges.

- [ ] **Step 1: Write the failing active-first render test**

In `src/features/notes/NotesDetailSplitHost.test.tsx`, import `waitFor` from
Testing Library and `flushSync` from React DOM. Make `registry` and `Harness`
accept an `activePaneId: NotesPaneId` instead of hard-coding `"primary"`.

Add:

```tsx
it.each(["primary", "secondary"] as const)(
  "commits the active %s structural slice before the inactive outline",
  async (activePaneId) => {
    let primary = pane("primary", "primary-before");
    let secondary = pane("secondary", "secondary-before");
    const rendered = render(
      <Harness
        activePaneId={activePaneId}
        primary={primary}
        secondary={secondary}
      />
    );
    const inactivePaneId =
      activePaneId === "primary" ? "secondary" : "primary";
    const before = { ...outlineRenders };

    primary = pane("primary", "primary-after");
    secondary = pane("secondary", "secondary-after");
    flushSync(() => {
      rendered.rerender(
        <Harness
          activePaneId={activePaneId}
          primary={primary}
          secondary={secondary}
        />
      );
    });

    expect(outlineRenders[activePaneId]).toBe(before[activePaneId] + 1);
    expect(outlineRenders[inactivePaneId]).toBe(before[inactivePaneId]);
    await waitFor(() =>
      expect(outlineRenders[inactivePaneId]).toBeGreaterThan(
        before[inactivePaneId]
      )
    );
  }
);
```

Update the existing 50-move test's `Harness` calls with
`activePaneId="primary"` for secondary moves and
`activePaneId="secondary"` for primary moves.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npm test -- src/features/notes/NotesDetailSplitHost.test.tsx
```

Expected: the new immediate inactive-render assertion fails because both pane
slices currently render in the same synchronous commit.

- [ ] **Step 3: Use React's native deferred value**

Import `useDeferredValue` from React in
`src/features/notes/NotesDetailSplitHost.tsx`. Immediately after reading the
registry, add:

```ts
const deferredPrimaryPane = useDeferredValue(registry.panes.primary);
const deferredSecondaryPane = useDeferredValue(registry.panes.secondary);
const primaryPane =
  registry.activePaneId === "primary"
    ? registry.panes.primary
    : deferredPrimaryPane;
const secondaryPane =
  registry.activePaneId === "secondary"
    ? registry.panes.secondary
    : deferredSecondaryPane;
```

Pass `primaryPane` and `secondaryPane` to the two existing
`NotesScopedPane` instances. Do not add local state, timers, animation frames,
or transition wrappers.

- [ ] **Step 4: Run GREEN and render/motion regressions**

Run:

```bash
npm test -- \
  src/features/notes/NotesDetailSplitHost.test.tsx \
  src/features/notes/NotesPaneScope.test.tsx \
  src/features/notes/notesWorkspaceContextSplit.test.tsx \
  src/features/notes/useOutlineLayoutMotion.test.tsx \
  src/features/notes/outlineRowMemo.test.tsx
```

Expected: all pass; both active directions commit before the inactive outline,
the inactive outline later converges, caret-only inactive render counts stay
zero, and Enter motion remains zero-read/zero-animation.

- [ ] **Step 5: Commit**

```bash
git add \
  src/features/notes/NotesDetailSplitHost.tsx \
  src/features/notes/NotesDetailSplitHost.test.tsx
git commit -m "perf(notes): prioritize active split pane"
```

---

### Task 3: Freeze Focused Frontend Evidence

**Files:**
- No production edits expected.

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: focused proof before the desktop rebuild.

- [ ] **Step 1: Run the focused contract**

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
git diff --check
```

Expected: every file passes. Record exact file/test counts and confirm no
Rust, IPC, SQLite, persistence, history, Enter-rule, general-store, custom
scheduler, or permanent benchmark change.

---

### Task 4: Repeat the Exact Fixed Desktop Benchmark

**Files:**
- Temporarily retain: `src-tauri/src/notes/performance.rs`
- Temporarily retain: `src/main.tsx`
- Temporarily retain: `src-tauri/tauri.split-benchmark.conf.json`
- Remove all three after the benchmark passes.

**Interfaces:**
- Consumes:
  - `bench_root=/tmp/yonalist-split-bench.tzmf7H`
  - `bench_vault=/tmp/yonalist-split-bench.tzmf7H/vault`
  - `bench_app_data=/Users/doortts/Library/Application Support/com.doortts.yonalist.split-benchmark`
  - `bench_notes_root=/Users/doortts/Library/Application Support/com.doortts.yonalist.split-benchmark/notes`
- Produces: accepted after values for all eight scenarios.

- [ ] **Step 1: Reseed and rebuild**

With no benchmark process holding the database:

```bash
YONALIST_SPLIT_BENCH_VAULT="$bench_vault" \
YONALIST_SPLIT_BENCH_NOTES_ROOT="$bench_notes_root" \
  cargo test --manifest-path src-tauri/Cargo.toml \
  notes::performance::seed_split_view_interaction_benchmark_vault \
  -- --ignored --exact
npm run tauri:dev -- --config src-tauri/tauri.split-benchmark.conf.json
```

Expected: seed `1 passed`, fixture `5000|50|49|1`, and one fresh isolated
benchmark process on port 1437.

- [ ] **Step 2: Run all eight identical protocols**

For primary and secondary, run cursor, clean split, dirty split, and clean
first-child with 10 warm-ups followed by 50 measured physical interactions.
Use one physical Command-Z after clean split/first-child and two after dirty
split. Wait 650 ms after each final key sequence before reading the result.

Expected:

- both cursor counts are 50;
- every clean/dirty split end-to-end, split, and post-IPC count is 50;
- both first-child end-to-end counts are 50;
- every split post-IPC p95 is at most 16 ms;
- every scenario restores the exact fixture;
- no late focus, command, animation, or rebaseline work appears after 650 ms.

If any post-IPC p95 remains above 16 ms, preserve the fixture and temporary
artifacts, capture a React profile of the active outline, and stop before the
larger synchronous optimization. Do not add another scheduling layer.

- [ ] **Step 3: Remove temporary artifacts and isolated data after acceptance**

Stop only the benchmark Tauri/Vite process. With `apply_patch`:

- remove the seed helper from `src-tauri/src/notes/performance.rs`;
- remove the benchmark probe from `src/main.tsx`;
- delete `src-tauri/tauri.split-benchmark.conf.json`.

After confirming the exact paths, move these recoverably to Trash:

```text
/tmp/yonalist-split-bench.tzmf7H
/Users/doortts/Library/Application Support/com.doortts.yonalist.split-benchmark
```

Expected `git status --short`: no Rust helper, benchmark probe, config, Vault,
or app-data artifact remains.

---

### Task 5: Final Verification, Evidence Report, and HTML Explanation

**Files:**
- Create or update: `docs/superpowers/reports/2026-07-24-notes-split-view-interaction-performance.md`
- Update:
  `/Users/doortts/.codex/visualizations/2026/07/24/019f9296-5e76-74b0-a74e-c404baae8ed3/2026-07-24-yonalist-split-view-performance-design.html`

**Interfaces:**
- Consumes: accepted desktop before/after evidence and all focused/full gates.
- Produces: final reproducible report, updated rich HTML explanation, and a
  clean frontend-only branch.

- [ ] **Step 1: Run the final frontend gates once**

```bash
npm test
npm run lint
npm run build
git diff --check
```

Expected: all commands exit zero. Record exact test counts and any
pre-existing build warning.

- [ ] **Step 2: Write the verification report**

Include:

- baseline and fixed commit ranges;
- 5,000-node/50-visible-row fixture proof;
- deterministic owner-routing, zero-motion, active-first, inactive-convergence,
  and 50-move inactive-pane results;
- all cursor, clean split, dirty split, clean first-child, and split post-IPC
  p50/p95 before/after values;
- exact Undo and 650 ms quiescence proof;
- final gates and residual desktop wall-clock risk.

Never label a missing count, unavailable phase, or failed threshold as PASS.

- [ ] **Step 3: Review and commit the report**

```bash
git status --short
git diff --stat main...HEAD
git diff --check
git log --oneline --decorate main..HEAD
git add docs/superpowers/reports/2026-07-24-notes-split-view-interaction-performance.md
git commit -m "docs(notes): record split view performance verification"
```

Expected: only design/plan/report, frontend implementation, and owning tests
remain; the branch is clean.

- [ ] **Step 4: Update the rich HTML explanation**

Invoke the `explain-diff-html` skill and update the existing HTML artifact with
the final root causes, minimal code changes, RED/GREEN tests, and desktop
before/after table. Validate the HTML using that skill's required checks.
