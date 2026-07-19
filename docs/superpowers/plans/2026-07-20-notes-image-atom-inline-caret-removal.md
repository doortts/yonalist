# Notes Image Atom Inline Caret and Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render an image as one character with left/right caret boundaries and conditional same-bullet lines, while making `Remove image` switch immediately to a text bullet without an `Image unavailable` frame.

**Architecture:** Keep the existing `before → atom → after` logical selection model. Empty text regions stay in the DOM as out-of-flow selection anchors, while a CSS caret is painted on the image frame's left or right edge; non-empty regions alone participate in grid flow. Apply the authoritative atomic image-removal presentation to the current coordinator owner before acknowledgement finishes, then let normal queue settlement confirm the same state.

**Tech Stack:** React 19, TypeScript, CSS Grid, Vitest, Testing Library, Tauri/WebKit smoke testing.

## Global Constraints

- The image remains one logical UTF-16 unit at `imageOffsetUtf16`.
- Before/after input stays inside the same note node and never creates a sibling node.
- Removing an image-only atom leaves an empty text bullet and preserves supporting note, children, and node metadata.
- Normal removal uses exactly one `applyImageAtomEdit` mutation, zero `removeAttachment` calls, and zero additional `loadWorkspace` calls.
- A normal keystroke adds zero asynchronous operations and zero JavaScript layout reads.
- Add zero runtime dependencies.
- Notes route gzip may increase by at most 2 KiB from the measured baseline 162,525 bytes, so the implementation ceiling is 164,573 bytes.
- A normal removal may show `Image unavailable` for zero frames.
- Clipboard copy/cut/paste work is intentionally deferred to a separate plan after this layout and deletion boundary is stable.

---

### Task 1: Character-style caret and conditional same-bullet rows

**Files:**
- Modify: `src/features/notes/ImageAtomEditor.tsx`
- Modify: `src/features/notes/notes.css`
- Test: `src/features/notes/ImageAtomEditor.test.tsx`

**Interfaces:**
- Consumes: `validateImagePrimary(value)`, `LogicalSelection`, existing `before`, `atom`, and `after` DOM regions.
- Produces: `data-image-atom-empty="true"` on empty text regions and `data-image-atom-caret-side="before" | "after"` on the host only for an empty collapsed atom boundary.

- [x] **Step 1: Write failing editor state tests**

Add tests that render `draft={{ title: "", imageOffsetUtf16: 0 }}` and assert both regions are marked empty. Restore `{ anchorUtf16: 0, focusUtf16: 0 }`, dispatch `selectionchange`, and expect the host caret side to be `before`; repeat with offset `1` for `after`.

```tsx
it("maps image-only collapsed selections to the image's left and right caret edges", () => {
  const { host, handle } = renderEditor({
    draft: { title: "", note: "support", imageOffsetUtf16: 0 }
  });
  const [before, , after] = host.querySelectorAll<HTMLElement>(
    "[data-image-atom-region]"
  );
  expect(before).toHaveAttribute("data-image-atom-empty", "true");
  expect(after).toHaveAttribute("data-image-atom-empty", "true");

  act(() => {
    handle.current!.restoreSelection({ anchorUtf16: 0, focusUtf16: 0 });
    document.dispatchEvent(new Event("selectionchange"));
  });
  expect(host).toHaveAttribute("data-image-atom-caret-side", "before");

  act(() => {
    handle.current!.restoreSelection({ anchorUtf16: 1, focusUtf16: 1 });
    document.dispatchEvent(new Event("selectionchange"));
  });
  expect(host).toHaveAttribute("data-image-atom-caret-side", "after");
});
```

Add a second test that inputs one character before, rerenders with the emitted draft, and verifies only the before marker disappears; then deletes that character and verifies the marker returns. Repeat for the after side and assert `onEnter` is never called.

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm test -- src/features/notes/ImageAtomEditor.test.tsx
```

Expected: FAIL because the empty and caret-side data attributes do not exist.

- [x] **Step 3: Add the minimal semantic caret state**

In `ImageAtomEditor.tsx`, replace the atom-only selection UI state with one state object so one `selectionchange` causes at most one React update.

```ts
type ImageAtomSelectionUi = {
  readonly atomSelected: boolean;
  readonly caretSide: "before" | "after" | null;
};

function selectionUi(
  value: ImagePrimaryValue,
  selection: LogicalSelection | null,
  beforeEmpty: boolean,
  afterEmpty: boolean
): ImageAtomSelectionUi {
  if (!selection) return { atomSelected: false, caretSide: null };
  const collapsed = selection.anchorUtf16 === selection.focusUtf16;
  return {
    atomSelected: isAtomSelection(value, selection),
    caretSide:
      collapsed && beforeEmpty && selection.focusUtf16 === value.imageOffsetUtf16
        ? "before"
        : collapsed && afterEmpty &&
            selection.focusUtf16 === value.imageOffsetUtf16 + 1
          ? "after"
          : null
  };
}
```

Set `data-image-atom-caret-side` on the host and `data-image-atom-empty` on each text region from `segments.beforeText.length === 0` and `segments.afterText.length === 0`.

- [x] **Step 4: Make empty anchors out-of-flow and paint the visible caret**

Add CSS with no JavaScript geometry reads:

```css
.notes-image-atom-editor {
  position: relative;
}

.notes-image-atom-editor
  [data-image-atom-region][data-image-atom-empty="true"] {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  padding: 0;
  overflow: hidden;
  line-height: 1px;
  caret-color: transparent;
}

.notes-image-atom-editor:focus[data-image-atom-caret-side="before"]
  .notes-image-attachment-frame::before,
.notes-image-atom-editor:focus[data-image-atom-caret-side="after"]
  .notes-image-attachment-frame::after {
  content: "";
  position: absolute;
  inset-block-start: 2px;
  block-size: 1.2em;
  inline-size: 1px;
  background: currentColor;
  pointer-events: none;
}
```

Place `::before` at the frame's inline start and `::after` at its inline end. Keep the non-empty page and row typography rules unchanged. Because absolute grid children create no tracks, the image is row 1 when `before` is empty, row 2 when it is non-empty, and `after` becomes the next row only when non-empty.

- [x] **Step 5: Verify GREEN and commit**

Run:

```bash
npm test -- src/features/notes/ImageAtomEditor.test.tsx src/features/notes/imageAtomDomSelection.test.ts
git diff --check
```

Expected: both files pass and the diff check is silent.

Commit:

```bash
git add src/features/notes/ImageAtomEditor.tsx src/features/notes/ImageAtomEditor.test.tsx src/features/notes/notes.css
git commit -m "fix(notes): place image atom carets at inline edges"
```

---

### Task 2: Apply image removal presentation before acknowledgement

**Files:**
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts`
- Test: `src/features/notes/useNotesWorkspace.navigation.test.tsx`
- Test: `src/features/notes/notesWorkspaceCoordinator.test.ts`

**Interfaces:**
- Consumes: `NotesWorkspaceCoordinatorSession.settleAuthoritativePresentation(workspace, snapshot)` and the existing session `applyHistoryLocation` callback.
- Produces: the active owner applies the authoritative text-node workspace synchronously when atomic settlement begins; queue completion remains the history acknowledgement boundary.

- [ ] **Step 1: Write a failing pending-ack regression test**

Extend the existing image-atom edit hook test with a deferred `ackImageAtomOperation`. Start removal without awaiting it, wait until acknowledgement begins, and assert the hook already exposes a text node and no attachment while the acknowledgement promise remains pending.

```tsx
const acknowledgement = deferred<void>();
const store = repository({
  loadWorkspace: vi.fn().mockResolvedValue(initial),
  applyImageAtomEdit: vi.fn(async (_root, _input, context) =>
    imageAtomMutationResult(settled, context, imageNodeId)
  ),
  ackImageAtomOperation: vi.fn(() => acknowledgement.promise)
});

let removal!: Promise<NotesWorkspaceCommandOutcome>;
act(() => {
  removal = rendered.result.current.actions.applyImageAtomEdit(
    imageNodeId,
    { anchorUtf16: 6, focusUtf16: 7 },
    { kind: "remove", replacementText: "" }
  );
});
await waitFor(() => expect(store.ackImageAtomOperation).toHaveBeenCalledOnce());
expect(rendered.result.current.state.nodesById[imageNodeId]?.nodeKind).toBe("text");
expect(rendered.result.current.state.attachmentsByNodeId[imageNodeId] ?? []).toEqual([]);
expect(store.loadWorkspace).toHaveBeenCalledOnce();

await act(async () => acknowledgement.resolve());
await expect(removal).resolves.toBe("committed");
```

- [ ] **Step 2: Run the regression test and verify RED**

Run:

```bash
npm test -- src/features/notes/useNotesWorkspace.navigation.test.tsx -t "image-atom edit"
```

Expected: FAIL while acknowledgement is pending because the current session still exposes `nodeKind: "image"`.

- [ ] **Step 3: Apply the canonical presentation to the current owner**

In `notesWorkspaceCoordinator.ts`, remove the current-owner shortcut and use the existing presentation callback for every owner candidate.

```ts
const candidate = entry.owner;
const applied = candidate ? applyPresentationTo(entry, candidate) : false;
```

On success, keep the existing `confirmAppliedPresentation`, `presentationBlocked`, and `pendingOwnerApply` updates. Do not add a reload, timer, optimistic attachment mutation, or new state channel.

- [ ] **Step 4: Lock the coordinator contract**

Add a coordinator-level test whose writable owner records `applyHistoryLocation` calls. Call `settleAuthoritativePresentation` on that same owner and assert one immediate call with the replacement workspace and snapshot. This protects the exact shortcut being removed.

```ts
it("applies a settled authoritative presentation to its current writable owner", async () => {
  const store = repository();
  const registry = createNotesWorkspaceCoordinatorRegistry();
  const pool = createNotesExpansionSnapshotPool();
  const applyHistoryLocation = vi.fn(() => true);
  const session = registry.openSession(
    writableOptions(
      pool,
      { repository: store, vaultRoot: "/current-owner-settlement", onEvent: vi.fn() },
      applyHistoryLocation
    )
  );
  await session.activation;
  applyHistoryLocation.mockClear();

  const replacement = normalizeWorkspace(workspace([node({ id: "replacement" })]));
  const snapshot = historySnapshot(pool, "replacement");
  session.settleAuthoritativePresentation(replacement, snapshot);

  expect(applyHistoryLocation).toHaveBeenCalledOnce();
  expect(applyHistoryLocation).toHaveBeenCalledWith(replacement, snapshot);
  pool.release(snapshot.expansion);
  session.close();
});
```

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
npm test -- src/features/notes/useNotesWorkspace.navigation.test.tsx src/features/notes/notesWorkspaceCoordinator.test.ts
git diff --check
```

Expected: both files pass; the pending acknowledgement assertion observes `text` without an extra workspace load.

Commit:

```bash
git add src/features/notes/notesWorkspaceCoordinator.ts src/features/notes/useNotesWorkspace.navigation.test.tsx src/features/notes/notesWorkspaceCoordinator.test.ts
git commit -m "fix(notes): project image removal before acknowledgement"
```

---

### Task 3: Cross-surface regression and quantitative verification

**Files:**
- Test: `src/features/notes/NotesAttachmentIngest.test.tsx`
- Test: `src/features/notes/NotesPageHeader.test.tsx`
- Verify: `src/features/notes/notes.css`
- Verify: `src/features/notes/ImageAtomEditor.tsx`

**Interfaces:**
- Consumes: Task 1 caret/layout attributes and Task 2 synchronous authoritative projection.
- Produces: row/header parity and measured evidence for the global constraints.

- [ ] **Step 1: Add row and page-header behavior tests**

For both outline and zoomed page renderers, cover these four drafts and assert the same empty-region markers:

```ts
[
  { title: "", imageOffsetUtf16: 0, expected: [true, true] },
  { title: "before", imageOffsetUtf16: 6, expected: [false, true] },
  { title: "after", imageOffsetUtf16: 0, expected: [true, false] },
  { title: "beforeafter", imageOffsetUtf16: 6, expected: [false, false] }
]
```

Use one assertion helper so row and header expectations cannot drift:

```ts
function expectImageAtomEmptyRegions(
  editor: HTMLElement,
  beforeEmpty: boolean,
  afterEmpty: boolean
): void {
  const before = editor.querySelector<HTMLElement>(
    '[data-image-atom-region="before"]'
  );
  const after = editor.querySelector<HTMLElement>(
    '[data-image-atom-region="after"]'
  );
  if (beforeEmpty) {
    expect(before).toHaveAttribute("data-image-atom-empty", "true");
  } else {
    expect(before).not.toHaveAttribute("data-image-atom-empty");
  }
  if (afterEmpty) {
    expect(after).toHaveAttribute("data-image-atom-empty", "true");
  } else {
    expect(after).not.toHaveAttribute("data-image-atom-empty");
  }
}
```

Retain the existing assertion that menu removal calls `applyImageAtomEdit` once and never calls row deletion. Add assertions that the selection is exactly the atom range and `removeAttachment` is not called.

- [ ] **Step 2: Run focused cross-surface tests**

Run:

```bash
npm test -- src/features/notes/ImageAtomEditor.test.tsx src/features/notes/NotesAttachmentIngest.test.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/useNotesWorkspace.navigation.test.tsx src/features/notes/notesWorkspaceCoordinator.test.ts
```

Expected: all focused tests pass with no unhandled warnings.

- [ ] **Step 3: Run the full automated gates in parallel where independent**

Run the full test suite first, then run the independent static/build gates concurrently:

```bash
npm test
npm run lint -- --quiet
npm run build:analyze
npm run test:architecture
npm run test:plans
git diff --check
```

Expected: all gates pass. `build:analyze` must report Notes route gzip at or below 164,573 bytes and within the repository's 165,751-byte budget.

- [ ] **Step 4: Run isolated Tauri/WebKit smoke verification**

Use a temporary Vault and a distinct test bundle identifier. Verify:

1. Image-only: the image is on the bullet's first line; left and right caret selections are both reachable.
2. Type before: text is line 1 and image is line 2.
3. Delete all before text: image returns to line 1.
4. Type after: image is line 1 and text is line 2 in the same bullet.
5. Choose `Remove image`: the text editor appears without any captured frame containing `Image unavailable`.
6. The resulting empty title, supporting note, and children remain present.

Do not touch the user's running Vault. Remove only the temporary smoke Vault and test screenshots after verification.

- [ ] **Step 5: Record performance deltas and commit test additions**

Report:

- baseline Notes route raw/gzip: 568,426 / 162,525 bytes
- final Notes route raw/gzip and exact byte/percentage delta
- backend mutation count, additional workspace load count, attachment deletion count
- runtime dependency delta
- observed `Image unavailable` frames

Commit:

```bash
git add src/features/notes/NotesAttachmentIngest.test.tsx src/features/notes/NotesPageHeader.test.tsx
git commit -m "test(notes): cover image atom inline layout and removal"
```
