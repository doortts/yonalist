# Notes Multi-Select Actions Design

**Status:** Approved for implementation

## Goal

Add the agreed first-release multi-select actions and batch tag editing to the
Notes outline without weakening atomic history, selection stability, draft
flushing, row memoization, or attachment safety.

The release includes:

- a contextual selection action bar;
- aggregate complete/uncomplete;
- indent, outdent, one-step up/down reorder, drag reorder, and Move To;
- soft delete;
- subtree duplicate;
- hierarchy-preserving copy and safe cut;
- batch tag add/remove.

Selected-range export, Archive, star, date editing, formatting, mirrors, node
types, boards, and calendar actions remain out of scope.

## Chosen Approach

Extend the existing `notes_apply_batch` contract and put one pane-owned semantic
selection command router in front of it. Keyboard shortcuts, the contextual bar,
selected-row menus, drag, and Move To all resolve a frozen selection snapshot
through that router and reach the same workspace action.

This preserves the current typed Tauri boundary and one-transaction/one-history
architecture. It also avoids two rejected alternatives:

1. Repeating existing single-node commands in the frontend would allow partial
   failure and create multiple Undo entries.
2. Replacing anchor/head selection with a global arbitrary-ID selection model
   would broaden the change into navigation, rendering, accessibility, and
   history reconciliation. The few commands that require a contiguous result
   instead use explicit eligibility rules.

## Selection Snapshot and Targeting

Add a pure selection model that derives, from the live anchor/head pair and the
current visible outline order:

- the selected visible IDs in outline order;
- selected forest roots, suppressing any node with a selected ancestor;
- the completion aggregate (`none`, `mixed`, or `all`);
- the next surviving focus candidate for deletion;
- indent, outdent, reorder, duplicate, cut, and Move To eligibility.

Opening an asynchronous chooser or starting clipboard work freezes the node IDs,
vault path, scope, and workspace generation. A later vault/scope/generation
change makes the commit a safe no-op instead of retargeting a newer selection.

Structural subtree actions use normalized forest roots. Completion and tag
operations affect every explicitly selected row; selecting a parent does not
implicitly complete or tag unselected descendants.

## Contextual Action Bar

When a valid selection range exists, the normal sticky Notes toolbar is replaced
by a horizontal toolbar with:

- Clear selection;
- `N selected`;
- Complete or Uncomplete;
- Move To;
- Move up and Move down;
- Tags;
- on widths above 720 px, direct Move up, Move down, Indent, Outdent, and
  Duplicate buttons plus a More menu containing Copy and Cut;
- on widths at or below 720 px, a More menu containing Move up, Move down,
  Indent, Outdent, Duplicate, Copy, and Cut;
- Delete as the final destructive action.

The toolbar uses `role="toolbar"`, an accessible selected-count label, roving
Left/Right/Home/End focus, and a single polite status/error region. `F6` moves
focus from an outline editor to the toolbar; `Shift+F6` returns to the selection
head. `Escape` clears the selection and restores row focus.

Every disabled command exposes a reason. Archive/Trash and loading/data-deletion
states keep mutation controls disabled.

## Shared Command Behavior

The semantic router is the only UI entry point for a selected range:

- Keyboard, toolbar, selected-row menu, drag, and Move To produce the same
  command intent and target IDs.
- A menu opened on a selected row targets the full range. A menu opened on an
  unselected row clears the range and targets only that row.
- Dragging a selected row moves the full range. A destination inside any
  selected subtree is an invalid no-op; it must never fall back to moving only
  the dragged row.
- Move destinations exclude every selected subtree, not only the menu-owning
  row's subtree.
- All commands flush pending drafts before reading content or mutating structure.

Aggregate completion is evaluated against the confirmed workspace immediately
before the queued batch executes: if any selected row is incomplete, complete
all selected rows; only when all are complete does the command uncomplete all.
The focused row never decides the direction.

One-step Move up/down is available only when normalized selection roots share a
parent and are contiguous in stored sibling order. It crosses exactly one
unselected sibling by translating to the existing atomic batch move. At the
first/last boundary it is disabled and produces no history entry.

Indent/outdent retain the existing zoom and hidden-target guards.

## Duplicate Semantics

Batch duplicate is available when normalized selected roots share one parent.
The backend validates that invariant again. It copies each full subtree and
places all copied roots as one contiguous block after the final original root:

```text
A, B, C  ->  duplicate A+B  ->  A, B, A', B', C
```

The result returns `duplicatedRootIds` in source order. After authoritative
settlement the original selection is replaced with a range from the first copied
root through the last visible descendant of the final copied root, so only the
new copied forest is selected. A mixed-parent selection disables Duplicate and
the shortcut is a no-op with feedback.

Duplication preserves title, supporting note, subtree order, completed/starred/
collapsed state, tags/dates/search derivations, and attachment metadata.
Attachment rows receive fresh IDs but retain their content-addressed path/hash;
file bytes are not copied. Single and batch duplicate share one transaction-level
helper and perform a vault attachment-capacity preflight before inserting.

## Clipboard and Cut Semantics

Add a pure outline serializer plus an injected clipboard adapter. Copy prepares
the full active subtrees, overlaying flushed drafts, and writes deterministic
Markdown-compatible plain text:

```text
- Parent
  - Child
- Sibling
```

Keyboard copy/cut writes the same value to both `text/plain` and
`text/markdown` on the native clipboard event. Toolbar copy/cut uses
`ClipboardItem` with both MIME types when that API is available, and otherwise
falls back to `navigator.clipboard.writeText`; failure of both paths is a
clipboard failure and never advances a Cut to deletion.
The paste parser recognizes this list form as well as its existing indented
plain-text form, including an empty `-` item, so copied titles and hierarchy
round-trip. IDs, timestamps, vault paths, and internal attachment paths are
never serialized. Copy keeps the selection and performs no repository mutation.

This first release intentionally copies outline titles only. To prevent lossy
deletion, Cut is disabled if any selected subtree contains a non-empty supporting
note, an attachment, or an embedded title newline. Its disabled explanation
directs the user to Move To, which preserves rich content. Copy remains available
for those selections because it is non-destructive.

Cut ordering is strict:

1. Freeze and validate the selection snapshot.
2. Flush drafts and prepare the complete selected forest.
3. Write the clipboard.
4. Revalidate vault/scope/generation ownership.
5. Issue exactly one existing batch-delete mutation.

A clipboard failure never deletes. A stale ownership check never deletes. A
delete failure leaves both the original selection and the clipboard copy and
reports `Copied, but couldn't remove`. Successful cut follows normal delete
focus behavior.

## Batch Tag Semantics

The Tags control has explicit Add and Remove modes.

- Add suggests existing tags and accepts one new value beginning with `#` or
  `@`. The value must tokenize as exactly one canonical tag.
- Remove lists the union of exact tags currently present in the selected rows.
- The chooser freezes the selected IDs while it is open and supports search,
  Enter, Escape, loading, and focus return.

Tags remain inline user content; `notes_tags` stays a derived index.

Add validates `{ prefix, normalizedTag, displayTag }`. If the exact normalized
tag already occurs in either title or supporting note, the row is unchanged.
Otherwise the display token is appended to the title, using one ASCII space
when the title is non-empty.

Remove deletes every exact matching token from both title and supporting note.
It never removes substrings, a different prefix, or URL fragments. For each
removed token, cleanup removes one immediately preceding ASCII space when
present, otherwise one immediately following ASCII space; other whitespace and
punctuation remain byte-for-byte unchanged. Rust removal uses byte-safe token
spans and NFC/case-folded identity, never UTF-16 offsets as UTF-8 byte indexes.

Both operations are idempotent and rebuild tags, dates, and search content in
the same transaction. The selection stays active while both endpoints remain in
the current projection; if an active tag filter removes an endpoint from the
view, the range becomes non-materializable and the bar closes without selecting
unrelated rows.

## Backend Contract

Extend `ApplyNotesBatchInput` / Rust `ApplyBatchWire` with:

```ts
| { op: "duplicate"; nodeIds: readonly NoteId[] }
| { op: "addTag"; nodeIds: readonly NoteId[]; tag: NoteSearchTag }
| { op: "removeTag"; nodeIds: readonly NoteId[]; tag: NoteTagFilter }
```

Extend `NotesMutationResult` with optional `duplicatedRootIds`. No new Tauri
command or schema table is introduced.

`notes_apply_batch` continues to deduplicate IDs, validate all targets before
mutation, and run one SQLite transaction. The dated mutation path supplies the
local date needed when copied or retagged content rebuilds derived indexes.

Set a defensive maximum of 10,000 batch node IDs. Invalid IDs, mixed-parent
duplicate roots, capacity overflow, or a later-node failure roll back nodes,
attachments, derived indexes, and history together.

The history finalizer must not commit a mutation whose new single entry exceeds
the 50 MiB history limit and is immediately pruned. It rejects that transaction
instead, preserving the stated guarantee that every successful mutation has one
Undo step.

## Selection Lifecycle

All batch commands preserve the original selection while pending and on failure.
After success:

- Complete/uncomplete, Add/Remove tag, Indent/Outdent, Move up/down, drag,
  Move To, and Copy retain the same stable anchor/head IDs while visible.
- Duplicate replaces the selection with the newly copied forest.
- Delete and Cut clear the selection and focus the first surviving visible row
  after the removed range, falling back to the previous surviving row.

Typing, editor paste, ordinary caret navigation to another row, zoom, library
scope change, and vault change retain their existing selection-clearing rules.
Any command that makes an endpoint invisible closes the visual range instead of
guessing a partial selection.

## Keyboard Contract

Keep:

- `Shift+Up/Down` to extend selection;
- `Escape` to clear;
- `Cmd/Ctrl+Enter` for aggregate completion;
- `Tab` / `Shift+Tab` for batch indent/outdent;
- `Cmd/Ctrl+Shift+Backspace` for batch delete.

Add or route:

- the existing platform Duplicate shortcut to batch duplicate;
- `Cmd/Ctrl+Shift+Up/Down` to one-step batch reorder;
- `Cmd/Ctrl+C` and `Cmd/Ctrl+X` to selected-outline copy/cut.

Native text copy/cut wins when a title or note textarea has a non-collapsed text
selection. Clipboard and structural shortcuts do nothing during IME composition
or key repeat.

## Error Handling

- A command is submitted once while busy; double activation is ignored.
- Draft-flush failure pauses the command before clipboard or database effects.
- Clipboard, chooser preparation, validation, backend, and projection failures
  appear in the shared action-bar error region and preserve the original range.
- Invalid drag and Move To targets produce an accessible no-op announcement and
  never tear the selection.
- Backend validation remains authoritative even when the UI disabled state was
  computed from an older snapshot.

## Testing

Use strict RED/GREEN cycles for each unit and integration boundary.

Frontend coverage includes:

- forward/reverse selection snapshots, forest-root reduction, aggregate
  completion, delete neighbor, and command eligibility;
- parameterized keyboard/bar/menu/drag parity;
- selected-row versus unselected-row menu targeting;
- selection retention, replacement, clearing, and failure behavior;
- duplicate result selection through the last copied visible descendant;
- move destination exclusion and invalid-drop no-op behavior;
- deterministic Markdown/plain serialization, empty titles, Unicode, caps,
  collapsed descendants, and paste round-trip;
- clipboard-before-delete ordering, stale ownership, and every cut failure path;
- tag chooser validation and exact-token Add/Remove semantics;
- toolbar focus, accessible names, busy state, responsive overflow, and status;
- row-memo regressions and existing image-paste precedence.

Rust coverage includes:

- new wire variants and validation;
- duplicate parent/child normalization, same-parent placement, returned root IDs,
  attachments/capacity, rollback, and one-step undo/redo;
- tag idempotency, prefix/case/NFC identity, punctuation, URL fragments, multiple
  occurrences, derived-index rebuild, rollback, and one-step undo/redo;
- 10,000-ID boundary and oversized-history rollback;
- zero-change batches producing no history entry.

Final verification runs the complete frontend tests, Rust tests, lint, production
build, and `git diff --check`, plus a desktop/narrow manual pass for the toolbar,
choosers, keyboard focus, drag, and clipboard behavior.

## File Boundaries

New focused frontend units:

- `notesSelectionActions.ts` — snapshot, forest roots, eligibility, command
  intents, and one-step reorder resolution;
- `useNotesSelectionCommandRouter.ts` — frozen ownership and shared execution;
- `NotesSelectionActionBar.tsx` — contextual toolbar and feedback;
- `NotesMoveChooser.tsx` — reusable full-workspace destination chooser;
- `NotesTagChooser.tsx` — Add/Remove tag chooser;
- `notesClipboardOutline.ts` — serializer/parser-facing outline format;
- `notesClipboard.ts` — injected environment adapter.

Existing `NotesOutlinePane`, `OutlineNodeRow`, `NotesBulletMenu`, keyboard,
move-target, workspace-command, domain/store, Rust type/repository/command/history,
CSS, and focused test files are modified only where those boundaries connect.
