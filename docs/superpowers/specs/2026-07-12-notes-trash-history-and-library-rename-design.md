# Notes Trash History And Library Rename Design

**Status:** Approved by the user on 2026-07-12; awaiting written-spec review.

## Scope

Fix the Notes root-page `Move to Trash` failure caused by an incompatible history
table shape, and add fast inline renaming to active root pages in the left Notes
library. The change remains inside Notes-owned frontend and Rust modules and does
not alter Inbox, Notifications, Markdown documents, network behavior, Archive
policy, or Trash policy.

## Trash History Compatibility

`NotesHistoryContext.commandKind` is already validated and copied into the
transaction-local `notes_history_context` table. Finalization must read that value
and persist it with every new `notes_history_entries` row.

The canonical version-three history table includes a non-null `command_kind`
column. Version-three initialization repairs either supported historical shape:

- A table without `command_kind` gains the column transactionally with a safe
  legacy value for existing session-only rows.
- A table that already has a non-null `command_kind` column is left intact.

Fresh databases, version-one upgrades, version-two upgrades, and same-version
repair all converge on the same column set. Existing Notes nodes, Archive/Trash
state, attachments, and history rows are not deleted to perform this repair.

The mutation that creates a history entry remains atomic with the Notes mutation.
If history persistence fails, moving the page to Trash rolls back rather than
leaving the page moved without an Undo entry.

## Library Rename Interaction

Inline rename is available only for active Notes library rows. Archive and Trash
rows remain read-only except for their existing lifecycle actions.

- The first click on an inactive row opens and selects the page.
- Clicking the title area of the already selected row again enters rename mode.
- Rename mode replaces the title label with a single-line text input using the
  current raw title, including an empty title.
- Enter commits. Moving focus outside the input also commits.
- Escape cancels and restores the last committed title.
- Empty or whitespace-only titles remain valid and render as `Untitled page` after
  commit, matching current Notes behavior.
- Clicking the row action menu does not enter rename mode.
- While committing, duplicate commits are suppressed and the input remains stable.

The committed rename uses the existing serialized `updateNode` command with the
node's unchanged supporting note. It therefore participates in the authoritative
Notes Undo/Redo journal as one update operation and cannot overtake another queued
write. A failed save keeps the typed value available for retry and exposes the
existing Notes error state instead of silently reverting it.

## Component Boundaries

- `NotesLibraryPageRow` owns temporary edit text, input focus, Enter/Escape/blur,
  and duplicate-commit suppression.
- `NotesLibraryPane` decides whether a row is active/read-only and supplies an
  asynchronous rename callback backed by `actions.updateNode`.
- `useNotesWorkspace` and the Tauri store keep their existing update contract.
- `history.rs` owns command-kind persistence during journal finalization.
- `repository.rs` owns canonical schema creation and same-version repair.

No generic host rename abstraction or non-Notes schema migration is introduced.

## Accessibility

The rename input is named `Rename <current page label>`, receives focus with its
text selected, and retains a visible focus indicator. Enter and Escape behavior is
keyboard-operable without relying on pointer actions. Returning to display mode
restores the normal page button semantics.

## Verification

Tests are written and observed failing before production edits.

1. A version-three fixture whose history table already requires
   `command_kind` can move a root to Trash and Undo it.
2. A canonical version-three database missing the column is repaired without node
   or history-row loss.
3. Fresh and upgraded schemas expose the exact canonical history columns.
4. An inactive row opens on first click; the selected row enters rename on the
   next title click.
5. Enter and blur save once, Escape cancels, whitespace titles render as
   `Untitled page`, and action-menu clicks do not rename.
6. Rename is unavailable in Archive and Trash.
7. Rename save failure preserves the edit value and reports the existing error.
8. Rename Undo/Redo restores both titles through the normal history path.

Focused frontend and Rust tests run first, followed by the complete Notes frontend
suite, complete Rust suite, production frontend build, formatting, and a focused
adversarial review of schema compatibility and edit-state races.
