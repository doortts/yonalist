# Notes Subpage Title and Child Indent Design

**Date:** 2026-07-20
**Status:** Approved for implementation

## Goal

Make a zoomed Notes page visually stable and clearly hierarchical:

1. the page title keeps the same typography whether its caret is visible or
   not; and
2. the page's child outline is indented by 24px, following the hierarchy shown
   in the supplied Workflowy reference.

## Acceptance contract

| Scenario | Expected result |
| --- | --- |
| A zoomed text-page title is being edited | The title uses 27px type, 700 weight, and a 34px line height. |
| The same title loses its caret | Its visible size and line metrics do not change. |
| A zoomed page has child bullets | The complete child outline begins 24px inside the page's existing outline baseline. |
| The zoomed page shows the Add child control | The control follows the same 24px child-region offset. |
| Children have deeper descendants | Existing per-depth indentation and guide spacing continue to accumulate from the shifted child baseline. |
| The outline is not zoomed into a page | Existing top-level alignment remains unchanged. |
| A child is dragged or a drop preview is shown | Row geometry, depth projection, guides, and preview alignment remain internally consistent. |

## Non-goals

- Changing the 27px page-title design or the 16px outline-row design.
- Changing the 36px desktop or 28px narrow-screen per-depth indentation.
- Changing row hierarchy, `aria-level`, keyboard behavior, or Undo/Redo.
- Reworking the shared token renderer or the drag-and-drop projection model.
- Recreating Workflowy's guide-line styling beyond the requested baseline
  offset.

## Root cause

`NoteTextField` overlays two representations of the page title:

- an editing `textarea`; and
- a resting `NoteTokenText` presentation layer.

The textarea receives `.notes-page-title` typography directly and renders at
27px. `NoteTokenText` deliberately sets its font metrics to `inherit` in an
inline presentation style. Its immediate `.notes-page-title-field` parent has
no title typography, so the resting layer inherits the application-wide `h1`
size of 18px. The field therefore visibly shrinks when editing ends.

The child outline and page-title row currently share the same outer content
baseline. A depth-zero child consequently places its text on the page-title
text line, while its bullet sits to the left. There is no zoom-specific child
region offset.

## Design

### 1. Put page-title typography on the field boundary

Make `.notes-page-title-field` the typography owner for both title layers:

- `font-size: 27px`;
- `font-weight: 700`; and
- `line-height: 34px`.

Keep the existing `.notes-page-title` declarations as the concrete control
contract. The resting layer's intentional inline `inherit` values will now
resolve to the same values as the textarea, without `!important` rules and
without altering `NoteTokenText` for ordinary rows, supporting notes, tags,
dates, or URLs.

### 2. Mark and offset only the zoomed child region

Expose the existing `zoomRootId` state as a stable zoomed-page marker on the
outline content. Under that marker, move both direct child-region surfaces
24px inward:

- `.notes-outline-list`; and
- `.notes-child-composer`.

Use one CSS custom property for the 24px page-child offset so the list and
composer cannot drift apart. Apply the offset at their outer block boundary,
not by changing row depth or individual grid columns. Auto block sizing will
consume the remaining inline width and avoid adding horizontal overflow.

This preserves the existing meanings of `--notes-depth`,
`--notes-outline-indent`, `--notes-content-offset`, and the drag delta. Guides,
drop previews, row hit targets, and nested descendants move together with the
list while retaining their current relative geometry.

## Alternatives considered

### Override only the resting presentation layer

A selector targeting `.notes-page-title-field > .notes-token-text` would need
to compete with inline `font-size: inherit` and related metrics, encouraging
`!important` or duplicated per-layer rules. It fixes the symptom but leaves
the field without one typography source.

### Change the shared token renderer

Removing its inherited inline font metrics could make class selectors win,
but it changes every tokenized Notes field. That scope and regression risk are
unnecessary for a page-title-only defect.

### Add one artificial depth level to zoomed children

Changing rendered depth would reuse the existing 36px/28px indentation, not
the approved 24px. It would also conflate visual page containment with actual
outline hierarchy and complicate drag/drop and accessibility semantics.

## Testing strategy

Follow RED/GREEN with focused style-contract coverage before changing
production CSS or markup:

1. prove the page-title field owns the same 27px, 700, and 34px metrics used by
   the editing title;
2. prove a zoomed outline exposes a dedicated state marker;
3. prove the zoomed marker applies the 24px child offset to the list and Add
   child composer while leaving the ordinary outline unscoped; and
4. retain existing CSS contracts for depth indentation, guides, drop previews,
   title controls, and narrow-screen rules.

Run the owning Notes workspace tests during the edit loop. Because this is a
frontend-only visual change, final automated gates are the full frontend test
suite, lint, build, and `git diff --check`; Rust and IPC gates are explicitly
out of scope unless implementation crosses those boundaries unexpectedly.

## Manual proof

Use a freshly built and restarted Tauri app with isolated Notes data:

1. Open a text page with at least one child and one grandchild.
2. Confirm the focused page title uses the expected large title size.
3. Move focus away and confirm the title does not change size or line height.
4. Confirm first-level child bullets and the Add child control begin 24px
   inward from their prior baseline.
5. Confirm deeper descendants retain their existing additional indentation and
   guides.
6. Drag a child across sibling and nested positions and confirm the drop
   preview stays aligned and the resulting hierarchy is correct.
7. Return to All notes and confirm top-level rows retain their original
   alignment.
