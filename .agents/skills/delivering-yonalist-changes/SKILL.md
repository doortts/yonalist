---
name: delivering-yonalist-changes
description: Use when planning or implementing a Yonalist feature, bug fix, behavior change, refactor, or user-visible verification, especially Notes, contenteditable, drag-and-drop, clipboard or image handling, Undo/Redo, React-Tauri IPC, Rust, SQLite, or macOS runtime work.
---

# Delivering Yonalist Changes

## Core rule

The fastest valid path is a thin production slice with fresh runtime evidence.
Do not substitute repeated full gates for early boundary proof.

## 1. Freeze the contract

Before editing, record:

| Field | Required content |
| --- | --- |
| Goal | One observable outcome |
| Acceptance | Observable pass/fail rows |
| Non-goals | Explicit exclusions |
| Boundaries | React, IPC, Rust, SQLite, filesystem, macOS as applicable |
| Manual proof | Shortest real user path for user-visible or runtime-boundary changes; otherwise N/A |

Infer safe defaults and ask only when a choice materially changes the result.
If scope or a storage/history decision changes, update the contract before
continuing. Split independently testable subsystems.

## 2. Inspect the baseline

- Check branch, git status, current diff, and the smallest owning tests.
- Preserve user changes and record pre-existing failures or warnings.
- For desktop work, define how to prove the bundle and process are fresh and
  how to isolate test Vault data.

## 3. Prove one vertical slice

Write a focused failing test, implement one production path through every
affected boundary, and run its owning test. At IPC or persistence boundaries,
test real payload shapes and serialization instead of relying only on mocks.

When the first slice reaches a user-visible desktop or runtime boundary,
verify it early in a freshly built/restarted Tauri app. On the first
unexplained runtime failure, inspect Web Inspector or logs. After two failed
fixes for the same symptom, stop patching and gather new evidence.

## 4. Expand one acceptance row at a time

During the edit loop, run only the focused or owning-module tests. Keep worker
tasks and file ownership disjoint. GPT-5.6 Sol owns design, adversarial review,
rework decisions, final desktop proof, and the complete gate; use GPT-5.6
Terra for bounded implementation or targeted tests only when delegation is
authorized.

## 5. Verify proportionately

Use this order:

1. focused regression test;
2. owning frontend or Rust module tests;
3. fresh desktop smoke test for user-visible or runtime-boundary changes;
4. applicable final gates once, after the diff is frozen.

Use existing package scripts and established test-runner selector syntax; do
not invent unsupported runner flags.

Choose final gates by changed boundary:

| Changed boundary | Final gates |
| --- | --- |
| Frontend-only | `npm test`, `npm run lint`, `npm run build`, and `git diff --check`. Explicitly skip Cargo tests, formatting, and Clippy when Rust, IPC payload contracts, persistence, and native configuration did not change. |
| Rust/native, IPC payload contract, persistence, or native configuration | The frontend gates that apply, plus `cargo test --manifest-path src-tauri/Cargo.toml` and Rust formatting. Compare Clippy output with its baseline only when relevant to the touched boundary or explicitly required. |

Do not repeatedly run the full suite inside the edit loop. Do not rerun a
known flaky test merely to manufacture a pass. Isolate and report it. Do not
claim a clean gate when only a pre-existing warning baseline is known.

## 6. Finish with evidence

Review the final diff, restore temporary test data, and commit when requested.
Report concise, reproducible evidence: acceptance rows exercised, exact
commands and results, desktop proof, baseline failures, remaining risks, and,
when a commit was created, its hash. Do not create evidence directories,
record PIDs or tool versions, or require screenshots unless they diagnose the
bug or the user asks.

## User request template

~~~text
목표:
완료 조건:
비대상:
영향 범위/플랫폼:
데이터·Undo/Redo 결정:
직접 확인할 사용자 시나리오:
커밋 여부:
~~~

## Stop signs

- Scope grows but the contract does not change.
- Mocks pass while a changed desktop boundary remains unproven.
- A running app is trusted without confirming a fresh bundle and process.
- Full or flaky tests are rerun to seek a favorable result.
- Multiple agents duplicate final gates or touch overlapping files.
