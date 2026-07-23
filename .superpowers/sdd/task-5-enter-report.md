# Phase A Task 5 — Enter layout-motion report

## Contract

- Goal: an authoritative exact or ownership-proven mixed Enter settlement
  performs zero root/row/`.notes-node-main` rectangle reads and starts zero
  outline animations.
- Acceptance: split, contextual first-child, mixed, and reduced-motion Enter
  settlements meet the zero-read/zero-motion contract; the motion token is
  consumed once; the first unrelated structural transition after invalidation
  captures only, and a later transition can animate.
- Non-goals: the idle baseline scheduler (Task 6), row identity retention,
  shell/editor splitting, focus redesign, Rust, IPC payloads, and persistence.
- Boundary: frontend coordinator publication state -> Notes Pane -> layout
  motion hook -> Web Animations API.
- Manual proof: deferred to the Phase A fresh-desktop gate after the remaining
  dependent performance tasks.

## RED evidence

Before production edits, the focused motion command reported 6 expected
failures and 44 passes:

- exact split and first-child each performed 7 rectangle reads;
- mixed performed 7 reads;
- reduced-motion exact Enter performed 5 reads;
- the stale baseline animated its first unrelated transition; and
- a lone entering row started one animation.

The runtime regression separately failed because
`projectionPublication` was `undefined`.

## Implementation

- Exposed the coordinator's settled `NotesProjectionPublication` through the
  runtime's state slice in the same event handling pass as the authoritative
  workspace update.
- Added one-shot, token-checked motion consumption. A wrong token preserves the
  disposition; the matching token removes only the consumed insertion
  disposition.
- Compared the Pane's current pure visible signature with the publication
  signature. A disagreement conservatively becomes mixed/no-focus while
  retaining zero motion.
- Ran the exact/mixed fast path before structural measurement: cancel active
  animations, consume once, update signature/count, clear the old FLIP
  baseline, and return without target collection or rectangle capture.
- Left same-intent non-layout draft publications unconsumed and unmeasured.
- Made the first unrelated structural transition after baseline invalidation
  capture the final layout without animation; later transitions use normal
  motion eligibility.
- Incorporated the main worktree's intended lone-entering-row behavior:
  a single new caret row appears immediately while retained shifted rows and
  multi-row expand reveals keep their prior motion policy. The main worktree
  files were read only.

The approved file list did not contain the state path needed to deliver a real
publication to the Pane. With parent approval, the thin slice also touched
`notesWorkspaceRuntime.ts`, `notesWorkspaceTypes.ts`,
`notesWorkspaceSettlementRuntime.ts`, and the owning operations regression.
It did not redesign the coordinator.

## GREEN evidence

- `npm test -- src/features/notes/useOutlineLayoutMotion.test.tsx src/features/notes/outlineLayoutMotion.test.ts src/features/notes/useNotesWorkspace.operations.test.tsx`
  — 3 files, 144/144 tests passed.
- `npx tsc --noEmit` — passed.
- `npm run test:architecture` — passed;
  `notesWorkspaceRuntime.ts` is 1499/1500 lines.
- `npm run lint` — passed.
- `git diff --check` — passed.

No full frontend suite, build, or desktop smoke was run for this task-level
edit loop; those remain the Phase A frozen-diff gates.
