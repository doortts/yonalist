# Task 5 Frontend Integration Report

## Status

DONE

The implementation commit hash is reported in the final task handoff.

## Owned Files

- `src/features/notes/OutlineNodeRow.tsx`
- `src/features/notes/NotesPageHeader.tsx`
- `src/features/notes/NotesLibraryPane.tsx`
- `src/features/notes/notesWorkspaceCoordinator.ts`
- `src/features/notes/useNotesWorkspace.ts`
- `src/features/notes/useNotesWorkspace.test.tsx`
- `src/features/notes/notesHistory.ts`
- `src/features/notes/NotesWorkspace.test.tsx`
- `src/features/notes/NotesPageHeader.test.tsx`
- `src/features/notes/NotesChildComposer.test.tsx`
- `src/features/notes/NotesExportMenu.test.tsx`
- `src/features/notes/notes.css`
- `.superpowers/sdd/task-5-frontend-report.md`

The approved `NoteTokenText` and `NoteTextField` component implementations and
their focused tests were consumed without modification.

## Implementation

- Replaced row and page-header title/supporting-note textareas with
  `NoteTextField` while retaining the permanent native textarea, forwarded refs,
  autosizing, keyboard/IME handling, drag behavior, focus flow, and native Undo.
- Wired resting `#` and `@` tokens to typed filters with matching typography,
  whitespace, active state, and pointer behavior that does not place the textarea
  caret before activation.
- Added canonical typed AND filters, counted tag summaries, distinct `#`/`@`
  identities, visible counts, active list states, and accessible chip removal.
- Captured the live scope, library view, selection, zoom, and local expansion set
  at the first filter. Removing the last filter restores valid nullable locations
  exactly and uses a deterministic root fallback only for deleted node IDs.
- Extended atomic history snapshots with tag-filter origin state so Undo/Redo
  restores both the filtered scope and its return location. Coordinated hooks keep
  their final scopes independent.
- Routed plain text through legacy search and queries with required, excluded, or
  OR clauses through `searchStructured`. Validation errors are shown without a
  repository call; request IDs still reject stale results; trails and navigation
  remain intact.
- Kept the library layout flat and restrained, with stable field/chip dimensions
  and no nested cards or instructional copy.

## TDD Evidence

### RED

- Host integration: the focused workspace test could not find the resting
  `#today tag filter is inactive` control before rows and headers used
  `NoteTextField`.
- Filter state: the focused hook test failed because `toggleTagFilter` did not
  exist before the canonical filter API was implemented.
- Structured search: the focused hook test showed the legacy search receiving
  untrimmed input before parser-based routing was added.
- Counted tags: the workspace test could not find `#Work, 2 notes` before counted,
  typed summaries were rendered.
- History restoration: the Undo test restored null location fields instead of the
  captured filtered return location before origin snapshots were added.
- Nullable location review: `npm test -- src/features/notes/useNotesWorkspace.test.tsx -t "restores an unzoomed library location"`
  exited 1 and restored `selectedId`/`zoomRootId` as `other` instead of `null`.
- Selected Tags review: `npm test -- src/features/notes/useNotesWorkspace.test.tsx -t "keeps an active filtered Tags view stable"`
  exited 1 because the filtered `tagged` node disappeared into the empty chooser.
- Failed request review: `npm test -- src/features/notes/useNotesWorkspace.test.tsx -t "rolls back a failed first tag request"`
  exited 1 because retrying the same tag produced no active filter.
- Full Notes compatibility run exited 1 with 2 failures in
  `NotesExportMenu.test.tsx`; both tests still queried the intentionally hidden
  resting textarea by accessible textbox role.

### GREEN

- Each focused RED command above was rerun after its corresponding implementation
  and exited 0.
- `npm test -- src/features/notes/NotesWorkspace.test.tsx` exited 0 with 84 tests.
- `npm test -- src/features/notes/NotesPageHeader.test.tsx` exited 0 with 14 tests.
- The two focused export pending-save cases exited 0 with 2 tests and 34 skipped.

## Final Verification

```bash
npm test -- src/features/notes
```

Exit 0: 22 test files passed, 587 tests passed, 0 failures.

```bash
npm run build
```

Exit 0: TypeScript and Vite production build passed; 2,290 modules transformed.

```bash
git diff --check
```

Exit 0 with no whitespace errors before staging.

## Ownership And Visual Check

- Concurrent Rust, domain, store, date parser/index, and fixture changes remain
  unstaged and were not edited, reverted, or included by this frontend task.
- The local Vite preview is available at `http://127.0.0.1:4173/`.
- Screenshot verification could not run because this Codex desktop session had no
  attached in-app browser target. Component and workspace suites cover the stable
  layout, permanent textarea, interaction, and accessibility contracts, but this
  report does not claim a browser screenshot pass.

## Review Remediation

### Count Invalidation

- Added `invalidatesTagSummaries` to authoritative coordinator settlements and
  synchronized sibling events. Direct, compound, lifecycle, restore, Empty Trash,
  and Undo/Redo mutations set the flag without changing history IDs, ownership, or
  atomic failure payloads.
- Routed every counted-tag read through one hook-local single-flight pump. Requests
  receive monotonic versions, invalidations that arrive during a read coalesce into
  one follow-up read, and only the latest response can publish.
- Local title/note saves and sibling-hook saves now update counts and filtered
  results. A filter whose tag disappears remains removable and visibly shows count
  zero.
- Failed count reads do not activate a requested filter or replace the last known
  summaries.

### Viewed Trash Restore

- Chose the explicit follow flow for the root currently open in Trash: after a
  successful restore, the workspace switches to Active, zooms/selects the restored
  root, enters title editing, and publishes field-aware title focus.
- The transition remains inside the existing structural command and atomic history
  path. A navigation change made while restore is pending prevents the follow
  transition, preserving the final live coordinator navigation.

### Review RED

- Local count test exited 1: the filtered result became empty but `tagSummaries`
  still contained `#Work` with count 1.
- Sibling count test exited 1 with the same stale count after the sibling editor
  removed the sole tag.
- Coalescing test exited 1 because no post-save `listTagsWithCounts` call occurred.
- Workspace chip test exited 1 because the active chip rendered `#work` instead of
  `#work0` after the tag disappeared.
- Count failure test exited 1 because a rejected counted-summary read still
  activated the `#work` filter.
- Viewed Trash hook test exited 1 because `libraryView` remained `trash` instead of
  `all`.
- Viewed Trash UI test exited 1 because no page-title textarea remained after
  restore.

Each focused RED command was rerun after its corresponding implementation and
exited 0.

### Review Verification

Baseline on current HEAD before remediation:

```bash
npm test -- src/features/notes
```

Exit 0: 22 files and 605 tests passed.

Focused atomic/coordinator regression:

```bash
npm test -- src/features/notes/useNotesWorkspace.test.tsx \
  src/features/notes/notesWorkspaceCoordinator.test.ts
```

Exit 0: 2 files and 123 tests passed.

Focused workspace regression:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx
```

Exit 0: 1 file and 85 tests passed.

Final Notes verification:

```bash
npm test -- src/features/notes
```

Exit 0: 22 files and 611 tests passed. One concurrent untracked performance file
and its 10 tests were discovered but skipped by their own suite configuration.

Final production verification:

```bash
npm run build
```

Exit 0: TypeScript and Vite passed; 2,290 modules transformed.

Concurrent Rust attachment/command/export/repository/type edits and the untracked
Notes expansion performance test were not modified, staged, reverted, or committed
by this remediation.
