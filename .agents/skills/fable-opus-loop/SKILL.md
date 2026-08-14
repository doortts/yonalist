---
name: fable-opus-loop
description: Use when implementing any non-trivial Yonalist feature, bug fix, refactor, or behavior change — splits the work so Fable 5 designs and adversarially reviews while Opus 5 xHigh writes the code, and loops review→rework until the review passes.
---

# Fable–Opus Delivery Loop

Roles are fixed. One model never does two adjacent phases.

| Phase | Model | Invocation | Output |
| --- | --- | --- | --- |
| Investigate, feature design, detailed design, TDD design | Fable 5 | `Agent` with `model: 'fable'` (Workflow: `agent(..., {model: 'fable', effort: 'xhigh'})`) | design doc at `docs/superpowers/plans/YYYY-MM-DD-<slug>.md` |
| Implementation | Opus 5 xHigh | main thread, or `Agent` with `model: 'opus'` | code + tests, one commit per item |
| Adversarial review | Fable 5 | `Agent` with `model: 'fable'` | verdict + ranked findings |

Skip this loop only for read-only explanations and trivial one-liners.
Everything else runs the full loop.

## 1. Design (Fable)

Give Fable the request, the repo paths it must read, and the contract fields
from `delivering-yonalist-changes`. Fable returns a design doc containing:
acceptance rows, non-goals, touched boundaries, the item list, and the failing
test that proves each item.

Completion criterion: every acceptance row maps to exactly one item, and every
item names its test.

## 2. Implement (Opus 5 xHigh)

One item at a time, in order. Per item: write the test, run it, record the red
output verbatim, implement, run it green. A test that never went red is
rewritten, not accepted.

Commit each item separately so any single item can be reverted alone. When
items share files, run them sequentially in one agent — no parallel fan-out.
Work in an isolated worktree branch when the main worktree holds uncommitted
work that is not yours.

Completion criterion: item is green, its commit exists, and no file outside
the item's scope changed.

## 3. Adversarial review (Fable)

After each item — not only at the end — hand Fable the actual diff
(`git show <sha>` / `git diff`), the design doc, and the red-evidence log.
Fable reads the diff itself; a summary of the diff is not a review input.

Fable judges all five, in this order:

1. **Design fidelity** — every acceptance row for this item actually
   implemented; no silent scope change, no acceptance row quietly dropped.
2. **Correctness** — real defects, boundary handling (IPC payload shapes,
   SQLite persistence, Undo/Redo, contenteditable), regression risk in
   sibling callers.
3. **Responsibility and authority** — does each function and module own only
   what belongs to it; no layer reaching past its boundary; state has one
   owner; no hidden global coupling.
4. **Clean code** — naming, dead code, duplication, one-caller indirection,
   speculative abstraction, comment density and idiom matching neighbouring
   code.
5. **Test quality** — does the test lock the contract or just the current
   implementation; was red evidence real.

Fable returns `PASS` or `REWORK` plus findings ranked most-severe first, each
with `file:line` and the concrete failure it causes. Praise is not output.

## 4. Rework loop

`REWORK` sends the findings back to Opus verbatim. Opus fixes only the listed
findings, then Fable re-reviews the new diff. Repeat until `PASS`.

Two `REWORK` verdicts on the same finding means the design is wrong, not the
code: stop patching, send it back to Fable to revise the design doc, and
restart the item from step 1.

## 5. Close out

Run the gates from `delivering-yonalist-changes` once, after the diff is
frozen. Commit without waiting to be told. Report per item: acceptance rows
exercised, red evidence, review verdicts and how many rework rounds, exact
gate commands and results, commit hashes, remaining risks.

## Stop signs

- Implementation starts before a design doc exists.
- The model that wrote the code also reviews it.
- Review runs on a description of the diff instead of the diff.
- Findings are answered with an explanation instead of a fix or an accepted
  design change.
- Several items land in one commit.
