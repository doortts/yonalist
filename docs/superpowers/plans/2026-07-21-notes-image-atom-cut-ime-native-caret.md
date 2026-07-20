# Notes Image Atom Cut, IME, and Native Caret Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make image-bullet cut reliable, preserve the first Korean IME composition, remove the selected-image outline, and use red Native carets including image boundaries placed 2px outside the rendered frame.

**Architecture:** Preserve the existing one-unit logical image atom and controlled `before → atom → after` DOM. Empty before/after regions remain real Native selection hosts but gain normal caret geometry only on the active focused side; attachment width is exposed as a CSS custom property so the after caret follows responsive frame width without per-frame DOM measurement. Text-only cut maps `deleteByCut` to a logical edit, while atom-containing copy/cut completes the existing byte-safe clipboard and structural edit pipeline.

**Tech Stack:** React 19, TypeScript, CSS Grid/absolute positioning, browser Clipboard/Selection/Composition events, Vitest, Testing Library, existing Notes image residency and image-atom command APIs.

## Global Constraints

- Every caret inside `ImageAtomEditor` is a browser Native caret colored with `var(--danger)`.
- Image boundary Native carets use browser-default width, height, and blinking.
- The before boundary coordinate is 2px before the rendered image frame; the after coordinate is 2px after its responsive rendered edge.
- No pseudo-element or JavaScript-measured visual caret may remain.
- The actual browser selection and composition DOM remain authoritative during IME.
- Text-only cut keeps native clipboard serialization; atom-containing cut deletes only after a byte-carrying clipboard write and current-authority check succeed.
- One successful atom cut is one Notes history command; failures never delete source content.
- No IPC, Rust, SQLite, filesystem format, dependency, or schema change.
- Existing paste, image menu, resize, lightbox, drag-and-drop, and Undo/Redo behavior remains unchanged.

---

### Task 1: Replace image-edge synthetic carets with Native caret hosts

**Files:**
- Modify: `src/features/notes/ImageAtomEditor.tsx`
- Modify: `src/features/notes/notes.css`
- Test: `src/features/notes/ImageAtomEditor.test.tsx`
- Test: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**
- Consumes: `imageAtomSelectionUi`, `writeImageAtomDomSelection`, `attachment.displayWidth`, existing `data-image-atom-empty` regions.
- Produces: `--notes-image-atom-frame-inline-size`, immediate caret-side synchronization in `restoreSelection`, persistent empty markers during composition, and CSS-only Native boundary positioning.

- [ ] **Step 1: Write the failing Native-caret DOM and CSS tests**

Update the image-only selection test so `restoreSelection` must expose the caret side without a synthetic `selectionchange`, retain both empty markers through `compositionstart`, and publish the responsive width variable:

```tsx
expect(host.style.getPropertyValue("--notes-image-atom-frame-inline-size"))
  .toBe("min(20px, 100%)");

act(() => handle.current!.restoreSelection({ anchorUtf16: 0, focusUtf16: 0 }));
expect(host).toHaveAttribute("data-image-atom-caret-side", "before");
fireEvent.compositionStart(host);
expect(before).toHaveAttribute("data-image-atom-empty", "true");
```

Add CSS source assertions requiring:

```ts
expect(notesStyles).toMatch(/caret-color:\s*var\(--danger\)/);
expect(notesStyles).toMatch(/inset-inline-start:\s*-2px/);
expect(notesStyles).toMatch(
  /inset-inline-start:\s*calc\(var\(--notes-image-atom-frame-inline-size\) \+ 2px\)/
);
expect(notesStyles).not.toMatch(/notes-image-attachment-frame::before/);
expect(notesStyles).not.toMatch(/notes-image-attachment-frame::after/);
```

Change the selected-atom presentation assertion to require no outline selector.

- [ ] **Step 2: Run RED**

Run:

```bash
npm test -- src/features/notes/ImageAtomEditor.test.tsx src/features/notes/NotesWorkspace.test.tsx
```

Expected: FAIL because the host has no frame-width variable, `restoreSelection` waits for `selectionchange`, composition removes the active empty marker, synthetic caret selectors still exist, and selected atoms still receive an outline.

- [ ] **Step 3: Implement immediate selection UI and Native boundary geometry**

Factor the existing selection UI calculation into one callback used by both `restoreSelection` and the document listener:

```ts
const commitSelectionUi = useCallback((selection: LogicalSelection | null) => {
  const value = valueRef.current;
  const next = imageAtomSelectionUi(
    value,
    selection,
    value.imageOffsetUtf16 === 0,
    value.imageOffsetUtf16 === value.title.length
  );
  setSelectionUiState((current) =>
    current.atomSelected === next.atomSelected && current.caretSide === next.caretSide
      ? current
      : next
  );
}, []);
```

Call it with the normalized value immediately after `writeImageAtomDomSelection`. Remove `compositionSide` state and make `data-image-atom-empty` depend only on the controlled segment length. Focus and restore the resting overlay selection in the pointer handler before returning from the event instead of a microtask.

Expose the responsive frame width on the host:

```tsx
style={{
  "--notes-image-atom-frame-inline-size":
    `min(${attachment.displayWidth}px, 100%)`
} as CSSProperties}
```

Replace the pseudo-element rules with Native caret rules:

```css
.notes-image-atom-editor {
  caret-color: var(--danger);
}

.notes-image-atom-editor:focus[data-image-atom-caret-side="before"]
  [data-image-atom-region="before"][data-image-atom-empty="true"],
.notes-image-atom-editor:focus[data-image-atom-caret-side="after"]
  [data-image-atom-region="after"][data-image-atom-empty="true"] {
  inset-block-start: 6px;
  block-size: auto;
  overflow: visible;
  line-height: inherit;
  caret-color: var(--danger);
}

.notes-image-atom-editor:focus[data-image-atom-caret-side="before"]
  [data-image-atom-region="before"][data-image-atom-empty="true"] {
  inset-inline-start: -2px;
}

.notes-image-atom-editor:focus[data-image-atom-caret-side="after"]
  [data-image-atom-region="after"][data-image-atom-empty="true"] {
  inset-inline-start: calc(var(--notes-image-atom-frame-inline-size) + 2px);
}
```

Delete the selected-atom outline rule while retaining `data-atom-selected` in the DOM.

- [ ] **Step 4: Run GREEN**

Run the Task 1 command again.

Expected: PASS; existing DOM selection, direction-key, accessibility, and composition tests remain green after updating assertions from synthetic materialization to persistent Native hosts.

- [ ] **Step 5: Commit**

```bash
git add src/features/notes/ImageAtomEditor.tsx src/features/notes/notes.css src/features/notes/ImageAtomEditor.test.tsx src/features/notes/NotesWorkspace.test.tsx
git commit -m "fix(notes): use native image edge carets"
```

### Task 2: Slice atom-containing logical selections

**Files:**
- Modify: `src/features/notes/imageAtomModel.ts`
- Test: `src/features/notes/imageAtomModel.test.ts`

**Interfaces:**
- Consumes: `ImagePrimaryValue`, `LogicalSelection`, `normalizeLogicalSelection`.
- Produces:

```ts
export interface SelectedImageAtomFragment {
  readonly beforeText: string;
  readonly afterText: string;
  readonly selection: LogicalSelection;
}

export function selectedImageAtomFragment(
  value: ImagePrimaryValue,
  selection: LogicalSelection
): SelectedImageAtomFragment | null;
```

- [ ] **Step 1: Write the failing selection-slice table**

Add cases for exact atom, before+atom, atom+after, whole mixed selection, reverse mixed selection, text-only miss, collapsed selection, and a surrogate pair adjacent to the atom:

```ts
expect(selectedImageAtomFragment(image("beforeafter", 6), {
  anchorUtf16: 3,
  focusUtf16: 10
})).toEqual({
  beforeText: "ore",
  afterText: "aft",
  selection: { anchorUtf16: 3, focusUtf16: 10 }
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
npm test -- src/features/notes/imageAtomModel.test.ts
```

Expected: FAIL because `selectedImageAtomFragment` is not exported.

- [ ] **Step 3: Implement the minimal pure slicer**

Normalize selection endpoints, sort them for document-order extraction, require `start <= imageOffsetUtf16 && end > imageOffsetUtf16`, slice selected before text up to the atom, slice selected after text from the atom using the atom's one logical unit, and preserve the normalized original direction in the returned `selection`.

- [ ] **Step 4: Run GREEN**

Run the Task 2 command again.

Expected: PASS with all existing UTF-16 and image-offset tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/features/notes/imageAtomModel.ts src/features/notes/imageAtomModel.test.ts
git commit -m "feat(notes): slice image atom selections"
```

### Task 3: Connect image-editor copy and cut ownership

**Files:**
- Modify: `src/features/notes/ImageAtomEditor.tsx`
- Test: `src/features/notes/ImageAtomEditor.test.tsx`

**Interfaces:**
- Consumes: `selectedImageAtomFragment`, `useNotesImageByteLease`, `writeNotesImageAtomClipboard`, `settleNotesImageAtomCut`, `NotesClipboardGlobals`.
- Extends `ImageAtomEditorProps` with:

```ts
readonly loadAttachmentBytes?: (attachmentId: string) => Promise<Uint8Array>;
readonly onAtomCut?: (selection: LogicalSelection) => Promise<boolean>;
readonly clipboardGlobals?: NotesClipboardGlobals;
```

- [ ] **Step 1: Write failing text-only and atom-containing clipboard tests**

Add tests proving:

```ts
selection(host, 1, 4);
beforeInput(host, "deleteByCut");
expect(onDraftChange).toHaveBeenLastCalledWith({
  title: "breafter",
  note: "support",
  imageOffsetUtf16: 3
});
```

For atom-containing selection, inject a complete clipboard globals object and real `DataTransfer`-compatible recorder. Assert copy writes selected `beforeText → image → afterText`; cut success invokes `onAtomCut` with the original direction. Add failure rows for resident bytes missing, clipboard rejection, stale selection, unavailable editor, and `onAtomCut` returning false.

- [ ] **Step 2: Run RED**

Run:

```bash
npm test -- src/features/notes/ImageAtomEditor.test.tsx
```

Expected: FAIL because `deleteByCut` is blocked without editing, copy/cut props do not exist, and image bytes are not prewarmed.

- [ ] **Step 3: Implement text-only logical deletion**

Handle `deleteByCut` before the unsupported-input fallback:

```ts
if (inputType === "deleteByCut") {
  event.preventDefault();
  if (selection && selection.anchorUtf16 !== selection.focusUtf16) {
    applyLogicalEdit("");
  }
  return;
}
```

Atom-containing cuts are prevented by their earlier `cut` event ownership, so this path handles native text-only deletion.

- [ ] **Step 4: Implement byte-safe atom copy/cut**

Prewarm the current attachment when selection first includes the atom. Build `NotesImageAtomCopyInput` from the selected fragment, persisted attachment authority, and resident bytes. Use injected globals when provided, otherwise use browser `navigator.clipboard`, `ClipboardItem`, and `Blob`.

In `onCopy`, own only atom-containing selections. In `onCut`, freeze the selection authority and call:

```ts
void settleNotesImageAtomCut(
  writeNotesImageAtomClipboard(input, globals, {}, event.nativeEvent),
  () => isSelectionAuthorityCurrent(frozenAuthority),
  async () => {
    if (!await onAtomCut?.(fragment.selection)) {
      throw new Error("Image atom cut was not committed.");
    }
  }
);
```

If bytes or a cut callback are unavailable, prevent native atom deletion and preserve the source. Release the leased attachment when its identity changes or the editor unmounts.

- [ ] **Step 5: Run GREEN**

Run the Task 3 command again.

Expected: PASS; unsupported `deleteByDrag` and HTML mutation repair remain blocked.

- [ ] **Step 6: Commit**

```bash
git add src/features/notes/ImageAtomEditor.tsx src/features/notes/ImageAtomEditor.test.tsx
git commit -m "fix(notes): connect image atom cut"
```

### Task 4: Commit atom cut through outline row and page header

**Files:**
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/NotesPageHeader.tsx`
- Test: `src/features/notes/NotesAttachmentIngest.test.tsx`
- Test: `src/features/notes/NotesPageHeader.test.tsx`

**Interfaces:**
- Consumes: `ImageAtomEditorProps.loadAttachmentBytes`, `ImageAtomEditorProps.onAtomCut`, `actions.applyImageAtomEdit`.
- Produces: a committed-result boolean returned to clipboard settlement for both editing surfaces.

- [ ] **Step 1: Write failing integration tests**

Render a real image editor through each surface with attachment loading and `applyImageAtomEdit` actions. Trigger the captured `onAtomCut` callback and assert:

```ts
await expect(onAtomCut(selection)).resolves.toBe(true);
expect(actions.applyImageAtomEdit).toHaveBeenCalledWith(nodeId, selection, {
  kind: "remove",
  replacementText: ""
});
```

Add a failed/skipped outcome row that resolves `false`, and assert `loadAttachmentBytes` is passed unchanged.

- [ ] **Step 2: Run RED**

Run:

```bash
npm test -- src/features/notes/NotesAttachmentIngest.test.tsx src/features/notes/NotesPageHeader.test.tsx
```

Expected: FAIL because the editor surfaces do not supply byte loading or committed cut callbacks.

- [ ] **Step 3: Connect the structural command**

For row and page header, flush the active editor, invoke one remove edit with the frozen selection, and return `true` only for `"committed"`:

```ts
const runImageAtomCut = async (selection: LogicalSelection) => {
  const flushResult = await imageEditorRef.current?.flush();
  if (flushResult !== "flushed") return false;
  return await actions.applyImageAtomEdit(nodeId, selection, {
    kind: "remove",
    replacementText: ""
  }) === "committed";
};
```

Pass `loadAttachmentBytes={actions.loadAttachmentBytes}` and `onAtomCut={runImageAtomCut}` only on writable surfaces. Preserve existing keyboard and menu removal wrappers.

- [ ] **Step 4: Run GREEN and owning regressions**

Run:

```bash
npm test -- src/features/notes/ImageAtomEditor.test.tsx src/features/notes/NotesAttachmentIngest.test.tsx src/features/notes/NotesPageHeader.test.tsx
```

Expected: PASS with paste priority, image removal, navigation, and focus tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/features/notes/OutlineNodeRow.tsx src/features/notes/NotesPageHeader.tsx src/features/notes/NotesAttachmentIngest.test.tsx src/features/notes/NotesPageHeader.test.tsx
git commit -m "fix(notes): commit image atom cuts"
```

### Task 5: Fresh user-visible verification and final frontend gate

**Files:**
- Modify only if runtime evidence exposes a regression in the owning files above.

**Interfaces:**
- Consumes: frozen production diff from Tasks 1–4.
- Produces: fresh Tauri runtime evidence and one final frontend gate result.

- [ ] **Step 1: Run focused acceptance tests**

```bash
npm test -- src/features/notes/imageAtomModel.test.ts src/features/notes/ImageAtomEditor.test.tsx src/features/notes/NotesAttachmentIngest.test.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesWorkspace.test.tsx
```

Expected: PASS with no new warnings.

- [ ] **Step 2: Build and restart a fresh Tauri app**

Use the repository's established desktop development command, confirm the bundle and process were rebuilt after the final diff, and use an isolated temporary Vault.

- [ ] **Step 3: Exercise the shortest real user path**

Verify both page-header and outline-row image bullets:

1. Place the Native caret before and after the image; confirm red color and visible 2px outside gap.
2. Type Korean on the first focus at both boundaries; confirm composed syllables appear once.
3. Select text only and use `Cmd+X`; confirm exact deletion and paste.
4. Select text plus image in both directions and use `Cmd+X`; confirm clipboard paste and one-step Undo restoration.
5. Confirm selected image has Native selection highlight but no extra blue outline.

- [ ] **Step 4: Freeze diff and run the frontend gate once**

```bash
npm test
npm run lint
npm run build
git diff --check
```

Expected: all commands exit 0. Skip Cargo tests, rustfmt, and Clippy because no Rust, IPC, persistence, or native configuration boundary changed.

- [ ] **Step 5: Review and commit any verified runtime-only correction**

If Step 3 required a correction, rerun its focused RED/GREEN proof before committing only the owning files. Otherwise make no additional commit.
