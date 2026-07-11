# Task 2B Frontend Unified Undo/Redo Report

## Status

DONE_WITH_CONCERNS

Original implementation commit: `c23ffc3`

Review-fix commit: the commit containing this report

Second adversarial review commit: the commit containing this report

Third adversarial review commit: the commit containing this report

## Owned Files

- `src/features/notes/notesHistory.ts`
- `src/features/notes/notesHistory.test.ts`
- `src/features/notes/outlineKeyboard.ts`
- `src/features/notes/outlineKeyboard.test.ts`
- `src/features/notes/notesWorkspaceCoordinator.ts`
- `src/features/notes/notesWorkspaceCoordinator.test.ts`
- `src/features/notes/notesWorkspaceReducer.ts`
- `src/features/notes/notesWorkspaceReducer.test.ts`
- `src/features/notes/useNotesWorkspace.ts`
- `src/features/notes/useNotesWorkspace.test.tsx`
- `src/features/notes/OutlineNodeRow.tsx`
- `src/features/notes/NotesPageHeader.tsx`
- `src/features/notes/NotesPageHeader.test.tsx`
- `.superpowers/sdd/task-2b-report.md`

## Implementation

- The shared coordinator entry owns one UUID history session for each repository and
  vault. Initialization runs once while that entry is retained, preventing a remount
  from clearing backend history beneath live frontend snapshots. Recreating an idle
  entry creates a fresh session and aligns with `notes_initialize` clearing history.
- `notesHistory.ts` allocates stable text-burst IDs when drafts begin, closes bursts
  before structural work, allocates distinct structural IDs, and keeps at most 100 UI
  snapshot pairs keyed only by backend entry ID. It does not maintain a mutation stack.
- UI snapshots include scope, selection, zoom root, local expansions, and field-aware
  focus. Missing or evicted snapshots still apply the backend replay workspace and
  normalize current live UI against it.
- Draft writes, structural mutations, Undo, and Redo all use the coordinator FIFO.
  Replay closes the current burst, flushes visible drafts, calls backend replay, then
  restores only the snapshot matching `replayedEntryId`.
- Pending draft compounds preserve text-before-structure ordering. Text and structural
  operations use distinct IDs, while incidental collapse plus move shares one
  structural ID. New mutations leave redo invalidation to the authoritative backend.
- A synchronous navigation ref supplies history snapshots and is owner-gated so a late
  old-vault response cannot poison current navigation. Root lifecycle snapshot reads
  use this ref, leaving a clean boundary for the follow-up Task 4 Archive race fix.
- Title and supporting-note fields support Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z, and Windows
  Ctrl+Y. IME composition and `Process` remain native. Replay focus returns to the
  stored title or note field.
- Repositories without both replay methods retain their prior two-argument mutation
  calls. The production Tauri store exposes both methods and receives history contexts.
- The coordinator now owns a cross-session structural barrier. Every live hook drains
  its drafts through ordinary FIFO commands before structural work is enqueued, so the
  barrier never waits on a command that is waiting on the barrier itself.
- Structural history contexts are concrete objects allocated as the first synchronous
  step of queue execution. Sibling broadcasts strip owner `uiUpdate` while retaining
  workspace and versioned history status, including after owner unmount.
- Completed owner metadata is bounded while in-flight metadata is never evicted.
  Failed/skipped text and structural entries are explicitly discarded.
- Structural barriers compare every live participant's draft generation before and
  after a full drain pass. Unstable passes restart, yielding every 16 retries so
  continuous typing cannot monopolize the event loop.
- Coordinator sessions own their scope and confirmed projection. Cross-scope
  settlements trigger a generation-guarded subscriber reload; matching scopes receive
  data directly. Both paths preserve subscriber navigation and pending counts.
- Replay and lifecycle work return backend authority after owner unmount while omitting
  owner UI changes. Inline split/move/remove text entries allocate only after barrier
  admission and explicitly complete or discard through the bounded owner registry.

## TDD Evidence

### Pure History And Shortcuts

RED: `npm test -- src/features/notes/notesHistory.test.ts src/features/notes/outlineKeyboard.test.ts`
exited 1. `notesHistory` could not be resolved and 11 shortcut tests failed; 34 existing
keyboard tests passed.

GREEN: the same command exited 0 with 2 files and 50 tests passed.

### Coordinator Ownership And Reset

RED: `npm test -- src/features/notes/notesWorkspaceCoordinator.test.ts` exited 1 with
3 failures and 2 passes: no shared history surface, no fresh idle-remount session, and
a second initialization on a retained remount barrier.

GREEN: the same command exited 0 with 5 tests passed.

### Field-Aware Reducer State

RED: `npm test -- src/features/notes/notesWorkspaceReducer.test.ts` exited 1 with
1 failure and 9 passes because `pendingFocusField` was absent.

GREEN: the same command exited 0 with 10 tests passed.

### FIFO Replay And Mutation Contexts

RED: `npm test -- src/features/notes/useNotesWorkspace.test.tsx` exited 1 with
9 failures and 58 passes. New tests observed missing mutation contexts and Undo/Redo
actions; existing creation tests also exposed history IDs consuming the note-ID mock.

GREEN: after integration, the suite exited 0 with 67 tests passed.

Additional race RED: the same suite exited 1 with 1 failure and 67 passes because a
late old-vault draft cleared the next history UI snapshot.

Additional race GREEN: the suite exited 0 with 68 tests passed after owner-gating
snapshot writes.

### Field Surfaces

RED: `npm test -- src/features/notes/NotesPageHeader.test.tsx` exited 1 with 2 failures
and 12 passes: history shortcuts stayed native and note replay focused the title.

GREEN: the same command exited 0 with 14 tests passed.

### Second Adversarial Review

Coordinator RED: `notesWorkspaceCoordinator.test.ts` exited 1 with 3 failures and
5 passes: no shared structural barrier API, no unmounted-owner sibling broadcast, and
no activation history-status query. GREEN: 8/8 passed.

History cleanup RED: `notesHistory.test.ts` exited 1 with 1 failure and 6 passes
because `discard` did not exist. GREEN: 7/7 passed after 300 discarded failures left
only the one active snapshot.

Cross-hook chronology RED: the focused hook test exited 1 because Hook B's structural
command ran after only one of Hook A's two writes. GREEN: both writes precede the
structural call with one burst ID, while post-barrier typing uses a new ID.

Retry cleanup RED: the same-mount retry test exited 1 because the failed and retried
text writes reused one entry ID. GREEN: explicit discard gives the retry a fresh ID.

Owner-only replay RED: the sibling replay test exited 1 because Undo replaced the
sibling's selection, zoom, and focus with the unmounted split owner's null snapshot.
GREEN: replay snapshots now require exact local owner identity.

Execution-time snapshot and vault-generation status fixtures also pass, covering a
navigation change during a pre-mutation repository await and a late Vault A status
response after switching to Vault B.

### Third Adversarial Review

Coordinator RED: 3 failures and 8 passes. A one-pass barrier omitted a re-dirtied
earlier participant, partial-authority failures omitted history status, and sibling
synchronization omitted pending ownership. GREEN: 11/11 coordinator tests passed.

Epoch hook RED: the three-mount test produced A1, B1, structural and omitted A2 when A
was dirtied while B blocked. GREEN: A2 is drained during the repeated epoch before the
structural call.

Owner-loss and scope RED: all 3 focused tests failed. Replay and Archive returned no
authority after owner unmount, and an Archive subscriber received no second Archive
projection after an All mutation. GREEN: all 3 passed with ownerless authority and
scope-aware reload.

Owner registry RED: `createNotesHistoryOwnerRegistry` was absent. GREEN: its stress
test retains all in-flight entries, bounds completed entries, and remains bounded after
300 explicit failure discards. Inline compound paths use this registry for
split/move/remove success, failure, and owner abandonment.

## Verification

- Focused command covering history, keyboard, coordinator, reducer, hook, and header:
  exit 0, 6 files passed, 147 tests passed.
- `npm test -- src/features/notes`: exit 0, 19 files passed, 438 tests passed.
- `npm run build`: exit 0; TypeScript and Vite completed, 2,286 modules transformed.
- `git diff --cached --check` before the implementation commit: exit 0.
- Second-review focused history/coordinator/hook run: 3 files, 90/90 passed.
- Second-review hook plus workspace integration run: 4 files, 172/172 passed.
- Second-review final full Notes run: 21 files, 498/498 passed.
- Second-review `npm run build`: exit 0; 2,286 modules transformed.
- Third-review focused coordinator/history/hook/workspace run: 4 files, 180/180 passed.
- Third-review full Notes run: 21 files, 506/506 passed.
- Third-review `npm run build`: exit 0; 2,286 modules transformed.

## Concerns

- Review fixes now drain every pending draft before structural work, allocate
  structural UI ownership at FIFO execution time, retain in-flight snapshots beyond
  the completed-snapshot bound, broadcast live-owner settlements to sibling mounts,
  preserve lifecycle focus fields, and expose backend history status as `canUndo` /
  `canRedo`.
- Review RED: the new cross-node in-flight regression failed because the later edit
  was omitted, then failed because both text writes reused one entry ID. GREEN: the
  focused hook suite passed 71/71 after scheduled drafts captured their stable context.
- Review RED: the in-flight retention test failed because entry one was evicted before
  completion. GREEN: `notesHistory.test.ts` passed 6/6 after bounding completed pairs
  only. A stale-owner broadcast also regressed two remount barriers; GREEN was 75/75
  after broadcasts were restricted to commands with a still-live owner.
- Review verification: hook plus workspace suites passed 153/153; all 20 Notes
  test files outside the concurrently edited DatePicker passed 450/450;
  `npm run build` passed with 2,286 modules.
- The earlier concurrent DatePicker and image test instability is resolved on current
  HEAD; the final full Notes run is green without exclusions.
- Atomic `NotesMutationResult` wrapping remains a coordinated backend wire follow-up.
  This frontend continues to accept today's `NotesWorkspace` mutation response and
  derives history status through the existing backend status contract.

- The confirmed Task 4 Archive race is not broadened into this task. Task 2B replaces
  render-lagging history reads with a synchronous navigation ref, but the remaining
  Archive-specific correction and tests still belong to the follow-up lifecycle fix.
- Concurrent Rust, attachment, and journal-invariant edits remained unstaged and were
  not modified, reverted, or included in the implementation commit.
