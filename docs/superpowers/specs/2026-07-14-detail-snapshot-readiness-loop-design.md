# Detail Snapshot Readiness Loop Fix

## Problem

Opening a previously viewed repository item can make the detail pane alternate continuously between its cached render snapshot and its live content. The live header may report comments that are not yet mounted, while the cached snapshot shows them. This produces the visible full-pane shaking recorded for `arc-agent` discussion `#79`.

The readiness hook currently counts every rendered Markdown body below `.detail-scroll`. That subtree contains both the active live feature pane and `DetailRenderSnapshotOverlay`, whose serialized HTML includes cloned `data-markdown-body` elements. The overlay can therefore make incomplete live content appear ready. Removing the overlay then lowers the count, which makes the same observer restore it. The urgent readiness updates can also prevent the comment mount transition from committing, keeping the loop alive.

## Goals

- Determine detail readiness from active live content only.
- Preserve the render snapshot performance optimization.
- Ensure the first comment batch appears synchronously when comments arrive after an initially empty render.
- Add regression coverage for both conditions.

## Non-goals

- Redesign detail caching, Markdown rendering, or comment pagination.
- Change visual styling or animation.
- Disable snapshots permanently.

## Design

### Live readiness isolation

`useDetailContentPaintReady` will keep observing the shared detail root, but its rendered-Markdown count will exclude every node whose closest ancestor is marked with `data-detail-render-snapshot-overlay="true"`.

Overlay insertion and removal may still invoke the observer, but those mutations will no longer change the computed readiness value. The state therefore remains false until the required live Markdown bodies render, then changes to true once and leaves the overlay unmounted.

### First comment batch

`CommentThread` will derive a synchronous first-batch count from the latest `comments.length`. When a mounted conversation changes from zero comments to a non-empty thread, up to `COMMENT_MOUNT_BATCH` comments will render immediately. Only later batches will be scheduled through `requestAnimationFrame` and `startTransition`.

This preserves incremental rendering for long conversations while preventing ordinary threads from depending on a low-priority transition after their data arrives.

## Tests

1. Add a readiness-hook regression test containing rendered Markdown inside a snapshot overlay plus insufficient live Markdown. The hook must remain waiting. This test must fail against the current implementation before production changes.
2. Add a `CommentThread` regression test that renders with no comments, rerenders with one comment, and observes the first comment without advancing a mount frame.
3. Run the focused hook and comment tests after each change.
4. Run the full test suite, linter, and production build.

## Success Criteria

- Selecting the affected item no longer alternates the cached and live detail panes.
- Snapshot caching continues to cover the loading interval.
- A late-arriving first comment batch is present in the live DOM immediately.
- All automated checks pass without warnings introduced by the change.
