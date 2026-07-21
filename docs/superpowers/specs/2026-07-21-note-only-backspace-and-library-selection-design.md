# Note-only Backspace Confirmation and Library Selection Design

## Goal

Make an empty-title bullet with a supporting note safe to remove from the
keyboard, and make the selected Notes library row rectangular with a straight
left accent.

## Scope

- Intercept Backspace only when a text bullet title is whitespace-empty, the
  supporting note is nonempty, the caret is collapsed at offset zero, and the
  node has no image attachments.
- Ignore repeated, modified, or IME-composing key events.
- Ask for confirmation before moving the bullet and its descendants to Trash.
- Apply square corners only to the active Notes library page row. Inactive and
  hover-only rows keep their current shape.

This change does not alter storage schemas, Trash semantics, Undo/Redo,
attachment deletion, or unrelated selection styles.

## Keyboard Flow

`resolveOutlineKey` will return a semantic confirmation intent for the
note-only Backspace case instead of allowing the browser's native Backspace.
The existing direct removal intent remains limited to rows whose title and note
are both empty.

The page header and ordinary outline row will handle the confirmation intent
with the shared `ConfirmDialog`:

- Title: `Move bullet to Trash?` for an outline row and the existing page Trash
  wording for a page header.
- Description: explain that the bullet and all descendants move to Trash.
- Confirm: invoke the existing `deleteNode` action, which performs recoverable
  soft deletion of the subtree.
- Cancel or Escape: close the dialog without a mutation and restore focus to
  the title field through the dialog's existing focus restoration behavior.

Rows with image attachments keep the current native/no-op Backspace behavior,
even if they also have a note.

## Selection Visual

The active `.notes-library-page-row` will override its border radius to zero.
Its existing selected background and inset left accent remain unchanged. With
no corner radius, the selection is a rectangular box and the accent renders as
a straight vertical line. The base row radius remains in place for inactive
hover feedback.

## Failure Handling

Opening or cancelling the dialog does not flush or mutate data. Confirmation
uses the existing structural-command path, so paused or failed writes retain
the current command notice behavior and do not fabricate a successful delete.

## Verification

- Keyboard unit test for the new semantic confirmation intent and every guard.
- Workspace tests proving the dialog opens, cancel performs no mutation, and
  confirm calls the existing subtree Trash action once.
- CSS regression test proving only the active library row has square corners
  while the selected inset accent remains.
- Tauri smoke test: focus an empty-title, note-only bullet, press Backspace,
  cancel once, then confirm once and verify the subtree appears in Trash.
