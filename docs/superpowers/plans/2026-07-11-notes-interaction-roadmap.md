# Notes Interaction Expansion Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Coordinate the approved Notes interaction work as reviewable vertical
slices while keeping the existing Yonalist host stable.

**Architecture:** SQLite and Undo foundations land first. User-facing slices then
build on those contracts. Parallel workers are used only after shared interfaces are
committed and receive disjoint file ownership.

**Tech Stack:** React, TypeScript, Vitest, Base UI, Tauri, Rust, rusqlite, SQLite.

## Global Constraints

- Detailed executable steps live in
  `docs/superpowers/plans/2026-07-11-workflowy-notes-interaction-expansion.md`.
- Approved behavior lives in
  `docs/superpowers/specs/2026-07-11-workflowy-notes-interactions-design.md`.
- Turn Into and every deferred item remain outside the current production diff.
- Each phase is reviewed and corrected before a dependent phase starts.

## Dependency Order

```text
Phase 0 documentation
  -> Phase 1 SQLite v3 + Archive contracts
  -> Phase 2 mutation journal + Undo/Redo
  -> Phase 3 outline affordances + root lifecycle
  -> Phase 4 tags and dates
  -> Phase 5 images
  -> Phase 6 export
  -> Phase 7 integrated verification + adversarial review
```

## Parallel Lanes

After Phase 2 contracts are committed:

- UI lane: action rail, collapsed halo, child composer.
- Lifecycle lane: root library row, Archive view, navigation fallback.

After Phase 3 is committed:

- Token lane: pure tag/date parsing and fixture generation.
- Query lane: SQLite tag/date indexes and structured search.

After attachment interfaces are committed:

- Native lane: import validation, storage, reconciliation.
- UI lane: byte loading, display, resize interactions.

These lanes may run concurrently only when their assigned write sets are disjoint.
Integration and shared-contract edits remain owned by the coordinating agent.

## Review Gate Per Phase

- [ ] Record the phase base commit.
- [ ] Observe the focused tests fail for the missing behavior.
- [ ] Implement and run the focused tests to green.
- [ ] Run the relevant full regression set.
- [ ] Dispatch a specification reviewer.
- [ ] Dispatch a code-quality reviewer.
- [ ] Fix every Critical and Important issue.
- [ ] Re-run focused and regression tests.
- [ ] Re-review the corrected diff.
- [ ] Commit the phase and update this checklist.

## Final Gate

- [ ] Frontend suite passes.
- [ ] Production frontend build passes.
- [ ] Rust suite passes.
- [ ] v1 and v2 migration fixtures reach v3 without data loss.
- [ ] Desktop and narrow visual workflows pass.
- [ ] Tag/date/image/Undo performance probes pass agreed budgets.
- [ ] First adversarial reviewer reports findings.
- [ ] Second reviewer validates or rejects each finding with evidence.
- [ ] Validated findings are corrected and regression-tested.
- [ ] Final report records commit, environment, commands, results, and residual risk.
