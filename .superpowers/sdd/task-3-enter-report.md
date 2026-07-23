# Task 3 — authoritative Enter settlement report

## Status

Implemented and ready to commit.

The Enter critical path now prepares one expected node ID and one structural
history context at keydown, carries both through the coordinator queue, and
publishes the accepted projection, keyboard-insertion disposition, local
expansion, and focus request in the same settlement event.

## Acceptance evidence

- Split and contextual first-child use the caller-provided expected ID without
  allocating a second node ID.
- The coordinator owns the frontend session generation, history proof,
  projection/layout generations, Pane descriptor, active-drag cache, and the
  pending insertion registry.
- Exact accepted publications retain focus; mixed/mismatch publications clear
  focus atomically. A later Enter keydown advances the interaction epoch and
  leaves the first target stale/source-focused.
- Collapsed first-child projection includes prospective local expansion before
  classification, so the first accepted render can show and focus the child.
- Another live frontend session cannot prepare against or consume the current
  owner's insertion.
- Drag state and interaction epoch are published synchronously before React
  state updates. Classification receives the accepted geometry generation.
- No classification-only React state or second classification commit was
  introduced.

## Compatibility decisions

- History proof fallback is limited to legacy raw-workspace command fixtures:
  the accepted command result publishes its already-prepared entry ID. Real
  mutation results still require the returned history epoch/entry/next-Undo
  proof. Normal structural history IDs continue to use `crypto.randomUUID()`;
  only prepared Enter reserves its expected node ID, preserving the one-node-ID
  keydown contract.
- Generic React `focus` capture no longer advances the epoch because
  command-owned focus otherwise invalidates itself. Existing user guards remain
  on key, beforeinput, input, composition, and pointer events. Command focus is
  suppressed through `runCommandFocus()` and the epoch is checked before focus,
  after focus, and before acknowledgement. The repeated-Enter test verifies the
  later keydown still makes the first focus request stale.

## Verification

- `npx tsc --noEmit` — PASS.
- Task 3 focused selector across the four owning files — 8/8 PASS.
- Full owning command:
  `npm test -- src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/useNotesWorkspace.operations.test.tsx src/features/notes/useNotesWorkspace.sharedSession.test.tsx src/features/notes/NotesWorkspace.test.tsx`
  — 420/422 PASS. All coordinator, operations, shared-session, and Enter tests
  passed. Two unrelated, order-sensitive NotesWorkspace UI tests failed by
  timeout/missing rendered rows: filtered selected drag and search-result
  navigation. They were not rerun to manufacture a pass.
- `npm run test:architecture` — PASS; runtime and history controller are both
  exactly 1500/1500 lines.
- `npm run lint` — PASS.
- `git diff --check` — PASS.

## Scope

Frontend only. No Rust, IPC payload, persistence, motion-module, or Task 1/2
module changes. No desktop smoke was run for this coordinator/React-only slice.
