# Notes Workflowy Performance Follow-up Design

**Goal:** Reduce held-Enter editor work without changing Notes semantics or
adding another performance system.

## Comparison

Workflowy's current bundle uses:

- row-local, DOM-owned `contenteditable` editors;
- native key repeat with cheap per-key structural operations;
- trailing text persistence with immediate structural/blur barriers;
- memoized rows and prefix-only rendering above an estimated tail spacer.

Yonalist already uses the same core techniques. Its 5,001-node native
benchmark measured ArrowDown at 20–21 ms p95, so navigation and list growth
are not the current bottleneck. Production-runtime held Enter is also within
the existing frame budget.

## Decision

Keep the existing model, virtualizer, and persistence boundaries. Reuse the
snapshot already captured for a structural key instead of reading text and
selection from the DOM again during synchronous publication. When the
subsequent persistence barrier finds the editor clean, return without another
DOM snapshot.

This reduces one held-Enter dispatch from three selection reads to one. It
preserves native repeat ordering, focus, composition handling, rollback,
split-pane ownership, and Undo.

## Rejected Experiments

- Skipping root guide finalization removed a 5,001-row metadata pass in a
  synthetic test but did not improve the native frame benchmark.
- Mounting provisional editors directly in editing mode broke established
  held-Enter focus and projection tests.
- Copying Workflowy's 24-row growth constant would regress Yonalist's heavier
  rows; its measured 8-row growth already keeps ArrowDown within budget.

## Verification

- A focused editor test requires exactly one selection read through
  publication and the clean barrier.
- Existing held-Enter workspace tests retain ordering and focus semantics.
- Two production-runtime 25-key Enter runs measured 25 ms p95 with zero
  frames over 34 ms.
- The control gestures measured 21 ms p95 for 60-key ArrowDown in both panes
  and 22 ms p95 for 25-key production-runtime Backspace, also with no frame
  over 34 ms.
