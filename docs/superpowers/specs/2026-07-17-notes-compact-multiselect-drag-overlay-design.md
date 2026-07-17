# Notes Compact Multi-Selection Drag Overlay Design

**Status:** Approved for implementation

## Goal

Keep the drop position visible while multiple Notes rows are dragged by replacing
the current multi-title overlay with a compact stacked-item preview.

The preview must still communicate that the drag contains multiple rows without
displaying the whole selection or changing drop projection behavior.

## Current Problem

The multi-selection drag overlay currently renders up to three selected titles
in a vertical list plus a textual count. For taller selections, this card follows
the pointer and can cover the insertion line and nearby destination rows. The
overlay therefore makes the drop target harder to see precisely when positional
feedback matters most.

## Selected Approach

Keep the existing drag overlay component and render only the first selected row
in source order. Represent the rest of the selection with two compact,
horizontally offset backing sheets and a number-only count badge.

The backing sheets are decorative CSS pseudo-elements. This keeps the component
markup and data flow minimal while giving the preview a clear stacked-item
silhouette. No new dependency or drag-and-drop abstraction is needed.

## Preview Contract

- The overlay continues to render only when more than one row is being dragged.
- Its visible title is always the first selected row in source order, even when
  the user starts dragging from the middle of the selected range.
- An empty first-row presentation label is displayed as `Untitled`.
- The first title is truncated to one line when space is limited.
- A number-only badge displays the full selection count.
- Two unrotated backing sheets are offset horizontally and slightly vertically
  behind the title card to suggest an orderly stack.
- The overlay remains non-interactive and follows the existing pointer-anchored
  `DragOverlay` behavior.
- The selected source rows retain their existing faded appearance.

## Visual Structure

```text
                         (5)
  +------------------------+
  |  •  First selected row  |
  +------------------------+--+
     +------------------------+--+
        +------------------------+
```

The top card uses the existing Notes theme tokens for its background, border,
text, and shadow. The backing sheets use the same card and border tokens with a
subtle opacity difference. There is no rotation or multi-line title list.

## Data Flow

The existing `draggedNodeIds` array is already normalized into source order.
The outline pane continues to derive presentation labels from that order, but
the preview consumes only the first label:

```text
selected IDs in source order
  -> first selected node presentation label
  -> one-line title card

full selected ID count
  -> numeric count badge
```

The active drag ID does not replace the first source-ordered ID. This preserves
the agreed behavior for a drag started from any row in the selection.

## Drop Feedback and Behavior

This is a presentation-only change. It does not modify:

- pointer collision detection;
- visual or authoritative drop projection;
- insertion-line rendering or placement;
- multi-row move normalization;
- selection ownership and stale-session checks; or
- ordinary single-row drag behavior.

The smaller overlay simply exposes more of the existing destination list and
insertion line.

## Testing

Use strict RED/GREEN regression coverage.

1. Change the preview component test to render several labels and assert that
   only the first title is visible, later titles are absent, and the full numeric
   count is shown.
2. Preserve coverage for the `Untitled` fallback.
3. Change the rendered Notes workspace test to start a drag from the middle of a
   selected range and assert that the preview still shows only the first title in
   source order and the full count.
4. Preserve the existing assertions that the selection drag overlay is removed
   on drop, cancellation, stale selection, and authority failure.
5. Run the focused preview and workspace tests, the full frontend test suite,
   lint, production build, and `git diff --check`.

## Rejected Alternatives

### Render backing sheets as extra DOM nodes

Explicit elements would make each decorative layer directly testable, but they
add markup and semantics for a purely visual effect. Pseudo-elements are enough
for two fixed sheets.

### Use repeated box shadows only

Multiple shadows would require less CSS, but they read as depth or blur rather
than distinct dragged items. Bordered backing sheets communicate a multi-item
stack more clearly.

### Keep multiple titles and reduce their size

A smaller multi-line list can still cover the insertion line and makes titles
harder to read. One representative title plus a count is both clearer and more
compact.

## Out of Scope

- Changes to the insertion-line algorithm or styling.
- Changes to which rows are selected or moved.
- A preview for ordinary single-row drags.
- Animated, rotated, or fanned cards.
- Changes to Notes status-bar feedback.
