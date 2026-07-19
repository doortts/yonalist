<!-- reconciliation: auditedHead=ec8a9ff3d016449255992adf70e128ea5e222e9a status=complete -->
> **증거 대조 상태 (2026-07-19): 완료.** commit·artifact 근거는 [감사 보고서](../reports/2026-07-19-historical-plan-reconciliation.md)에 기록했다.

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

- [x] Record the phase base commit.
- [x] Observe the focused tests fail for the missing behavior.
- [x] Implement and run the focused tests to green.
- [x] Run the relevant full regression set.
- [x] Dispatch a specification reviewer.
- [x] Dispatch a code-quality reviewer.
- [x] Fix every Critical and Important issue.
- [x] Re-run focused and regression tests.
- [x] Re-review the corrected diff.
- [x] Commit the phase and update this checklist.

## Final Gate

- [x] Frontend suite passes.
- [x] Production frontend build passes.
- [x] Rust suite passes.
- [x] v1 and v2 migration fixtures reach v3 without data loss.
- [x] Desktop and narrow visual workflows pass.
- [x] Tag/date/image/Undo performance probes pass agreed budgets.
- [x] First adversarial reviewer reports findings.
- [x] Second reviewer validates or rejects each finding with evidence.
- [x] Validated findings are corrected and regression-tested.
- [x] Final report records commit, environment, commands, results, and residual risk.
