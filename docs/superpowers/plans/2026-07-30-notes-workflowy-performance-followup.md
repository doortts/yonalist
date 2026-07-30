# Notes Workflowy Performance Follow-up Plan

**Goal:** Remove redundant full-outline guide derivation from optimistic
root-level Enter while preserving the existing Notes contract.

**Design:** See
`docs/superpowers/specs/2026-07-30-notes-workflowy-performance-followup-design.md`.

## Task 1: Freeze the redundant-work regression

**Modify:** `src/features/notes/notesLocalStructure.test.ts`

1. Add a 5,000-root-row projection test whose `ancestorIds` getters count
   reads.
2. Project one root sibling split.
3. Assert correct row order and fewer than 100 `ancestorIds` reads.
4. Run
   `npm test -- src/features/notes/notesLocalStructure.test.ts` and confirm the
   new assertion fails because guide finalization reads every row.

## Task 2: Skip unchanged guide metadata

**Modify:** `src/features/notes/notesLocalStructure.ts`

1. While applying entries, mark guide finalization as required only for a
   first-child insertion or a split whose resolved source depth is non-zero.
2. Return projected rows directly when all applied entries are root sibling
   splits; otherwise retain `finalizeOptimisticOutlineRows`.
3. Run the focused local-structure test and the owning outline-prefix and
   workspace held-Enter tests.

## Task 3: Measure and finish

1. Reseed the isolated `5000|50|5` benchmark Vault.
2. Start a fresh Tauri benchmark process.
3. Run primary and secondary held Enter, then ArrowDown as a regression
   control.
4. Require exact keydown representation, retained focus, p95 <= 28 ms, and
   zero frames over 34 ms.
5. Run the focused semantic tests, architecture gate, lint for changed files,
   build, and `git diff --check`.
6. Review and commit only the test and minimal implementation. If the native
   benchmark does not improve, revert the implementation and investigate the
   next measured bottleneck instead.
