# Notes Mouse Multi-Selection Design

## Goal

Make Notes multi-selection work naturally with the mouse, prevent partial
indentation, move selection-command feedback into the application status bar,
and make a selected drag look like the whole selection is moving.

## Scope

This change covers visible Notes outline rows. It preserves the existing
keyboard range-selection, clipboard, selection toolbar, structural command,
and storage architecture. It does not change native text selection inside a
single row, contextual errors that already appear beside their source, or the
backend Notes data model.

## Selection Model

Extend the existing selection value without replacing its range semantics. A
selection keeps an anchor and head for keyboard and Shift range extension, and
can additionally carry an explicit ordered set of selected node IDs for
Cmd/Ctrl toggling. The selection materializer remains the single source of
truth:

- a range selection resolves to the inclusive visible slice between anchor and
  head;
- an explicit selection is filtered and ordered against the current visible
  outline;
- IDs that are no longer visible are omitted;
- an empty explicit selection clears the selection.

The workspace selection reducer owns these transitions. Existing consumers
continue to use materialized selected IDs rather than interpreting the shape
directly.

## Mouse Interaction

Mouse selection follows desktop conventions:

- A plain click keeps the existing row-editing behavior and clears a previous
  multi-selection.
- Shift+click replaces the selection with the continuous visible range from the
  current anchor to the clicked row.
- Cmd+click on macOS and Ctrl+click on Windows/Linux toggles only the clicked
  row. The clicked row becomes the anchor for a later Shift+click.
- Dragging text within one row remains native character selection.
- When a text drag crosses into another visible outline row, the gesture is
  promoted to row selection. Native character selection is cleared and the
  continuous range from the starting row to the row under the pointer is
  selected.
- Row-drag selection works upward and downward and updates as the pointer moves
  across rows.
- Releasing the pointer leaves the materialized row selection active.
- Dragging a bullet remains structural drag-and-drop and never starts mouse
  range selection.

The outline pane owns one pointer gesture controller. It records the starting
row on pointer down, observes the row under the pointer, and promotes the
gesture only after crossing a row boundary. This avoids replacing the native
text-selection path for ordinary single-row edits.

## Atomic Indentation

Indenting a selected range is all-or-nothing. Eligibility is calculated once
from the complete authoritative workspace before any batch reaches the
backend. Every structural root in the selection must have a valid preceding
visible sibling outside the selected forest. If any root fails that rule:

- no subset is sent to `applyBatch`;
- no selected row moves;
- selection remains unchanged;
- the command reports: `Can't indent selection: the first selected item has no
  preceding sibling outside the selection.`

The selection toolbar, Tab shortcut, and every other selection-indent entry
point consume the same eligibility result. The current behavior that omits the
first root and indents the remainder is removed.

## Notes Feedback in the Status Bar

Selection-command success and failure feedback moves out of the upper-right
selection toolbar and into the application status bar. A small Notes feedback
context connects the active Notes feature to `AppStatusBar` without routing
messages through global toast UI.

- Success uses `role="status"` and normal status-bar text color.
- Failure uses `role="alert"` and the existing danger color.
- A newer Notes command or selection change replaces the current message.
- Feedback clears after six seconds.
- Leaving Notes clears Notes feedback so another feature never shows stale
  Notes state.
- The selection toolbar retains actions and selection count but no longer
  renders its status region.

Contextual errors stay at their existing source: workspace load/write banners,
row command notices, attachment errors, and date/tag chooser feedback are not
moved.

## Multi-Row Drag Presentation

The existing selection-drag authority and batch move remain responsible for
what actually moves. Presentation changes make that ownership visible:

- Dragging the bullet of a selected row starts a selected drag.
- A drag overlay follows the pointer and shows up to three selected row titles
  as a compact stacked preview.
- A count badge reports the full materialized selection size.
- All selected source rows receive a shared dragging/ghost state while the
  overlay is active.
- The existing drop guide represents the destination of the selected forest,
  not only the active row.
- Dragging an unselected bullet remains an ordinary one-row drag.
- If the selected structural roots cannot be moved together, no ordinary
  single-row fallback is allowed. The drag is cancelled and its reason is
  published through Notes feedback in the status bar.

The preview is intentionally compact: it does not clone full rich row content,
attachments, notes, or controls.

## Accessibility

Selected rows retain `data-range-selected` styling and expose selection state
through their existing row semantics. The drag overlay is visual-only and the
active drag description announces the selected count. Status-bar failures use
an alert live region; successes use a polite status live region. Modifier-click
handling never intercepts links, date tokens, tags, attachment controls, or
row menus.

## Testing

Use test-first RED-GREEN cycles for each behavior:

1. Reducer tests for explicit toggle selection, anchor changes, Shift range
   replacement, visibility filtering, and clearing the last selected row.
2. Outline interaction tests for plain click, Shift+click, platform modifier
   click, same-row native text drag, upward row drag, and downward row drag.
3. Selection eligibility and command-router tests proving an invalid indent
   produces the exact reason and never calls the batch mutation.
4. Status-bar tests for success, failure, replacement, timeout, and clearing
   when Notes is inactive.
5. Drag tests proving a selected drag owns the entire frozen selection, renders
   stacked titles and a total count, ghosts all selected sources, and never
   falls back to a single row when unavailable.
6. Full Notes workspace tests, App status-bar tests, lint, production build,
   and `git diff --check`.
7. Manual Tauri verification of text-to-row drag promotion, modifier clicks,
   blocked indentation feedback, and multi-row drag presentation.

## Out of Scope

- Marquee selection from arbitrary empty canvas space.
- Persisting selection across application restarts or page changes.
- Moving contextual Notes errors into the status bar.
- Changing Notes storage commands or database schema.
- Rendering full row contents inside the drag overlay.
