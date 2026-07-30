# Notes Workflowy Performance Follow-up Plan

**Goal:** Remove duplicate DOM reads from repeated structural Enter while
preserving the existing Notes contract.

**Design:** See
`docs/superpowers/specs/2026-07-30-notes-workflowy-performance-followup-design.md`.

## Task 1: Freeze the hot-path contract

Extend the structural-key editor test to register the real flush adapter,
invoke the barrier from the key handler, and assert that publication,
forwarding, and the clean flush use one captured selection.

## Task 2: Reuse the captured snapshot

Allow `publishNow` to accept the snapshot already read by the key handler.
Return early from `flush` when no unpublished edit remains.

## Task 3: Verify

Run the focused editor tests, held-Enter workspace tests, architecture check,
lint, build, and `git diff --check`. Repeat the production-runtime native
held-Enter benchmark and retain the change only if all 25 keydowns, focus,
and the existing frame budget are preserved.
