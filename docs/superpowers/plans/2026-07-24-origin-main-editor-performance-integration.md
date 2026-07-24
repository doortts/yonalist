# Origin Main + Bullet Editor Performance Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge `origin/main` into the current local `main` while preserving the split-pane/zoom work and prove that sustained bullet editing does not create render, mount, timer, or draft-queue drain.

**Architecture:** Integrate the remote branch with a merge pull so existing local commit identities remain intact. Resolve overlapping Notes files by retaining the newer remote architecture first, then reapplying the observable split-pane, editing-lease, zoom-shortcut, and `Check` icon contracts. Add a deterministic React regression that measures repeated edit fan-out and pair it with the existing write-queue drain tests; avoid flaky wall-clock CI thresholds. Restore the existing 1,500-line runtime budget by extracting the independently testable image-atom authority and draft-error contracts introduced by the upstream merge, without relaxing any budget.

**Tech Stack:** Git, React 19, TypeScript, Vitest, Testing Library, Tauri 2, Rust.

## Global Constraints

- Preserve all eight local commits currently unique to `main`.
- Do not push or rewrite remote history.
- Do not accept unresolved conflicts or silently drop either branch's behavior.
- Treat “no editor drain” as: unchanged rows do not commit, editors/shells do not remount, repeated edits remain linear, and draft/write timers fully drain.
- Because `origin/main` changes Rust, IPC, persistence, and native configuration, run frontend and Rust final gates.
- Use a freshly built desktop app and sample/isolated data for the manual editor smoke test.
- `origin/main` commit `6838a71` combines two budget-compliant parents into a 1,586-line `notesWorkspaceRuntime.ts`; restore the architecture gate with focused extraction rather than a numeric budget increase.

## Contract

| Field | Required content |
| --- | --- |
| Goal | Local `main` contains `origin/main` plus the split-pane/zoom changes, with stable sustained bullet editing. |
| Acceptance | Clean merge; targeted editor tests pass; 200 repeated edits cause zero sibling commits and zero remounts; write queue has no pending work/timers after flush; frontend and Rust gates pass; fresh desktop editor remains responsive and persists the final value. |
| Non-goals | Push, PR creation, unrelated optimization, redesign of remote notification/index features, or architecture-budget relaxation. |
| Boundaries | React outline rows, draft engine, write queue, Tauri IPC, Rust/SQLite integration, macOS desktop runtime. |
| Manual proof | Open a fresh bundled app with sample/isolated data, edit one nested bullet continuously, wait for autosave, navigate away/back, and confirm the final value without UI stalls or duplicate writes. |

---

### Task 1: Establish the performance baseline and merge remote main

**Files:**
- Inspect: `src/features/notes/outlineRowMemo.test.tsx`
- Inspect: `src/features/notes/notesDraftEngine.test.ts`
- Inspect: `src/services/notesWriteQueue.test.ts`
- Merge overlaps if present: `src/features/notes/NotesDetailSplitHost.tsx`
- Merge overlaps if present: `src/features/notes/NotesOutlinePane.tsx`
- Merge overlaps if present: `src/features/notes/NotesPageHeader.tsx`
- Merge overlaps if present: `src/features/notes/outlineKeyboard.ts`
- Merge overlaps if present: `src/features/notes/notes.css`

**Interfaces:**
- Consumes: local `main` at `71e1587`, `origin/main` at `8ae26b9`.
- Produces: one conflict-free merge result containing both histories.

- [x] **Step 1: Run the focused pre-merge baseline**

Run:

```bash
npx vitest run src/features/notes/outlineRowMemo.test.tsx src/features/notes/notesDraftEngine.test.ts src/services/notesWriteQueue.test.ts
npm run test:architecture
```

Expected: all selected tests pass and the architecture budget exits 0.

- [x] **Step 2: Pull remote main with merge semantics**

Run:

```bash
git pull --no-rebase origin main
```

Expected: a merge commit or explicit conflict list; never a rebase or force update.

- [x] **Step 3: Resolve each conflict against observable contracts**

For every conflicted Notes file:

```bash
git diff --name-only --diff-filter=U
rg -n '^(<<<<<<<|=======|>>>>>>>)' .
```

Expected: remote architecture remains intact while the 1px divider, right-only `PanelRightClose`, primary-editor focus restoration, page-header editing lease, Workflowy zoom shortcuts, and `Check` icon remain present.

- [x] **Step 4: Run the smallest owning tests**

Run:

```bash
npx vitest run src/features/notes/NotesFeature.test.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesWorkspace.test.tsx src/features/notes/outlineKeyboard.test.ts
```

Expected: all selected tests pass.

### Task 1.5: Restore the inherited runtime architecture budget

**Files:**
- Add: `src/features/notes/notesImageAtomAuthority.ts`
- Add: `src/features/notes/notesDraftErrors.ts`
- Modify: `src/features/notes/notesWorkspaceRuntime.ts`
- Modify: `scripts/checkNotesWorkspaceBudgets.mjs`

- [x] **Step 1: Reproduce and trace the upstream-only budget failure**

Expected: `origin/main` and the merged worktree both report 1,586 lines, while local `HEAD` before the pull reports 1,498; commit `6838a71` is the first failing merge.

- [x] **Step 2: Extract pure authority and error contracts without changing behavior**

Expected: `notesWorkspaceRuntime.ts` returns below 1,500 lines, both focused workspace tests and build pass, and the new modules are themselves included in the production budget inventory.

- [x] **Step 3: Re-run the architecture gate**

Expected: `notesWorkspaceRuntime.ts` reports 1,487/1,500 and the complete architecture gate exits 0.

### Task 2: Add a sustained bullet-edit drain regression

**Files:**
- Modify: `src/features/notes/outlineRowMemo.test.tsx`
- Modify only if missing final timer coverage: `src/services/notesWriteQueue.test.ts`

**Interfaces:**
- Consumes: `rowRenderCounts`, `editorMountCounts`, `shellMountCounts`, `titleInput()`, and the 50-node `seededNodes()` fixture.
- Produces: a deterministic repeated-edit regression covering render fan-out and mount retention.

- [x] **Step 1: Add the repeated-edit regression**

Add beside the existing single-keystroke isolation test:

```tsx
it("keeps sustained title editing isolated without remount or render fan-out", async () => {
  const store = repository(seededNodes());
  render(<Harness store={store} />);
  await waitFor(() => expect(captured?.status).toBe("ready"));
  await waitFor(() =>
    expect(document.querySelectorAll("[data-outline-id]")).toHaveLength(50)
  );

  const target = "c-3-2";
  const input = titleInput(target);
  const rendersBefore = new Map(rowRenderCounts);
  const editorMountsBefore = new Map(editorMountCounts);
  const shellMountsBefore = new Map(shellMountCounts);

  for (let index = 0; index < 200; index += 1) {
    fireEvent.change(input, { target: { value: `edit-${index}` } });
  }

  expect(captured?.draftsByNodeId[target]?.title).toBe("edit-199");
  for (const [nodeId, count] of rowRenderCounts) {
    if (nodeId !== target) expect(count).toBe(rendersBefore.get(nodeId));
  }
  expect((rowRenderCounts.get(target) ?? 0) - (rendersBefore.get(target) ?? 0))
    .toBeLessThanOrEqual(200);
  expect(editorMountCounts).toEqual(editorMountsBefore);
  expect(shellMountCounts).toEqual(shellMountsBefore);
});
```

- [x] **Step 2: Run the isolation regression**

Run:

```bash
npx vitest run src/features/notes/outlineRowMemo.test.tsx
```

Expected: the new test passes only when siblings remain isolated and editors do not remount. If it fails, inspect the first changed prop/render boundary before modifying production code.

- [x] **Step 3: Verify queue drain after continuous typing**

Run:

```bash
npx vitest run src/features/notes/notesDraftEngine.test.ts src/services/notesWriteQueue.test.ts
```

Expected: continuous typing flushes at the latency cap, `flush()` leaves no pending keys, and advancing fake timers produces no duplicate writes.

### Task 3: Verify the integrated desktop and all changed boundaries

**Files:**
- Verify: all merged frontend and Rust sources.
- Commit: the merge resolution and performance regression, if any.

**Interfaces:**
- Consumes: conflict-free merged tree and focused performance proof.
- Produces: reproducible final gate output and a clean local `main`.

- [x] **Step 1: Run frontend gates**

Run:

```bash
npm test
npm run lint
npm run build
npm run test:architecture
git diff --check
```

Expected: exit 0 for every command.

Additional diagnostic: `npm run build:analyze` still reports the Notes route
above its historical bundle budget. A clean archive of `origin/main` reports
the same regression (615,488 raw / 210,647 gzip), so this is an inherited
download-size issue rather than a merge-resolution or editor-drain regression.

- [x] **Step 2: Run native gates**

Run:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: formatting and all Rust tests pass.

- [x] **Step 3: Build and smoke-test a fresh desktop app**

Run:

```bash
npm run tauri:build -- --debug --bundles app
```

Expected: a fresh `Yonalist.app` bundle. In sample/isolated Notes data, edit a
nested bullet continuously, wait for autosave, restart, and confirm the exact
last value is present. The focused split-close regression separately confirms
that closing the secondary pane restores the primary editor.

- [x] **Step 4: Review and commit**

Run:

```bash
git diff --check
git status --short
git log --oneline --decorate -5
```

Expected: no conflict markers or accidental files. Commit the performance regression and any merge resolution with a concise conventional message.
