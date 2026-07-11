# Task 2B Frontend Unified Undo/Redo Report

## Status

DONE_WITH_CONCERNS

Implementation commit: `c23ffc3`

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

## Verification

- Focused command covering history, keyboard, coordinator, reducer, hook, and header:
  exit 0, 6 files passed, 147 tests passed.
- `npm test -- src/features/notes`: exit 0, 19 files passed, 438 tests passed.
- `npm run build`: exit 0; TypeScript and Vite completed, 2,286 modules transformed.
- `git diff --cached --check` before the implementation commit: exit 0.

## Concerns

- The confirmed Task 4 Archive race is not broadened into this task. Task 2B replaces
  render-lagging history reads with a synchronous navigation ref, but the remaining
  Archive-specific correction and tests still belong to the follow-up lifecycle fix.
- Concurrent Rust, attachment, and journal-invariant edits remained unstaged and were
  not modified, reverted, or included in the implementation commit.
