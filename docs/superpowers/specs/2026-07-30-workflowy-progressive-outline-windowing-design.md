# Workflowy-style Progressive Outline Windowing Design

**Date:** 2026-07-30

**Status:** Approved

## Goal

Keep the current Yonalist layout and editor behavior while preventing a
progressively loaded outline from mounting every loaded row at once.

## Observable Contract

- An outline mounts at most 60 rows on first paint.
- Approaching the rendered tail materializes the next 60 rows without
  unmounting rows that the user already traversed.
- The unmounted loaded tail is represented by an invisible height-preserving
  spacer.
- Arrow navigation, repeated Enter, repeated Backspace, focus restoration,
  selection, and cross-pane drag can request a hidden target row and focus it
  after its batch is mounted.
- The active editor, selected range, and drag source are never removed from the
  mounted prefix.
- Reaching the end of the loaded prefix continues through the existing bounded
  SQLite viewport cursor rather than querying the complete workspace.
- The current DOM classes, visual tokens, spacing, typography, colors, and
  control placement do not change.

## Non-goals

- This slice does not replace textarea editing with `contenteditable`.
- It does not implement a fixed-size recycler or unmount rows behind the
  viewport.
- It does not change the SQLite schema, IPC contracts, history model, or
  viewport limit.
- It does not virtualize the page header, selection toolbar, child composer,
  drag overlay, or popups.
- It does not add Vault synchronization, GitHub Notifications, or v1
  compatibility.

## Measured Workflowy Reference

The signed-in Workflowy performance page initially mounted 49 `.project`
elements and represented the remaining document with an explicit spacer.
After scrolling to approximately 7,000 pixels, the mounted set grew to 361
elements and remained at that size after an idle interval. Workflowy therefore
uses progressive materialization: it grows the traversed DOM and does not
immediately recycle the rows behind the user.

Each mounted Workflowy bullet uses its own editable DOM element. The
transferable performance property is not `contenteditable` itself; it is the
stable active editing range plus incremental tail materialization.

## Architecture

### Pure window policy

`progressiveOutlineWindow.ts` owns constants and pure calculations:

```ts
const OUTLINE_WINDOW_INITIAL_COUNT = 60;
const OUTLINE_WINDOW_BATCH_COUNT = 60;
const OUTLINE_WINDOW_ESTIMATED_ROW_HEIGHT = 28;

interface ProgressiveOutlineWindow {
  readonly renderedCount: number;
  readonly remainingCount: number;
  readonly spacerHeight: number;
}
```

The policy rounds focus targets up to a batch boundary and never reduces the
mounted count while the pane scope is unchanged. A page or zoom-scope change
starts a new window.

### React controller

`useProgressiveOutlineWindow.ts` owns pane-local materialization state. It
returns the mounted prefix, the spacer height, list and sentinel refs, and a
manual advance operation.

An `IntersectionObserver` rooted at `.notes-outline-rows` watches the tail
sentinel with forward overscan. Browsers without the observer retain an
explicit scroll listener and the existing Load more button.

The controller observes the rendered list height and keeps a bounded rolling
row-height estimate. Text-only rows begin at the existing 28-pixel minimum.
The estimate affects only the invisible tail spacer; rendered rows retain
their natural height.

### Focus materialization

`outlineFocus.ts` defines one cancelable custom event owned by the outline
scope. If a requested editor is not mounted, the focus helper dispatches the
event and retries on the next animation frame. The pane controller handles the
event only when the ID belongs to its logical visible list and expands through
that row.

This preserves the existing imperative focus entry points used by Enter,
Backspace, arrows, paste, Undo/Redo restoration, and split-pane restoration.
Those callers do not acquire React window-state dependencies.

### Logical versus mounted nodes

All hierarchy, keyboard intent, multi-selection, move planning, and drag
planning continue to receive the complete loaded `bodyNodes` list. Only the
`OutlineRow` render map receives the mounted prefix. The DOM-based drag
projection sees the currently mounted range and naturally expands as the user
scrolls toward the tail.

## Loading Rules

1. Mount the first 60 logical rows.
2. Keep the remaining loaded row count in the spacer.
3. On tail intersection, mount the next 60.
4. When every loaded row is mounted and `afterCursor` exists, issue exactly one
   `loadMore()` request for that cursor.
5. Newly appended nodes begin in the spacer and materialize through the same
   policy.
6. A focus request bypasses scrolling and expands directly through its target
   batch.

## Failure and Race Handling

- A stale observer callback cannot shrink the window.
- A cursor is loaded at most once concurrently.
- Page or zoom changes reset observer state and row-height sampling.
- A focus request for an ID outside the pane is ignored.
- If React has not committed the requested node by the first frame, the focus
  helper performs one bounded retry; it never creates an unbounded focus loop.
- Optimistic node creation remains authoritative in `NotesStore`; windowing
  only determines when its row is mounted.

## Test Strategy

- Pure tests prove initial bounding, batch growth, focus-target rounding, and
  spacer estimates.
- A React integration test boots more than 120 rows and proves that only 60
  mount initially.
- The integration test requests focus on a hidden row and proves that its
  batch mounts, the first row stays mounted, and focus lands in the same pane.
- A controlled `IntersectionObserver` proves forward growth without eviction.
- Existing repeated Enter, split focus, selection, clipboard, and drag tests
  remain characterization gates.
- Fresh preview verification compares mounted row counts before and after
  scrolling and repeats Enter in the secondary pane.

## Delivery Boundary

The slice is complete when progressive mounting and focus materialization pass
focused tests, existing interaction tests remain green, the preview confirms a
bounded initial DOM, and the frontend lint/build/test/diff gates pass. Rust,
IPC, and SQLite are unchanged, so Rust gates are explicitly out of scope.
