# Notes Stationary Drag Source and Single-Undo Design

**Status:** Approved for implementation

## Goal

Make Notes drag-and-drop communicate both the source and destination clearly:

- keep every visible node that will move fixed at its original location;
- show the existing compact stacked drag preview at the pointer's lower-right;
- count every node that will move, including descendants hidden by collapse;
- keep the pointer-based insertion line unobscured; and
- make the first existing Undo command after a drop restore the exact pre-drag
  outline.

The interaction follows Workflowy's outline model: moving a parent moves its
complete descendant tree, while the original source and the prospective drop
location remain understandable until pointer-up.

This design supersedes the drag-overlay rendering conditions and faded-source
presentation in
`2026-07-17-notes-compact-selection-drag-overlay-design.md`. Its selection and
move-command contracts remain unchanged.

## Confirmed Current Problems

### Drag presentation

The current outline uses dnd-kit's sortable transforms while a drag is active.
The active row and surrounding rows can therefore move or close the source gap
before the user drops. Multi-selection source rows are also faded, but only the
explicitly selected IDs receive that presentation. Descendants that move with a
selected parent are already excluded from collision geometry, yet they are not
shown as part of the moving source forest.

The compact custom `DragOverlay` renders only for more than one explicitly
selected row. An ordinary parent drag still uses the sortable row presentation,
and the overlay is not deliberately offset from the pointer, so the floating
card can obscure the insertion line.

### Undo after a drop

The running Tauri development app reproduced the reported Undo symptom:

1. complete a keyboard drag;
2. observe that focus remains on the sortable bullet button;
3. press `Cmd+Z` while that button remains focused; and
4. observe no outline change.

The same move returned to its exact original position with the first `Cmd+Z`
after focus moved into the title editor. Existing focused history tests also
pass for one single-node move, one prepared move, and a prepared move into a
collapsed target.

The move is therefore already one history entry. The root cause is that title,
note, and image editors route `resolveNotesHistoryShortcut()`, while the bullet
drag activator does not. After a drop, the focused element cannot invoke the
existing Notes Undo path, which makes repeated Undo attempts appear necessary.

## Selected Approach

Reuse the existing prepared selection forest for presentation as well as
collision filtering. Do not clone source rows or introduce a second drag-and-
drop system.

At drag start, derive one immutable visual drag snapshot containing:

- the normalized structural roots used by the eventual move command;
- every unique node in those roots' descendant forest, including collapsed
  descendants;
- the representative title, which remains the first structural root in source
  order; and
- the full forest count used by the numeric badge.

For an ordinary drag, prepare the same forest with the active node as its sole
root. For a selected drag, reuse the visual preparation already performed for
the selected session. The command session and its frozen authority remain
unchanged.

## Dragged-Forest Contract

There are three distinct concepts:

1. **Command roots** are the normalized root IDs sent to `moveNode` or
   `applyBatch`.
2. **Dragged forest IDs** are the command roots plus every descendant that moves
   with them, whether visible or collapsed.
3. **Visible source rows** are rendered body rows whose IDs are in the dragged
   forest.

Overlapping selections count each node once. If a parent and one of its
descendants are both selected, the parent remains the command root and the
descendant appears once in the forest count.

The existing private prepared-forest snapshot will expose a read-only forest ID
accessor. It remains the sole traversal authority, so presentation, collision
filtering, and the final structural move cannot disagree about which nodes are
moving.

## Stationary Source Presentation

While any valid drag is active:

- every sortable row suppresses its dnd-kit transform and transition;
- the outline therefore does not close the source gap or make destination rows
  shift around;
- every visible source row receives a dedicated drag-source presentation state;
- the source uses a subtle continuous selection-like background without the
  current low-opacity ghosting; and
- hidden descendants are not materialized, but remain included in the count.

The drag-source state is visual only. It does not change Notes selection,
selection ownership, focus, or the structural roots sent to the command.

The existing pointer-boundary resolver continues to remove the dragged forest
from destination geometry. The stationary DOM is therefore presentation, not a
valid self-drop target. The insertion line remains the only moving in-list
element.

## Drag Overlay

Use the current compact stacked-card artwork for every valid drag, including an
ordinary single-node or parent drag:

```text
  pointer
     \
      \  16 px right and down
       +----------------------+ (4)
       |  •  First root title  |
       +----------------------+--+
          +----------------------+--+
             +----------------------+
```

- The title remains the first command root in source order.
- The upper-right badge displays the complete dragged-forest count.
- Two backing cards retain the existing compact multi-item styling.
- Pointer drags place the overlay's top-left 16 px to the current pointer's
  right and bottom.
- Keyboard drag keeps its existing row-relative overlay positioning.
- The offset modifies only overlay presentation. Collision detection and drop
  projection continue to use actual pointer coordinates.

The offset is implemented as a local dnd-kit overlay modifier composed from the
activator coordinates, active-node rectangle, current transform, and a fixed
16 px gap. No new dependency is required.

## Runtime Data Flow

```text
drag start
  -> prepare normalized forest from the complete child-id graph
  -> command roots + full unique forest IDs + representative label
  -> visible source-row membership + full badge count

drag move
  -> actual pointer coordinates
  -> existing non-dragged boundary projection
  -> insertion line
  -> compact overlay at pointer + (16, 16)

pointer-up / keyboard drop
  -> existing authoritative projection
  -> one moveNode or one applyBatch mutation
  -> one existing Notes history entry
```

Drag completion, cancellation, authority rejection, and invalidation clear the
visual forest, overlay, source presentation, and insertion preview together.

## Undo Routing and Atomicity

Compose the bullet activator's keydown behavior instead of replacing dnd-kit:

1. resolve the existing Notes history shortcut;
2. if it is Undo or Redo, prevent the native action and call the corresponding
   Notes action; and
3. otherwise forward the event to dnd-kit's existing activator listener.

This keeps Space and arrow-key drag semantics unchanged while making the
focused post-drop bullet participate in the same history route as Notes text
and image editors.

No new Undo button is added. No move-history entries are merged or rewritten.
The existing history contract remains:

- ordinary move: one `move` entry;
- selected move: one `batch` entry;
- cancelled, rejected, invalid, or original-position drop: no move entry; and
- one Undo restores parent IDs, sibling order, the complete descendant tree,
  focus/navigation snapshot, and any local expansion introduced by the move.

## Accessibility

- The compact preview remains non-interactive and hidden from the accessibility
  tree.
- Existing dnd-kit announcements remain available.
- Bullet Undo/Redo routing uses the same platform detection and composing guards
  as the other Notes fields.

## Testing

Follow strict RED/GREEN coverage.

### Forest and presentation

1. Unit-test the prepared forest accessor with visible and collapsed
   descendants, overlapping selected roots, and source order.
2. Render an ordinary parent drag and assert that the parent and every visible
   descendant are marked as drag sources while a collapsed descendant is
   included only in the badge count.
3. Render a multi-root selected drag and assert unique full-forest counting and
   the first command-root title.
4. Assert that no outline row receives a sortable transform while a drag is
   active and that source rows remain fully rendered.
5. Assert that the overlay is present for one-row, parent, and selected drags,
   uses the existing stacked style, and clears on completion, cancellation, and
   rejection.
6. Unit-test the pointer overlay modifier so the overlay top-left resolves to
   pointer plus 16 px, while keyboard activation is unchanged.

### Drop and Undo

1. Reproduce a drop that leaves focus on the bullet activator and assert that
   the first platform Undo shortcut invokes Notes Undo exactly once.
2. Preserve Space and arrow-key keyboard dragging through the composed bullet
   handler.
3. Move a parent with descendants, invoke one Undo, and assert the exact
   pre-drag parent and sibling ordering.
4. Move multiple selected roots through the prepared batch path, invoke one
   Undo, and assert the exact pre-drag forest and local-expansion snapshot.
5. Assert that cancellation, invalid projection, and a valid original-position
   drop do not create a move history entry.
6. Add or strengthen backend history coverage for one batch move replay if the
   frontend regression exposes a repository-level mismatch. Do not change the
   backend when its existing atomic contract passes.

### Verification

- Run focused forest, overlay, workspace, history, and reducer tests.
- Run the full frontend test suite, lint, production build, and
  `git diff --check`.
- Run the relevant Rust history/repository test when backend coverage changes.
- In the running Tauri app, verify ordinary parent drag, selected multi-root
  drag, collapsed-descendant count, unobscured insertion line, fixed source
  rows, and first-command Undo restoration.

## Rejected Alternatives

### Clone source rows as placeholders

Cloning rows would duplicate editors, attachments, IDs, and focusable controls.
The original DOM can remain in place simply by suppressing sortable transforms.

### Use the browser-native drag image

Native drag artwork varies by platform and does not preserve the existing
dnd-kit keyboard, boundary projection, or selected-session authority model.

### Add a global window-level Undo listener

The reproduced gap is the focused bullet activator. A global listener would
broaden shortcut ownership across unrelated controls and risk double handling
the fields that already route Notes history. Composing the activator listener
fixes the root cause at the narrowest boundary.

### Merge text and move history entries

The reproduced move already replays in one history entry when the shortcut
reaches `actions.undo()`. Merging unrelated text and move entries would hide the
input-routing defect and change established history semantics.

## Out of Scope

- Adding a visible Undo or Redo button.
- Changing selection creation or command-root normalization.
- Changing pointer-boundary projection or insertion-line styling.
- Changing Notes database schema or history limits.
- Adding a drag-and-drop or animation dependency.

## Reference

- [Workflowy: Working with bullets](https://workflowy.com/help/bullets/) — a
  bullet with nested bullets moves as one unit with its descendants.
