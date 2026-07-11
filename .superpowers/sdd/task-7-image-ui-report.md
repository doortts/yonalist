# Task 7 Pure Image UI Slice Report

## Status

DONE_WITH_CONCERNS

Implementation commit: `16776c87fde96e204333ef637be58553165663ef`

Review-fix implementation commit: `03608fe9b34e5076bbead0eb8fd30c234b799ab6`

Remaining-findings implementation commit: `0057403365cf91e084c03fb08bd7186563ec40f3`

## Owned Files

- `src/features/notes/NotesImageAttachment.tsx`
- `src/features/notes/NotesImageAttachment.test.tsx`
- `.superpowers/sdd/task-7-image-ui-report.md`

No domain, store, outline, menu, workspace, shared CSS, Rust, or shared component
file was modified by this slice.

## Public API

`NotesImageAttachment` is store-agnostic and consumes:

- `attachment`: `id`, `originalName`, `mimeType`, intrinsic width/height, and
  persisted display width.
- `bytes` or `loadBytes`: already validated raw bytes. The component accepts no
  URL prop and never loads a network URL.
- `onDisplayWidthCommit(displayWidth)`: one integer-width persistence request at
  the end of a changed pointer or keyboard interaction.
- Optional `onRemove()`: renders the component-owned remove command when supplied.

The metadata interface intentionally contains only fields required by this pure
view, so continuing backend wire/store work does not couple into the component.

## Implemented Behavior

- Creates `Blob` object URLs from supplied bytes and revokes them when bytes are
  replaced, the attachment changes, an abandoned async load completes, or the
  component unmounts.
- Reserves the final image frame during byte loading and failure states by using
  intrinsic dimensions as the exact CSS aspect ratio.
- Treats persisted display width as the target, capped by observed content width
  and intrinsic width. It never upscales.
- Uses a preferred 160px minimum only when both intrinsic and content width permit
  it. Smaller intrinsic images and narrower containers remain fully visible.
- Restores the persisted target if a temporarily narrow container widens again;
  container-only clamps do not write persistence.
- Provides a right-edge pointer handle with pointer capture. Pointer moves update
  local preview only, and pointer up/cancel emits at most one width commit.
- Provides Arrow-key resizing in 16px steps, Shift+Arrow in 32px steps, Home for
  minimum, and End for maximum. Repeated keydowns preview locally and commit once
  on key release or focus loss.
- Displays stable loading and error fallbacks. Native image decode errors switch
  to the same reserved error frame.
- Shows a lucide remove icon, accessible name, native title, and shared tooltip
  only when `onRemove` is provided.

## Accessibility

- Named `group` for each image and original filename as image alternative text.
- Loading uses `aria-busy` plus a live `status`; failure uses `alert`.
- The focusable resize handle is a named vertical `separator` with current,
  minimum, maximum, and text width values.
- Pointer and keyboard resizing share the same bounds and persistence contract.
- The optional remove button has an explicit filename-specific accessible name;
  its trash icon is hidden from accessibility APIs.

## Strict TDD Evidence

### RED

Command:

```bash
npm test -- src/features/notes/NotesImageAttachment.test.tsx --reporter=verbose
```

Observed result: exit 1. Vitest failed to resolve `./NotesImageAttachment`
because the production component did not exist. The test file had been created
first, and no production image component had been written.

### GREEN

The same focused command after implementation exited 0: 1 test file passed,
7 tests passed, and 0 failed. Coverage includes no-upscale/content caps, the
conditional 160px minimum, exact ratio, pointer capture and one release commit,
keyboard resizing, container re-clamping, Blob URL lifecycle, loader/decode
fallbacks, and the optional remove action.

## Verification

```bash
npx tsc --noEmit --pretty false
```

Exit 0 with no TypeScript errors.

```bash
npm run build
```

Exit 0. TypeScript and the Vite production build completed successfully; 2,286
modules were transformed.

```bash
git diff --cached --check
```

Exit 0 before the implementation commit. The staged path audit contained only
the two owned React files.

## Concerns

- Host placement and shared Notes CSS integration remain intentionally deferred
  to the integration owner. This component uses only self-contained inline
  layout styles and existing theme variables.
- The component was not browser-captured in a real Notes row because this slice
  owns neither an integration host nor a visual fixture. Stable geometry is
  verified through the observed `ResizeObserver` and frame styles in jsdom.
- Persistence failure/retry feedback belongs to the caller. The local preview
  remains at the committed interaction width until a changed persisted prop is
  received.
- The full frontend suite was not run while concurrent Task 7 history/backend
  files were changing. The owned suite, full TypeScript check, and production
  build are green.
- Concurrent edits in Rust and Notes history/coordinator/store integration files
  were left unstaged, unmodified, and out of the implementation commit.

## Four-Finding Review Fixes

### Interaction Identity And Cancellation

Pointer and keyboard interaction records now capture attachment ID plus the
specific direct-byte/loader source active when the interaction begins. Identity,
source, persisted-width changes, and unmount synchronously clear both interaction
records, restore the persisted target, and release active pointer capture. Move,
release, keyup, and blur handlers also verify identity before committing, so a
retained DOM handle cannot call a replacement attachment's callback.

RED command:

```bash
npm test -- src/features/notes/NotesImageAttachment.test.tsx \
  -t "cancels pointer and keyboard" --reporter=verbose
```

Observed: exit 1. The replacement attachment callback was incorrectly called once
with width `280` after the original attachment's pointer interaction was released.

### Zero And Tiny Content Widths

Finite `ResizeObserver` widths now include zero. A zero-width host produces a
stable zero-width frame and zero-valued disabled separator bounds, removes the
handle from tab order, and ignores pointer/keyboard resizing. Tiny positive widths
floor deterministically and remain capped below intrinsic width while preserving
the valid intrinsic aspect ratio.

RED command:

```bash
npm test -- src/features/notes/NotesImageAttachment.test.tsx \
  -t "collapses deterministically" --reporter=verbose
```

Observed: exit 1. After a zero-width observer entry, the frame incorrectly remained
`320px` wide instead of collapsing to `0px`.

### No-Op Interaction Commits

Both pointer and keyboard interactions now retain their clamped starting width and
compare it with the final clamped width. Moving away and returning to the start
does not call persistence and therefore creates no empty history entry.

RED command:

```bash
npm test -- src/features/notes/NotesImageAttachment.test.tsx \
  -t "does not commit" --reporter=verbose
```

Observed: exit 1. Both pointer and keyboard return-to-start tests incorrectly
called persistence once with the unchanged width `320`.

### Invalid Intrinsic Geometry

Zero and nonfinite intrinsic width/height now select an immediate stable error
frame before width limits, aspect ratio, image attributes, or resize ARIA are
constructed. No Blob URL is created for invalid metadata. Changing the same
attachment back to valid dimensions retriggers the byte-to-Blob lifecycle.

RED command:

```bash
npm test -- src/features/notes/NotesImageAttachment.test.tsx \
  -t "immediate stable error" --reporter=verbose
```

Observed: exit 1 with 4 failed cases. Zero/nonfinite width and height exposed a
loading state plus invalid ratios such as `0 / 320` and `640 / NaN`; invalid width
also produced incorrect resize ARIA values.

### Review-Fix GREEN And Verification

```bash
npm test -- src/features/notes/NotesImageAttachment.test.tsx --reporter=verbose
```

Exit 0: 1 test file passed, 15 tests passed, 0 failures, and no warnings. The
original Blob URL replacement/unmount coverage remains green.

```bash
npx tsc --noEmit --pretty false
```

Exit 0 with no TypeScript errors.

```bash
npm run build
```

Exit 0. TypeScript and Vite completed successfully; 2,286 modules were
transformed.

The full frontend suite was not run for this pure-component review fix. Focused
behavior, complete TypeScript compilation, and the production bundle were
verified.

## Remaining Interaction Findings

### Exact Callback Ownership

The immutable interaction identity now includes attachment ID, direct bytes or
loader, MIME source, intrinsic width/height, the exact commit callback, and the
starting persisted width. Pointer and keyboard completion invoke only the captured
callback after confirming every identity field still matches. Callback identity
changes synchronously cancel the interaction, reset its proposal, and release any
pointer capture, so the replacement owner receives no stale commit.

RED command:

```bash
npm test -- src/features/notes/NotesImageAttachment.test.tsx \
  -t "callback owner changes" --reporter=verbose
```

Observed: exit 1 with 2 failed tests. A replacement pointer callback incorrectly
received width `380`, and a replacement keyboard callback incorrectly received
width `336`.

### Proposed Width Versus Rendered Clamp

Each interaction now owns a user-authored proposal initialized from its rendered
starting width. Pointer deltas and keyboard steps update that proposal against
intrinsic bounds only. Current container width independently clamps rendering,
without rewriting the proposal or marking a user change.

Completion requires all of the following: unchanged interaction identity, a
proposal different from the interaction start, a positive rendered width, and a
final rendered width different from the starting rendered width. Therefore a
container-only collapse is a no-op, a proposal made while collapsed reappears when
space returns, and no path persists width zero. Intrinsic geometry changes or
invalidity cancel the interaction and release pointer capture before completion.

RED command:

```bash
npm test -- src/features/notes/NotesImageAttachment.test.tsx \
  -t "pointer-only container collapse|pointer proposal made|responsive collapse follows|intrinsic geometry (changes|becomes invalid)" \
  --reporter=verbose
```

Observed: exit 1 with 5 failed tests. Untouched pointer collapse and keyboard
collapse incorrectly persisted `0`; a pointer proposal made while collapsed was
lost and rendered as `160px` after expansion; valid and invalid intrinsic geometry
changes did not release active pointer capture.

### Remaining-Findings GREEN And Verification

```bash
npm test -- src/features/notes/NotesImageAttachment.test.tsx --reporter=verbose
```

Exit 0: 1 test file passed, 22 tests passed, 0 failures, and no warnings. Blob URL
replacement, failure, and unmount behavior remains covered and green.

```bash
npx tsc --noEmit --pretty false
```

Exit 0 with no TypeScript errors.

```bash
npm run build
```

Exit 0. TypeScript and Vite completed successfully; 2,286 modules were
transformed.

The full frontend suite was not run. The focused component suite, standalone
TypeScript compilation, and production build were run while concurrent Notes
history/coordinator changes remained unstaged and untouched by this slice.

### Post-Commit Concurrent Verification Note

A fresh post-commit focused run again passed all 22 image component tests with no
warnings. A standalone TypeScript check also passed immediately before the final
build attempt. While those commands were running, concurrent unowned changes
introduced errors at `src/features/notes/useNotesWorkspace.ts:2094` and `:2096`
(`closing` and `session` on type `never`). The final build attempt and a subsequent
standalone TypeScript retry therefore exit 2 on only those two concurrent errors.

The successful production build above was completed after the owned component
changes and before those concurrent workspace edits appeared. No unowned file was
modified, staged, reverted, or committed by this image component slice.
