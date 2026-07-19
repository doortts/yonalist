# Notes Page Title Enter and Navigation Undo Design

**Date:** 2026-07-20  
**Status:** Approved for implementation planning

## Goal

Restore one continuous keyboard workflow for zoomed Notes pages:

1. entering a child page focuses the page title at its logical end;
2. pressing plain `Enter` in that page title creates and focuses a new first
   child; and
3. pressing the platform Undo shortcut immediately after the page transition
   returns to the previous page.

## Acceptance contract

| Scenario | Expected result |
| --- | --- |
| Zoom into a text child page | Its page title receives focus with a collapsed caret at the end. |
| Press plain `Enter` in a page title with no children | One empty child is created and its title receives focus. |
| Press plain `Enter` in a page title with existing children | One empty child is inserted before the current first child and receives focus. |
| Click the existing Add child button | Existing behavior is preserved: the child is appended after the current last child. |
| Press `Cmd+Z` on macOS immediately after zooming | The previous Notes page/location is restored. |
| Press `Cmd+Shift+Z` after that Undo | The child page/location is restored again. |
| Use Undo inside an editor that already handles Notes history | The shortcut is handled once, not duplicated by a window fallback. |
| Use native Undo in another editable control | Native input history remains available. |
| Press Enter while IME composition is active | No structural child is created. |

## Non-goals

- Changing ordinary outline-row `Enter` split behavior.
- Changing the Add child button's append behavior.
- Changing Archive or Trash read-only behavior.
- Redesigning the Notes history model or adding browser-history integration.
- Changing persistence schemas, IPC payloads, or Rust commands.

## Root causes

### Page title Enter is discarded

`resolveOutlineKey` correctly resolves plain title `Enter` as `split`.
`NotesPageHeader` deliberately filters that resolution out and only prevents
the browser newline. A zoomed page title therefore has no structural Enter
action.

### Zoom does not own title focus

`zoomTo` changes only `zoomRootId`. It does not put the destination page title
or its primary selection in the navigation snapshot, so the newly mounted page
does not reliably receive a caret.

### Navigation Undo lacks a non-editor shortcut boundary

Zoom transitions are already recorded as navigation history. `Cmd+Z` and
`Cmd+Shift+Z` are routed to that history only by individual title, note, row,
and image editors. After a clicked bullet unmounts, focus may fall back to the
document body, where no Notes Undo shortcut handler exists.

## Design

### 1. Make zoom destination focus explicit

The existing history-aware `zoomTo` path remains the sole owner of page
transitions. When zooming to a node, its destination snapshot also records:

- `selectedId` as the destination node;
- `focus` as the destination title; and
- a collapsed primary selection at the logical end of that title.

The existing history-location resolver normalizes this selection for text and
image nodes and the existing pending-primary-selection handoff restores it only
after the destination editor commits. Because this focus is part of the same
navigation snapshot, Undo restores the complete prior location and Redo restores
the child page with its title caret.

Zooming out to the all-pages view does not synthesize a page-title focus.

### 2. Give page-title Enter first-child semantics

`NotesPageHeader` accepts the existing `split` resolution only as the signal
for a plain, non-composing title Enter. It does not split the page title.
Instead it invokes the existing structural child-creation path with explicit
`first` placement.

The child command keeps its current default `last` placement for existing
callers such as Add child. `first` maps to `afterId: null`; `last` keeps the
current last-child anchor. Creation, one-step history, projection, pending
focus, failure handling, and write barriers continue through the existing
command.

### 3. Add a scoped global Undo fallback

The active Notes outline already owns a window key listener for `Cmd/Ctrl+K`.
That listener becomes the fallback boundary for Notes Undo/Redo shortcuts when
no editor handled the event.

The fallback runs only when:

- Notes is the visible feature;
- the event is not composing and has not already been prevented;
- the target is not an editable input, textarea, select, or contenteditable
  surface; and
- the existing platform-aware shortcut resolver returns Undo or Redo.

This makes `Cmd+Z` work when focus is on `body` or another non-editable Notes
surface without double-running editor history or stealing native input Undo.

## Data and history behavior

Creating the first child is one existing structural mutation and therefore one
Undo entry. The prior child order is restored by the existing backend history.
No schema or IPC change is required because `afterId: null` is already the
canonical first-position contract.

Page transitions remain local navigation entries in the shared session
timeline. No new history entry type is introduced.

## Testing strategy

Follow RED/GREEN in three focused acceptance rows:

1. A rendered workspace test proves bullet zoom focuses the destination page
   title at its end and a non-editable `Cmd+Z` returns to the previous page.
2. A rendered page-title test proves Enter creates before an existing first
   child, focuses the new child, ignores composition, and does not alter the
   Add child append contract.
3. A pane shortcut test proves the global fallback skips prevented events,
   editable targets, and hidden Notes panes while routing bare-surface Undo and
   Redo once.

After focused tests, run the frontend-only final gates required by the
repository skill: `npm test`, `npm run lint`, `npm run build`, and
`git diff --check`. Rust tests, formatting, and Clippy are explicitly out of
scope because Rust, IPC, persistence, and native configuration do not change.

## Manual proof

Use a freshly built and restarted Tauri app with isolated test Vault content:

1. Open a page that has a child and click the child bullet.
2. Confirm the child page title has a caret at its end.
3. Press Enter and confirm a blank first child appears before existing children
   and receives focus.
4. Return to the parent, enter the child page again, then press `Cmd+Z` and
   confirm the parent page returns.
5. Press `Cmd+Shift+Z` and confirm the child page returns with its title caret.

