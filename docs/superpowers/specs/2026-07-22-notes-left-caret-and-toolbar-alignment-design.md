# Notes Left-Caret Navigation and Toolbar Alignment Design

## Goal

Make two frontend-only Notes interactions predictable:

1. Pressing Left at the start of a bullet title moves focus to the end of the
   immediately preceding visible bullet.
2. The Notes detail maximize control sits in the same toolbar row as the
   completed-items and export controls.

## Acceptance

- With a collapsed title selection at UTF-16 offset `0`, Left focuses the
  previous visible outline item and restores its primary caret at the end.
- The previous item is chosen from the current visible outline projection, so
  collapsed descendants and filtered-out rows are skipped.
- If there is no previous visible item, or the title selection is not a plain
  caret at offset `0`, the outline does not consume Left.
- Composition, modifier, repeat, supporting-note, and image-editor guards keep
  their existing behavior.
- The former Left-at-start collapse/parent navigation is replaced. ArrowRight,
  ArrowUp, ArrowDown, and pointer collapse controls remain unchanged.
- Notes renders exactly one detail maximize control in its outline toolbar,
  after the completed-items and export controls, using the same control size
  and spacing.
- The inline control reflects and toggles the existing detail-maximized state.
  Inbox, Notifications, Settings, and headerless fallback screens retain their
  current fixed or inline maximize behavior.

## Architecture

### Caret navigation

`resolveOutlineKey` remains the pure owner of keyboard intent. Its Left branch
will return the previous visible node plus an explicit end-caret selection.
The existing pending-primary-selection path will carry that selection through
`focusNode`, allowing `OutlineNodeRow` and `NotesPageHeader` to restore the DOM
caret without querying another row's DOM or scheduling an ad hoc timer.

The end request uses a bounded safe integer and is clamped against the target's
live textarea or image-atom value by the existing selection restoration code.
This preserves pending drafts and UTF-16 correctness.

### Toolbar alignment

App-owned pane layout state will be exposed through a small React context. The
Notes outline toolbar will consume that context and render the maximize toggle
next to its existing actions. While Notes is active and ready, `TitleBar` will
not render the fixed duplicate. Other features continue to use their existing
controls.

No plugin storage, Notes persistence, IPC, Rust, SQLite, or history behavior is
changed.

## Error and Edge Handling

- A missing previous visible node produces no command.
- A target that disappears before focus settlement is handled by the existing
  pending-focus validation and acknowledgement flow.
- Read-only archive and Trash views continue to defer focus until editable.
- The pane context has a neutral default for isolated component tests, while
  production receives the App-owned state and toggle callback.

## Verification

- Pure keyboard tests for previous-visible selection, first-row no-op, and
  non-start selection guards.
- Notes workspace integration test proving focus and caret position.
- App/Notes toolbar test proving one maximize button, placement inside
  `.notes-outline-toolbar`, state reflection, and toggle behavior.
- Focused lint and production build.
- Fresh Tauri smoke test at normal and maximized pane states, checking icon
  alignment and Left navigation without changing persisted note content.

## Non-Goals

- Adding a generic plugin toolbar contribution API.
- Changing ArrowRight or pointer-based expand/collapse behavior.
- Redesigning other feature headers or pane controls.
- Persistence, export, attachment, Undo/Redo, or Vault changes.
