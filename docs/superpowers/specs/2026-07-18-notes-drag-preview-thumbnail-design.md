# Notes Drag Preview Card and Image Thumbnail Design

**Status:** Awaiting written-spec review

## Goal

Make the Notes drag overlay match what is actually moving:

- one moved item uses one plain card with no stacked sheets or count badge;
- two or more moved items retain the stacked-card treatment and full count;
- an image root uses a small thumbnail instead of a text-only filename card;
  and
- an unavailable or still-loading image falls back to the existing filename
  presentation without delaying drag activation.

The moved-item count is the authoritative full forest count. A parent with
descendants therefore remains a multi-item stack even when it is one command
root.

## Selected Approach

Reuse the existing `NotesSelectionDragPreview` and drag presentation snapshot.
Do not create a second overlay component or image-loading pipeline.

At drag start, the outline pane freezes:

- the existing representative label;
- the complete dragged-forest IDs;
- whether the representative root is an image node; and
- the representative row's currently rendered image `currentSrc`, when one is
  available.

The source rows remain mounted during drag, so the existing blob/object URL can
be reused by the overlay. The preview never reads attachment bytes, creates a
new object URL, resizes an image, or participates in the eight-image residency
coordinator.

## Preview Contract

### One moved item

- Render one top card only.
- Hide both decorative backing-sheet pseudo-elements.
- Hide the numeric count badge.
- Text nodes show the existing bullet and one-line label.
- Image nodes with a ready source show a contained thumbnail.
- Loading, missing, or failed image sources show the existing filename label.

### Multiple moved items

- Render the existing two decorative backing sheets.
- Render the full unique dragged-forest count in the upper-right badge.
- Use the first command root in source order as the representative.
- If that representative is an image with a ready source, show its thumbnail
  on the top card; otherwise show its label.

The existing pointer offset, keyboard placement, source highlighting, drop
projection, move command, and single-Undo behavior do not change.

## Image Cost

The selected approach has no additional disk I/O and no new full-image decode.
The browser renders a second small `<img>` using the source row's already loaded
URL and decoded resource. Incremental cost is limited to one small DOM element,
layout, and thumbnail paint while dragging.

Generating persistent thumbnail files or reading and resizing attachment bytes
at drag start would add disk, CPU, memory, cache invalidation, and cleanup cost.
That work is unnecessary for a transient overlay and is deliberately excluded.

## Accessibility

The complete overlay remains `aria-hidden` and non-interactive. The source row
retains the existing accessible image name and dnd-kit announcements.

## Testing

Follow RED/GREEN coverage:

1. Component test: `total=1` has no badge and no multi-item marker.
2. Component test: `total>1` retains the multi-item marker and full badge.
3. Component test: a thumbnail source renders a non-draggable decorative image;
   no source falls back to the label.
4. Workspace test: a ready image drag freezes and displays the existing source
   URL without another attachment-byte read or object-URL creation.
5. Workspace test: a loading/unavailable image starts immediately with the
   filename fallback.
6. Preserve ordinary parent, selected forest, pointer-offset, cancellation,
   filtered authority, and first-Undo regression coverage.
7. Run focused preview/workspace tests, the full frontend suite, lint,
   production build, and `git diff --check`.

## Out of Scope

- Persistent thumbnail files or a thumbnail database/cache.
- Loading an offscreen or unavailable image solely for a drag overlay.
- Rendering every selected image in the overlay.
- Changes to image import, resize, lightbox, or residency behavior.
- Animation or a new drag-and-drop dependency.
