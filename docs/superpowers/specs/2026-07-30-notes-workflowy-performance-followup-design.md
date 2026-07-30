# Notes Workflowy Performance Follow-up Design

**Goal:** Close the measured held-Enter frame gap without changing Notes
editing semantics or adding another performance system.

## Evidence

- Workflowy renders row-local `contenteditable` fields and grows a leading
  prefix in 24-row chunks above tail spacers.
- Yonalist already uses the same three techniques.
- A fresh 5,001-node native run measured held ArrowDown at 20–21 ms p95.
- The same run measured held Enter at 39–40 ms p95 with 10–15 frames over
  34 ms.
- Every optimistic root-level Enter currently calls
  `finalizeOptimisticOutlineRows`, which derives guide metadata for all 5,000
  authoritative rows. Adding a root sibling cannot change ancestor guides or
  descendant endpoints.

## Contract

- Represent every delivered Enter in order.
- Keep the final editor focused.
- Preserve split-pane ownership, persistence ordering, rollback, and Undo.
- Meet the existing p95 <= 28 ms and zero-frames-over-34-ms native gates.
- Add no dependency, cache, virtualizer, editor path, or persistence change.

## Options

1. **Skip guide finalization when every projected insertion is a root-level
   sibling split.** This removes the proven redundant full-list pass and keeps
   every existing model boundary.
2. Replace the linked projection with a new incremental projection cache. This
   touches more structure and cache invalidation without evidence that it is
   necessary.
3. Insert provisional rows directly into the DOM. This is closest to a
   lower-level Workflowy implementation but duplicates React/model ownership
   and increases focus, rollback, and accessibility risk.

## Decision

Use option 1. Track whether an entry creates a first child or splits a
non-root row while the existing projection loop resolves its source. Only
those cases need `finalizeOptimisticOutlineRows`; root sibling chains return
their projected rows directly.

A focused regression test will use root rows with observable `ancestorIds`
reads. It must fail before the change because the redundant guide pass reads
every row, then pass with only insertion-local reads. Existing nested and
first-child tests retain the general finalization path.

After the focused tests pass, rerun the native held-Enter benchmark. Stop at
this change if it meets the frame gate; consider a broader projection rewrite
only if the benchmark still proves a gap.
