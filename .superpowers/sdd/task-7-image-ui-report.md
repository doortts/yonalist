# Task 7 Pure Image UI Slice Report

## Status

DONE_WITH_CONCERNS

Implementation commit: `16776c87fde96e204333ef637be58553165663ef`

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
