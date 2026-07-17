# Notes Drag Preview Card and Image Thumbnail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render one plain card for a one-item drag, keep the stacked counted card for a multi-item forest, and reuse a ready image root's rendered URL as a small drag thumbnail.

**Architecture:** Extend the existing preview component with one optional thumbnail URL and make its multi-card decoration conditional on the authoritative forest count. Freeze the representative row's already-rendered image URL in the existing drag presentation snapshot, avoiding attachment reads, URL creation, resizing, or a new thumbnail cache.

**Tech Stack:** React 19, TypeScript 6, CSS, dnd-kit, Testing Library, Vitest

## Global Constraints

- `total === 1` must show one card without backing sheets or a count badge.
- `total > 1` must retain backing sheets and show the full unique dragged-forest count.
- A parent plus descendants counts as multiple items even when there is one command root.
- Only an already-rendered image root URL may be reused; drag start must not load bytes, create object URLs, or resize images.
- Loading, missing, failed, or offscreen images must immediately fall back to the filename label.
- The overlay remains `aria-hidden`, non-interactive, pointer-offset, and does not change move/Undo behavior.
- No dependency, persistent thumbnail cache, or secondary overlay component may be added.

---

## File Structure

- `src/features/notes/NotesSelectionDragPreview.tsx`: render one/many card states and an optional decorative thumbnail.
- `src/features/notes/NotesSelectionDragPreview.test.tsx`: component contract for single, multiple, thumbnail, and fallback states.
- `src/features/notes/notes.css`: condition stacked decoration by data attributes and size the thumbnail.
- `src/features/notes/NotesOutlinePane.tsx`: freeze a representative rendered image URL in the existing presentation snapshot.
- `src/features/notes/NotesWorkspace.test.tsx`: prove a live image drag reuses the URL without extra attachment work and falls back while unloaded.

### Task 1: Render accurate single and multi preview cards

**Files:**
- Modify: `src/features/notes/NotesSelectionDragPreview.tsx:1-24`
- Modify: `src/features/notes/NotesSelectionDragPreview.test.tsx:1-38`
- Modify: `src/features/notes/notes.css:1144-1229`

**Interfaces:**
- Consumes: existing `labels: readonly string[]` and `total: number` props.
- Produces: optional `thumbnailSrc?: string`; `data-multiple="true"` only for multiple items and `data-thumbnail="true"` only when rendering an image.

- [ ] **Step 1: Add failing component tests**

Replace the single-item fallback test and extend the suite with:

```tsx
it("renders one plain card without a badge", () => {
  render(<NotesSelectionDragPreview labels={["Alpha"]} total={1} />);
  const preview = screen.getByTestId("notes-selection-drag-preview");
  expect(preview).not.toHaveAttribute("data-multiple");
  expect(
    preview.querySelector(".notes-selection-drag-preview-count")
  ).toBeNull();
  expect(screen.getByText("Alpha")).toBeInTheDocument();
});

it("marks a multi-item preview and shows the full count", () => {
  render(<NotesSelectionDragPreview labels={["Parent"]} total={4} />);
  const preview = screen.getByTestId("notes-selection-drag-preview");
  expect(preview).toHaveAttribute("data-multiple", "true");
  expect(within(preview).getByText("4")).toHaveClass(
    "notes-selection-drag-preview-count"
  );
});

it("renders a decorative non-draggable thumbnail", () => {
  render(
    <NotesSelectionDragPreview
      labels={["diagram.png"]}
      total={1}
      thumbnailSrc="blob:diagram"
    />
  );
  const thumbnail = screen.getByTestId("notes-selection-drag-thumbnail");
  expect(thumbnail).toHaveAttribute("src", "blob:diagram");
  expect(thumbnail).toHaveAttribute("alt", "");
  expect(thumbnail).toHaveAttribute("draggable", "false");
  expect(screen.queryByText("diagram.png")).toBeNull();
});

it("falls back to Untitled when no thumbnail or label is ready", () => {
  render(<NotesSelectionDragPreview labels={[""]} total={1} />);
  expect(screen.getByText("Untitled")).toBeInTheDocument();
});
```

Import `within` from Testing Library.

- [ ] **Step 2: Run the component test to verify it fails**

Run:

```bash
npm test -- src/features/notes/NotesSelectionDragPreview.test.tsx
```

Expected: failures show the single-item badge still exists, `data-multiple` is absent for the multi case, and `thumbnailSrc` is not a valid prop.

- [ ] **Step 3: Implement conditional card and thumbnail rendering**

Change the component to:

```tsx
export function NotesSelectionDragPreview({
  labels,
  total,
  thumbnailSrc
}: {
  labels: readonly string[];
  total: number;
  thumbnailSrc?: string;
}) {
  const multiple = total > 1;
  return (
    <div
      className="notes-selection-drag-preview"
      data-testid="notes-selection-drag-preview"
      data-multiple={multiple ? "true" : undefined}
      data-thumbnail={thumbnailSrc ? "true" : undefined}
      aria-hidden="true"
    >
      <div className="notes-selection-drag-preview-stack">
        <div
          className="notes-selection-drag-preview-row"
          data-thumbnail={thumbnailSrc ? "true" : undefined}
        >
          {thumbnailSrc ? (
            <img
              className="notes-selection-drag-preview-thumbnail"
              data-testid="notes-selection-drag-thumbnail"
              src={thumbnailSrc}
              alt=""
              draggable={false}
            />
          ) : (
            labels[0] || "Untitled"
          )}
        </div>
      </div>
      {multiple && (
        <span className="notes-selection-drag-preview-count">{total}</span>
      )}
    </div>
  );
}
```

Update CSS so the base card has no stack padding, backing sheets exist only for multiple items, and thumbnails stay small:

```css
.notes-selection-drag-preview {
  position: relative;
  min-width: 196px;
  max-width: min(280px, calc(100vw - 36px));
  color: var(--text-1);
  pointer-events: none;
}

.notes-selection-drag-preview[data-multiple="true"] {
  padding: 0 10px 10px 0;
}

.notes-selection-drag-preview[data-thumbnail="true"] {
  min-width: 0;
}

.notes-selection-drag-preview[data-multiple="true"]
  .notes-selection-drag-preview-stack::before,
.notes-selection-drag-preview[data-multiple="true"]
  .notes-selection-drag-preview-stack::after {
  position: absolute;
  inset: 0;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-card);
  content: "";
}

.notes-selection-drag-preview-row[data-thumbnail="true"] {
  padding: 4px;
}

.notes-selection-drag-preview-row[data-thumbnail="true"]::before {
  content: none;
}

.notes-selection-drag-preview-thumbnail {
  display: block;
  width: 96px;
  height: 64px;
  border-radius: 4px;
  object-fit: cover;
}
```

Keep the existing `::before` and `::after` transform rules and count badge rules unchanged after narrowing their shared selector as shown.

- [ ] **Step 4: Run component tests and CSS lint**

Run:

```bash
npm test -- src/features/notes/NotesSelectionDragPreview.test.tsx
npm run lint
```

Expected: the preview tests pass and ESLint exits 0.

- [ ] **Step 5: Commit the preview component**

```bash
git add src/features/notes/NotesSelectionDragPreview.tsx src/features/notes/NotesSelectionDragPreview.test.tsx src/features/notes/notes.css
git commit -m "feat(notes): distinguish single drag previews"
```

### Task 2: Freeze and reuse a rendered image URL

**Files:**
- Modify: `src/features/notes/NotesOutlinePane.tsx:229-252`
- Modify: `src/features/notes/NotesOutlinePane.tsx:2740-2840`
- Modify: `src/features/notes/NotesOutlinePane.tsx:3313-3323`
- Modify: `src/features/notes/NotesWorkspace.test.tsx:1830-2030`

**Interfaces:**
- Consumes: representative root ID from `PreparedOutlineSelectionDrag.nodeIds[0]` and a mounted `.notes-image-node-content img`.
- Produces: `NotesDragPresentationSnapshot.representativeThumbnailSrc?: string`, frozen when the drag session starts.

- [ ] **Step 1: Add failing workspace reuse and fallback tests**

Add this ready-image test next to the existing ordinary drag presentation tests:

```tsx
it("reuses a ready image URL in the drag preview without attachment work", async () => {
  const user = userEvent.setup();
  const imageNode = node({
    id: "diagram-image",
    nodeKind: "image",
    sortKey: 1,
    title: "diagram.png"
  });
  const imageAttachment = attachment({
    id: "diagram-attachment",
    nodeId: imageNode.id,
    originalName: "diagram.png"
  });
  configureRepository(
    [imageNode, node({ id: "target", sortKey: 2, title: "Target" })],
    { [imageNode.id]: [imageAttachment] }
  );
  notesStoreMock.readAttachmentBytes.mockResolvedValue(
    new Uint8Array([137, 80, 78, 71])
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  const createObjectURL = vi.fn(() => "blob:diagram");
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: createObjectURL
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn()
  });
  renderNotesWorkspace();

  await user.click(
    await screen.findByRole("button", { name: "Load image diagram.png" })
  );
  await screen.findByRole("img", { name: "diagram.png" });
  const imageBullet = screen.getByRole("button", {
    name: "Zoom into diagram.png"
  });
  const targetBullet = screen.getByRole("button", { name: "Zoom into Target" });
  mockOutlineRowRects();
  const readsBeforeDrag = notesStoreMock.readAttachmentBytes.mock.calls.length;
  const urlsBeforeDrag = createObjectURL.mock.calls.length;

  await user.pointer({
    keys: "[MouseLeft>]",
    target: imageBullet,
    coords: { clientX: 9, clientY: 14 }
  });
  await user.pointer({
    target: targetBullet,
    coords: { clientX: 14, clientY: 42 }
  });

  expect(screen.getByTestId("notes-selection-drag-thumbnail")).toHaveAttribute(
    "src",
    "blob:diagram"
  );
  expect(notesStoreMock.readAttachmentBytes).toHaveBeenCalledTimes(
    readsBeforeDrag
  );
  expect(createObjectURL).toHaveBeenCalledTimes(urlsBeforeDrag);

  await user.keyboard("[Escape]");
  await user.pointer({
    keys: "[/MouseLeft]",
    target: targetBullet,
    coords: { clientX: 14, clientY: 42 }
  });
});
```

Add the unloaded fallback test without clicking the image load button:

```tsx
it("uses the filename while a dragged image is not loaded", async () => {
  const user = userEvent.setup();
  const imageNode = node({
    id: "diagram-image",
    nodeKind: "image",
    sortKey: 1,
    title: "diagram.png"
  });
  const imageAttachment = attachment({
    id: "diagram-attachment",
    nodeId: imageNode.id,
    originalName: "diagram.png"
  });
  configureRepository(
    [imageNode, node({ id: "target", sortKey: 2, title: "Target" })],
    { [imageNode.id]: [imageAttachment] }
  );
  renderNotesWorkspace();
  const imageBullet = await screen.findByRole("button", {
    name: "Zoom into diagram.png"
  });
  const targetBullet = screen.getByRole("button", { name: "Zoom into Target" });
  mockOutlineRowRects();

  await user.pointer({
    keys: "[MouseLeft>]",
    target: imageBullet,
    coords: { clientX: 9, clientY: 14 }
  });
  await user.pointer({
    target: targetBullet,
    coords: { clientX: 14, clientY: 42 }
  });

  const preview = screen.getByTestId("notes-selection-drag-preview");
  expect(preview).toHaveTextContent("diagram.png");
  expect(screen.queryByTestId("notes-selection-drag-thumbnail")).toBeNull();
  expect(notesStoreMock.readAttachmentBytes).not.toHaveBeenCalled();

  await user.keyboard("[Escape]");
  await user.pointer({
    keys: "[/MouseLeft]",
    target: targetBullet,
    coords: { clientX: 14, clientY: 42 }
  });
});
```

- [ ] **Step 2: Run the workspace tests to verify they fail**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "image.*drag preview|dragged image"
```

Expected: the ready-image case cannot find `notes-selection-drag-thumbnail`; the unloaded fallback remains text-only.

- [ ] **Step 3: Extend the frozen snapshot with the existing rendered URL**

Add a DOM lookup beside `notesDragPresentationSnapshot` that does not require `CSS.escape` and does not load anything:

```ts
function renderedDragImageSource(
  root: ParentNode | null,
  nodeId: NoteId
): string | undefined {
  const row = Array.from(
    root?.querySelectorAll<HTMLElement>("[data-outline-id]") ?? []
  ).find((candidate) => candidate.dataset.outlineId === nodeId);
  const image = row?.querySelector<HTMLImageElement>(
    ".notes-image-node-content img"
  );
  return image?.currentSrc || image?.src || undefined;
}
```

Extend the snapshot interface/function:

```ts
interface NotesDragPresentationSnapshot {
  readonly forestNodeIds: readonly NoteId[];
  readonly representativeLabel: string;
  readonly representativeThumbnailSrc?: string;
}

function notesDragPresentationSnapshot(
  prepared: PreparedOutlineSelectionDrag,
  workspace: Pick<NormalizedNotesWorkspace, "nodesById">,
  representativeTitle?: string,
  representativeThumbnailSrc?: string
): NotesDragPresentationSnapshot {
  const representativeNode = workspace.nodesById[prepared.nodeIds[0]];
  return Object.freeze({
    forestNodeIds: preparedOutlineSelectionDragForestNodeIds(prepared),
    representativeLabel: representativeNode
      ? noteNodePresentationLabel(
          representativeNode,
          representativeTitle ?? representativeNode.title,
          "Untitled"
        )
      : "Untitled",
    representativeThumbnailSrc:
      representativeNode?.nodeKind === "image"
        ? representativeThumbnailSrc
        : undefined
  });
}
```

In each selected and ordinary drag branch, compute the URL once immediately after `visualPreparation` is ready:

```ts
const representativeThumbnailSrc = renderedDragImageSource(
  dropSurfaceRef.current,
  visualPreparation.nodeIds[0]
);
```

Pass that captured constant as the fourth argument to every snapshot construction in that branch, including the asynchronous selected-drag promotion callback. Finally pass it to the overlay:

```tsx
<NotesSelectionDragPreview
  labels={draggedNodeLabels}
  total={dragPresentation.forestNodeIds.length}
  thumbnailSrc={dragPresentation.representativeThumbnailSrc}
/>
```

- [ ] **Step 4: Run focused drag regressions**

Run:

```bash
npm test -- src/features/notes/NotesSelectionDragPreview.test.tsx src/features/notes/NotesWorkspace.test.tsx
```

Expected: both files pass, including parent forest count, frozen label, ready image reuse, unloaded fallback, cancellation, movement, and first-Undo cases already present in the workspace suite.

- [ ] **Step 5: Commit rendered thumbnail reuse**

```bash
git add src/features/notes/NotesOutlinePane.tsx src/features/notes/NotesWorkspace.test.tsx
git commit -m "feat(notes): preview dragged image thumbnails"
```

### Task 3: Verify the complete drag-preview change

**Files:**
- Verify only: all files changed in Tasks 1-2.

**Interfaces:**
- Consumes: the extended preview props and frozen drag snapshot.
- Produces: a verified low-cost single/multi/image drag presentation.

- [ ] **Step 1: Run the full frontend verification**

```bash
npm test
npm run lint
npm run build
```

Expected: every command exits 0; Vitest has no failures, ESLint reports no errors, and TypeScript/Vite produce `dist/`.

- [ ] **Step 2: Check the final diff**

```bash
git diff --check
git status --short
```

Expected: `git diff --check` prints nothing; status contains only the separately tracked plan/spec status changes if they have not yet been committed.
