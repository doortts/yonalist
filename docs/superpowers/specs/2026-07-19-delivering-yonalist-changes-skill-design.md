# Yonalist Delivery Skill Design

## Goal

Create a repository-scoped Codex skill that turns the recent development
retrospective into a repeatable workflow for Yonalist feature, bug-fix,
refactoring, and verification work.

The skill must improve active working time without weakening runtime evidence.
It should prevent repeated full gates, stale desktop validation, scope drift,
and unverified frontend-to-Tauri boundaries.

## Distribution and discovery

Store the skill only in this repository at:

```text
.agents/skills/delivering-yonalist-changes/
```

This is Codex's repository-scoped skill location, so no personal installation
or symlink is required. Add a short root `AGENTS.md` rule that requires Codex to
read and apply the skill before planning or implementing Yonalist changes. The
two mechanisms have different responsibilities:

- `.agents/skills/.../SKILL.md` provides discoverable metadata and the detailed
  workflow.
- `AGENTS.md` makes use of the workflow an explicit repository convention,
  reducing the chance that implicit skill selection is skipped.

If Codex is already running when the skill is first added and it does not
appear, start a new task or restart Codex once. No recurring installation step
is required afterward.

## Files

```text
AGENTS.md
.agents/skills/delivering-yonalist-changes/SKILL.md
.agents/skills/delivering-yonalist-changes/agents/openai.yaml
```

The initial version is instruction-only. It will not add helper scripts,
dependencies, hooks, or duplicated command wrappers. Automation can be added
later only when a repeated mechanical failure justifies it.

## Trigger

Use the skill before planning or implementing any Yonalist feature, bug fix,
behavior change, refactor, or user-visible verification. It is particularly
important when work touches Notes, contenteditable behavior, drag and drop,
clipboard/image handling, Undo/Redo, React-Tauri IPC, Rust, SQLite, or the
macOS desktop runtime.

Pure explanation, repository inspection, and status reporting do not need the
full delivery workflow unless they lead into a code change.

## Workflow

### 1. Establish the work contract

Write a compact contract containing the goal, observable acceptance criteria,
non-goals, affected boundaries, and the manual proof scenario. When the user
changes scope or a storage/history decision, update this contract before more
implementation. Split independently testable subsystems rather than treating
an expanding request as one undifferentiated change.

### 2. Inspect the real baseline

Check the current branch, worktree, existing changes, relevant project docs,
and the smallest owning tests. Preserve user changes. Record pre-existing
failures or warnings instead of repeatedly rediscovering them at the end.

For desktop work, identify how the current bundle and process will be proven
fresh and how test data will be isolated before relying on a running app.

### 3. Build a thin vertical slice

Start with one production path that crosses every affected boundary. Write a
focused failing test, implement the smallest slice, and run the owning test.
For cross-boundary behavior, add contract coverage for actual payload shapes
and serialization rather than relying only on mocks.

As soon as the first slice reaches the desktop boundary, verify it in a fresh
Tauri process with isolated data. Inspect Web Inspector or runtime logs at the
first unexplained failure. Do not broaden implementation while the first real
path is still broken.

### 4. Expand incrementally

Add one acceptance row at a time. Keep each change reviewable and rerun only
the focused or owning-module tests during the inner loop. Treat two failed
fixes for the same symptom as a signal to stop patching and gather fresh
evidence.

### 5. Use a verification pyramid

Run verification in this order:

1. focused regression test;
2. owning frontend or Rust module tests;
3. fresh desktop smoke test for user-visible or runtime-boundary changes;
4. lint, build, complete frontend and Rust suites, formatting, and
   `git diff --check` once at the final milestone when relevant.

Do not run the whole suite repeatedly inside the edit loop. Do not rerun a
known flaky test several times merely to obtain a pass; isolate it, report the
evidence, and distinguish it from the current change. Do not claim a clean
gate when only pre-existing warnings remain; report the baseline precisely.

### 6. Coordinate without duplicate work

Use GPT-5.6 Sol with high reasoning for design, task decomposition, adversarial
review, and rework decisions. Delegate bounded implementation or targeted test
work to GPT-5.6 Terra when parallel work is explicitly authorized. Give each
worker a disjoint file or responsibility boundary. The manager owns the final
desktop proof and complete gate; workers must not duplicate those expensive
checks unless assigned.

### 7. Finish with evidence

Confirm the diff contains only intended changes, restore temporary test data,
and commit on `main` when requested. Report acceptance rows exercised, exact
commands and results, desktop proof, known baseline failures, remaining risks,
and the commit hash.

## Request template

The skill will give the user this optional compact template for new work:

```text
목표:
완료 조건:
비대상:
영향 범위/플랫폼:
데이터·Undo/Redo 결정:
직접 확인할 사용자 시나리오:
커밋 여부:
```

Missing fields are not automatic blockers. Codex should infer safe defaults
from the repository and ask only when a missing choice materially changes the
result.

## Skill TDD evidence

Three pressured baseline scenarios were run without the skill:

- A cross-layer image editor scenario correctly kept fresh desktop proof, so
  the skill preserves that as a non-negotiable completion condition.
- An expanding Undo/image/clipboard scope proposed continuing immediately
  without first renewing the design contract, exposing scope-drift risk.
- A one-line drag UI fix proposed three focused reruns, up to three flaky
  reruns, a new full suite, and Clippy despite unrelated baseline warnings,
  exposing redundant verification cost.

After implementation, rerun the same scenarios with the skill. Success means
agents preserve fresh runtime proof, freeze changed contracts before coding,
and choose proportionate gates without retrying tests merely to manufacture a
pass.

## Success criteria

- Codex discovers the skill from a fresh task opened anywhere in the repo.
- `AGENTS.md` explicitly routes change work to the skill.
- The skill passes structural validation.
- Pressure tests no longer rationalize scope drift or repeated full gates.
- The workflow retains fresh Tauri runtime evidence for affected behavior.
- All files remain in the repository; nothing is installed under the user's
  home directory.
