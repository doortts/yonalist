# Empty Supporting Note Auto-Collapse Design

**Date:** 2026-07-18

**Status:** Approved by the user

## Goal

Restore the normal outline spacing after a user opens a supporting-note editor but leaves it empty, without interrupting note entry or the existing date picker.

## Scope

Apply the same behavior to:

- supporting notes beneath ordinary outline rows; and
- the supporting note beneath the zoomed page header.

This change does not alter supporting-note persistence, layout CSS, database schema, image storage, or history semantics. The separately approved image-atom editor design remains responsible for placing and selecting a caret before or after an image.

## Interaction Contract

1. `Add note`, `Shift+Enter`, and pending-focus navigation reveal and focus an empty supporting-note editor exactly as they do now.
2. The editor remains visible while it owns focus, including while the user has not typed anything yet.
3. When focus leaves the editor, a note containing only Unicode whitespace is normalized to an empty string, flushed through the existing draft queue, and immediately hidden.
4. A note containing any non-whitespace content remains visible and is flushed normally.
5. A blur suppressed by the existing date-picker integration neither flushes nor hides the editor. The date picker retains ownership of that interaction.
6. Keyboard focus movement out of an empty note follows the same rule as pointer blur: the target receives focus and the empty note collapses.
7. Returning to a node with an empty persisted note does not reveal the editor unless an existing reveal action requests it.

## Implementation Boundary

Keep the existing local reveal state:

- `noteOpen` in `OutlineNodeRow`; and
- `revealedNoteNodeId` in `NotesPageHeader`.

Each component adds the smallest blur-time branch needed to normalize, flush, and clear its own reveal state. No shared abstraction is introduced because the two components already own distinct draft-commit helpers and focus state.

## Verification

Use test-first coverage for both rendering paths:

- an untouched newly revealed empty row note collapses on ordinary blur;
- a row note cleared to whitespace collapses and flushes an empty value;
- a page-header note cleared to empty collapses and flushes;
- nonempty notes remain mounted after blur;
- date-picker-suppressed blur keeps an empty editor mounted; and
- the existing `Shift+Enter` reveal/focus behavior remains intact.

Run the focused row and page-header suites, then the complete frontend test suite and lint/build gates before completion.

## Image Caret Follow-Up

The current image presentation is not an inline editable atom, so the inability to place a caret before or after it is a missing implementation rather than intended behavior. After this isolated fix is reviewed, resume `docs/superpowers/plans/2026-07-18-notes-image-atom-editor.md` at Task 1; Task 8 creates the editor and Task 11 integrates it into outline rows and page headers.
