# Workflowy-style Progressive Outline Windowing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mount a bounded prefix of each Yonalist outline and progressively
materialize later batches without changing editor behavior or visual design.

**Architecture:** A pure window policy computes batch boundaries and spacer
height. A pane-local React controller watches the tail, requests the next
SQLite viewport when needed, and handles focus-materialization events.
Hierarchy and interaction logic continue to use the complete loaded list while
React maps only the mounted prefix.

**Tech Stack:** React 19, TypeScript 6, Vitest, Testing Library, browser
`IntersectionObserver`/`ResizeObserver`.

## Global Constraints

- Initial mounted rows: 60.
- Progressive batch size: 60.
- Initial estimated row height: 28 pixels.
- Previously mounted rows are not evicted while the page/zoom scope is stable.
- Existing design, layout, typography, colors, keyboard behavior, IME,
  split-pane behavior, and IPC contracts remain unchanged.
- No Rust, SQLite, generated-contract, or native configuration changes.

---

### Task 1: Pure progressive-window policy

**Files:**
- Create: `apps/desktop/src/progressiveOutlineWindow.ts`
- Create: `apps/desktop/src/progressiveOutlineWindow.test.ts`

**Interfaces:**
- Produces: `initialOutlineWindowCount(total: number): number`
- Produces: `advanceOutlineWindow(current: number, total: number): number`
- Produces: `materializeOutlineThrough(current: number, targetIndex: number, total: number): number`
- Produces: `describeOutlineWindow(rendered: number, total: number, estimatedRowHeight: number): ProgressiveOutlineWindow`

- [ ] **Step 1: Write the failing policy tests**

```ts
expect(initialOutlineWindowCount(140)).toBe(60);
expect(advanceOutlineWindow(60, 140)).toBe(120);
expect(materializeOutlineThrough(60, 119, 140)).toBe(120);
expect(describeOutlineWindow(60, 140, 28).spacerHeight).toBe(2_240);
```

- [ ] **Step 2: Run the focused test and verify missing-module failure**

Run: `npm test --prefix apps/desktop -- progressiveOutlineWindow.test.ts`

Expected: FAIL because `progressiveOutlineWindow.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure policy**

Use clamped integer counts. Round the target index plus one to the next
60-row boundary and never return a value below the current rendered count.

- [ ] **Step 4: Run the focused test**

Run: `npm test --prefix apps/desktop -- progressiveOutlineWindow.test.ts`

Expected: PASS.

### Task 2: Pane-local progressive controller

**Files:**
- Create: `apps/desktop/src/useProgressiveOutlineWindow.ts`
- Create: `apps/desktop/src/progressiveOutlineWindowIntegration.test.tsx`
- Modify: `apps/desktop/src/outlineFocus.ts`

**Interfaces:**
- Consumes: Task 1 policy functions.
- Produces: `OUTLINE_MATERIALIZE_EVENT`
- Produces: `useProgressiveOutlineWindow({ nodes, scopeKey, scopeRef, afterCursor, onLoadMore })`
- Returns: `renderedNodes`, `spacerHeight`, `listRef`, `sentinelRef`, and `advance`.

- [ ] **Step 1: Write a failing bounded-render integration test**

Boot `App` with 140 flat rows and assert that 60
`[data-outline-id]` elements and an 80-row spacer are present.

- [ ] **Step 2: Run and verify the current all-row rendering failure**

Run:
`npm test --prefix apps/desktop -- progressiveOutlineWindowIntegration.test.tsx`

Expected: FAIL because all 140 rows mount.

- [ ] **Step 3: Write a failing hidden-focus integration test**

Call `focusOutlineEditor(scope, "row-119", "start")` and assert that row 119
mounts, receives focus, and row 0 remains mounted.

- [ ] **Step 4: Implement the controller and bounded focus retry**

Use a cancelable scope event to materialize a known hidden row, then retry
focus for at most two animation frames. Keep loading-cursor ownership in a ref
so one cursor cannot be requested concurrently.

- [ ] **Step 5: Run the integration tests**

Run:
`npm test --prefix apps/desktop -- progressiveOutlineWindowIntegration.test.tsx`

Expected: PASS.

### Task 3: Connect the outline DOM and progressive loading

**Files:**
- Modify: `apps/desktop/src/NotesOutline.tsx`
- Modify: `apps/desktop/src/notes.css`
- Modify: `apps/desktop/src/progressiveOutlineWindowIntegration.test.tsx`

**Interfaces:**
- Consumes: Task 2 controller.
- Keeps: `bodyNodes` for indexes, keyboard, selection, moves, and drag.
- Uses: `renderedNodes` only for the `OutlineRow` render map.

- [ ] **Step 1: Add a failing controlled-observer test**

Trigger the sentinel observer and assert that mounted rows grow from 60 to 120
while row 0 remains mounted.

- [ ] **Step 2: Run and verify the missing-growth failure**

Run:
`npm test --prefix apps/desktop -- progressiveOutlineWindowIntegration.test.tsx`

Expected: FAIL because the sentinel does not yet advance the render prefix.

- [ ] **Step 3: Wire the list, spacer, sentinel, and existing cursor**

Render an `aria-hidden` spacer after the mounted prefix. Observe the list
height to refine the estimate. After all loaded rows mount, call
`store.loadMore()` once for the current `afterCursor`.

- [ ] **Step 4: Run the focused policy and integration tests**

Run:
`npm test --prefix apps/desktop -- progressiveOutlineWindow.test.ts progressiveOutlineWindowIntegration.test.tsx`

Expected: PASS.

### Task 4: Interaction regression and fresh runtime proof

**Files:**
- Modify only if a regression test fails for the same runtime reason.

**Interfaces:**
- Consumes: completed progressive outline window.
- Produces: no new API.

- [ ] **Step 1: Run focused interaction owners**

Run:
`npm test --prefix apps/desktop -- splitPaneIntegration.test.tsx outlineKeyboard.test.ts outlineFocus.test.ts outlineClipboardIntegration.test.tsx`

Expected: PASS.

- [ ] **Step 2: Run a fresh preview smoke test**

Restart the Vite preview, open the local preview, confirm the mounted row count
is bounded, scroll through multiple batches, repeat Enter and Backspace in the
secondary pane, and verify the caret remains visible.

- [ ] **Step 3: Freeze the diff and run final frontend gates once**

Run:

```text
npm test --prefix apps/desktop
npm run lint:v2
npm run v2:build
npm run test:v2:architecture
git diff --check
```

Expected: all commands pass. Cargo, Rustfmt, and Clippy are skipped because the
slice changes no Rust, IPC, persistence, or native boundary.
