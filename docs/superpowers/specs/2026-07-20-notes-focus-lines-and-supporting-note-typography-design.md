# Notes Focus Lines and Supporting-Note Typography Design

**Date:** 2026-07-20

## Goal

Keep zoomed-page text editing visually stable: focusing the page title or page
description must not draw a bottom line, and a row supporting note opened with
Shift+Enter must retain its editing typography after focus moves elsewhere.

## Acceptance Criteria

| Scenario | Expected result |
| --- | --- |
| Focus the zoomed-page title | The caret remains visible and no underline, border, or inset focus line appears. |
| Focus the zoomed-page description | The caret remains visible and no underline, border, or inset focus line appears. |
| Move focus away from either page field | The resting presentation also has no bottom focus line. |
| Enter a row supporting note with Shift+Enter | The editor uses the existing 14px font size and 20px line height. |
| Move focus away from the row supporting note | The resting presentation remains 14px/20px and does not jump in size. |
| Focus a row supporting note | Its existing supporting-note focus underline remains unchanged. |

## Root Cause

The page title and page description share `:focus-visible` rules that draw an
inset accent `box-shadow` on both the textarea and its resting token-text
presentation.

`NoteTokenText` intentionally uses inline `font-size: inherit` and
`line-height: inherit` so its overlay matches the editing surface. The row
supporting-note textarea sets 14px/20px directly, but its parent
`.notes-node-note-field` does not define those metrics. The resting presentation
therefore inherits a different size from an ancestor after the textarea loses
focus.

## Design

Keep the change in `notes.css`, at the field ownership boundary:

- Give `.notes-node-note-field` the same 14px font size and 20px line height as
  `.notes-node-note`. The token-text presentation will then inherit the exact
  editing metrics without changing the shared `NoteTokenText` component.
- Replace the combined page-field focus rules with explicit page title and page
  description rules that set `outline: 0` and `box-shadow: none` for both the
  textarea and resting token-text presentation.
- Leave `.notes-node-note:focus-visible` and
  `.notes-node-note-field > .notes-token-text:focus-visible` unchanged so row
  supporting notes keep their existing focus feedback.

## Test Strategy

Add focused CSS contract assertions to `NotesWorkspace.test.tsx` before changing
production CSS:

- page title and page description editor/presentation focus rules contain no
  bottom-line mechanism;
- the row supporting-note field owns 14px/20px metrics matching its textarea;
- the existing row supporting-note underline rule remains present.

Run the focused test to observe the expected failure, apply the minimal CSS
change, then rerun it. Because this is frontend-only, finish with `npm test`,
`npm run lint`, `npm run build`, and `git diff --check`.

## Manual Proof

Launch a freshly built Tauri app, open a zoomed page, and verify:

1. title focus has no bottom line;
2. page-description focus has no bottom line;
3. a row supporting note retains the same measured font size and line height
   before and after blur;
4. title, description, and row-note caret and keyboard behavior still work.

## Non-Goals

- Changing page or row content, persistence, Undo/Redo, or history behavior.
- Changing Enter or Shift+Enter command handling.
- Removing the focus underline from row supporting notes.
- Refactoring `NoteTextField` or `NoteTokenText`.

## Boundaries

This is a frontend CSS and test-only change. React component structure, Tauri
IPC, Rust, SQLite, and filesystem behavior remain unchanged.
