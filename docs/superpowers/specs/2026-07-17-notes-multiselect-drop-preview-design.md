# Notes Multi-Selection Drop Preview Design

**Status:** Approved for implementation

## Goal

Show the existing Notes insertion line immediately and continuously while a
multi-row selection is dragged, without weakening the authoritative checks
that protect the eventual batch move.

The visual insertion line and the committed move must describe the same target,
but rendering the line must not wait for an asynchronous authoritative
workspace read.

## Current Failure

A selected drag starts two independent pieces of work:

1. the UI immediately renders the selected-row drag overlay; and
2. the selection command router asynchronously prepares a frozen authoritative
   workspace and selection ownership proof.

While the second step is pending, `projectDrag()` returns no projection.
`handleDragMove()` therefore clears `dropPreview`, so the selected-row overlay
can follow the pointer while the insertion line remains absent. Completing the
authority request does not itself replay the latest pointer position.

The current collision set also includes rows in the selected forest. Those rows
cannot be valid destinations, so resolving a collision against them can
temporarily suppress an otherwise valid preview.

## Selected Approach

Separate read-only visual projection from mutation authority.

At selected-drag start, prepare preview geometry synchronously from the exact
outline rows and sibling order currently rendered to the user. Store that
prepared geometry in the selected drag session and use it to project the
insertion line from the first pointer movement, even while authoritative
selection preparation is pending.

The asynchronous preparation remains mandatory for the actual move. A pending
session may render a preview, but it cannot execute a batch move. On drop, the
existing authority checks, selection revision checks, attempt epoch checks, and
authoritative projection still decide whether the command is submitted.

## Drag Session Contract

A pending selected drag owns:

- the active row ID;
- the materialized selected IDs and selection revision;
- the rendered outline rows and zoom root;
- one synchronously prepared visual projection context;
- the existing asynchronous authoritative preparation.

Visual projection uses the prepared rendered context only. Promotion to a
ready session continues to build and validate the authoritative context.

If synchronous preview preparation fails, the selected drag follows the
existing selected-invalid path and never falls back to an ordinary single-row
drag. If asynchronous authority preparation later fails or becomes stale, the
preview is cleared, the move is rejected, and the existing Notes status-bar
feedback is published.

## Collision and Preview Rules

- Rows in the selected forest are excluded from drop collision candidates for
  a selected drag because they can never be valid destinations.
- Ordinary single-row drag collision behavior remains unchanged.
- A valid visual projection is converted through the existing
  `derivePreparedOutlineSelectionDropPreview()` path. No second insertion-line
  calculation is introduced.
- The insertion line continues to use `OutlineDropPreview` (`beforeId`,
  `parentId`, and `depth`) and the existing `DropPreviewLine` renderer.
- If no valid non-selected destination exists, no insertion line is shown.
- When authoritative preparation becomes ready, subsequent projections use the
  authoritative prepared session. Both paths share the same outline projection
  functions, so the visible target and committed target follow the same rules.

## Drop Execution

The change does not relax mutation safety:

- A pending drop still waits for the exact authority promise captured at drag
  start.
- A changed selection revision, workspace generation, or newer drag attempt
  invalidates the drop.
- The final target is projected again with the authoritative prepared session.
- Only a valid authoritative target reaches the existing semantic `reorder`
  command and single `applyBatch` move.
- There is no single-row fallback and no per-row move loop.

## Data Flow

```text
selected bullet drag start
  -> prepare visual geometry from rendered outline (synchronous)
  -> start authoritative selection preparation (asynchronous)

pointer movement
  -> ignore selected-forest collision candidates
  -> project against visual geometry
  -> derive existing OutlineDropPreview
  -> render existing insertion line immediately

drop
  -> await/promote authoritative preparation
  -> revalidate selection and workspace ownership
  -> project authoritative target
  -> execute one semantic reorder command
  -> commit one batch move
```

## Testing

Use strict RED/GREEN regression coverage.

1. Add a rendered workspace test with an intentionally deferred authority read.
   Start a selected pointer drag and move over an unselected destination before
   resolving the authority. Assert that one insertion line is already rendered
   with the expected `beforeId`, `parentId`, and `depth`.
2. In the same pending state, assert that no batch move occurs before drop and
   authority validation.
3. Add coverage proving selected-forest rows are not accepted as visual drop
   collision targets and that moving to the next valid external row restores or
   preserves the insertion line.
4. Resolve the authoritative preparation and drop. Assert that the existing
   single batch move contains the normalized structural roots and the same
   semantic destination represented by the preview.
5. Preserve tests for rejected/stale preparation, drag cancellation, ordinary
   single-row drag, collapsed destinations, zoom depth adjustment, and selected
   source ghost cleanup.
6. Run the focused Notes tests, full frontend test suite, lint, production
   build, and `git diff --check`.

## Rejected Alternatives

### Replay the last pointer event after authority preparation

This is a smaller patch, but it keeps visual feedback coupled to I/O timing and
requires retaining and replaying mutable drag-event data. It also leaves the
selected-forest collision mismatch in place.

### Render a CSS-only placeholder line

A placeholder can be visible without a projection, but it cannot reliably
represent parent, sibling position, or indentation depth. It could disagree
with the final move and is therefore misleading.

### Add a second drop-position algorithm

Computing a visual target independently from the existing outline projection
would duplicate hierarchy and sibling rules. The selected approach reuses the
current prepared projection and preview derivation instead.

## Out of Scope

- Changes to Keychain storage or macOS code signing.
- Changes to the selected-row drag overlay appearance.
- Changes to Notes selection semantics or mouse range selection.
- New backend commands, database schema, or history behavior.
- Changes to ordinary single-row drag-and-drop.
