# Notes Focus Lines and Stable Editing Typography Design

**Date:** 2026-07-20

## Goal

Use the resting presentation as the visual source of truth for zoomed-page
titles and supporting notes. Focusing or editing these fields must not move the
title baseline, change supporting-note typography, or draw a bottom focus line.

## Acceptance Criteria

| Scenario | Expected result |
| --- | --- |
| Focus or blur a zoomed-page title | The same presentation stays in the same vertical position and keeps the same size and weight; the caret remains visible. |
| Focus or blur a zoomed-page description | Typography and position remain unchanged and no underline, border, inset focus line, or replacement outline appears. |
| Focus a row supporting note created with Shift+Enter | The visible text matches its resting 14px/20px presentation and no bottom focus line appears. |
| Move focus away from a row supporting note | Typography and position do not change and no focus line remains. |
| Edit any stabilized field | Pointer placement, selection, keyboard input, and Korean IME composition continue to use the textarea input path. |
| Enter an empty stabilized field | Its placeholder and caret remain visible without a bottom focus line. |

## Root Cause

`NoteTextField` always renders two different surfaces: a native textarea for
editing and a `NoteTokenText` span for resting presentation. It swaps their
visibility when focus changes. Even when both surfaces receive the same numeric
font size and line height, the native textarea and inline span use different
text-layout metrics, which produces the visible baseline and glyph changes.

The row supporting note also has two explicit focus-line rules:
`.notes-node-note:focus-visible` draws a one-pixel inset shadow on the textarea,
and `.notes-node-note-field > .notes-token-text:focus-visible` draws a two-pixel
inset shadow on the presentation. The earlier design incorrectly required both
rules to remain.

## Design

### Stable visual presentation

Add an opt-in stable-presentation mode to `NoteTextField` and enable it for the
zoomed-page title, zoomed-page description, and row supporting note.

In this mode:

- `NoteTokenText` remains the visible text layer while resting and editing;
- the textarea remains mounted and continues to own focus, caret, selection,
  keyboard events, clipboard handling, and IME composition;
- while editing, the textarea text becomes transparent but its caret stays
  visible using a field-owned caret-color variable;
- the presentation remains non-interactive and `aria-hidden` while editing, so
  assistive technology continues to interact with only the textarea;
- an empty field renders its existing placeholder through the stable visual
  layer so the placeholder does not disappear when editing begins.

This keeps the existing data and event flow while guaranteeing that the same
rendered glyphs and line box remain visible across the focus transition.

### Field styling

- Keep `.notes-page-title-field` as the owner of the page-title size, weight,
  line height, and caret color.
- Keep page and row supporting-note field containers as the owners of the
  resting 14px/20px typography and supporting-note caret color.
- Remove bottom-line mechanisms from both
  `.notes-node-note:focus-visible` and
  `.notes-node-note-field > .notes-token-text:focus-visible` by setting
  `outline: 0` and `box-shadow: none`.
- Preserve the already line-free focus styling for page title and page
  description fields.

## Test Strategy

Use TDD before changing production code:

1. Add `NoteTextField` tests proving the stable presentation remains visible
   while its textarea edits, the textarea text is transparent, the caret stays
   visible, and empty placeholders remain available.
2. Replace the previous CSS contract that required the row-note underline with
   assertions that both row-note focus surfaces contain `outline: 0` and
   `box-shadow: none`.
3. Add workspace assertions that the page title, page description, and row note
   opt into stable presentation without changing their editing callbacks.
4. Run the focused tests RED, apply the smallest component and CSS changes, and
   run the owning tests GREEN.

This is a frontend-only change. Final gates are `npm test`, `npm run lint`,
`npm run build`, and `git diff --check`; Rust, IPC, persistence, and native
configuration gates are explicitly out of scope.

## Manual Proof

Launch a freshly built Tauri app and verify:

1. a zoomed-page title does not move vertically when focused or blurred;
2. page and row supporting notes have no focus underline;
3. a row supporting note keeps its resting font appearance while typing and
   after blur;
4. empty placeholders and carets remain visible;
5. pointer placement, selection, Enter/Shift+Enter behavior, and Korean input
   still work.

## Non-Goals

- Changing stored content, persistence, Undo/Redo, or history behavior.
- Changing Enter or Shift+Enter command handling.
- Replacing textarea input with contenteditable.
- Refactoring token parsing, date/tag interaction, or attachment handling.
- Changing row-title focus styling.

## Boundaries

The change is limited to the shared frontend `NoteTextField` presentation/input
boundary, Notes field opt-ins, Notes CSS, and owning frontend tests. Tauri IPC,
Rust, SQLite, filesystem behavior, and native configuration remain unchanged.
