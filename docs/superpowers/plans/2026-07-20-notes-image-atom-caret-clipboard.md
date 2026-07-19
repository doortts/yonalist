# Notes Image Atom Caret and Clipboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep an empty image note visually image-only while preserving before/after carets, and make image-containing text selections safely copyable, cuttable, and pasteable at image or ordinary title carets.

**Architecture:** Keep the existing logical one-unit image atom and backend paste/edit commands. Add one pure selection slicer, make empty editor regions zero-layout rather than removing them, wire the existing byte-bound clipboard primitives to the image editor, and route marked internal image-atom paste ahead of generic image import for ordinary title textareas.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, CSS Grid, browser ClipboardEvent/DataTransfer, existing Notes image-atom commands and residency coordinator.

## Global Constraints

- The image remains one independent block row between logical `before` and `after` text rows.
- Empty before/after regions remain legal DOM caret targets but consume zero document-flow height.
- Typing before creates a text row above the image; typing after creates a text row below it.
- Image-containing forward and reverse selections preserve selected `text → image → text` document order.
- Cut deletes only after a byte-carrying clipboard write succeeds and frozen authority is still current.
- Clipboard failure, missing bytes, stale selection, or failed Notes command never deletes source content.
- Internal image-atom paste works in an image editor, an outline-row title, and a page title; supporting notes remain out of scope.
- Existing external image import, outline subtree paste, image menu, resize, lightbox, Undo/Redo, IPC schema, and storage limits remain unchanged.
- Do not add a dependency, global store, event bus, backend command, or schema migration.

---

### Task 1: Slice image-containing logical selections

**Files:**
- Modify: `src/features/notes/imageAtomModel.ts`
- Test: `src/features/notes/imageAtomModel.test.ts`

**Interfaces:**
- Consumes: `ImagePrimaryValue`, `LogicalSelection`, `normalizeLogicalSelection`, and `logicalToRawOffset`.
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

Add table-driven tests covering exact atom-only, before-text-plus-atom,
atom-plus-after-text, whole mixed selection, reverse mixed selection, a selection
that misses the atom, and a surrogate pair adjacent to the atom.

```ts
expect(
  selectedImageAtomFragment(image("beforeafter", 6), {
    anchorUtf16: 3,
    focusUtf16: 10
  })
).toEqual({
  beforeText: "ore",
  afterText: "aft",
  selection: { anchorUtf16: 3, focusUtf16: 10 }
});

expect(
  selectedImageAtomFragment(image("beforeafter", 6), {
    anchorUtf16: 2,
    focusUtf16: 4
  })
).toBeNull();
```

- [ ] **Step 2: Run RED**

Run: `npm test -- src/features/notes/imageAtomModel.test.ts`

Expected: FAIL because `selectedImageAtomFragment` is not exported.

- [ ] **Step 3: Implement the pure slicer**

Normalize the selection, sort its endpoints for document-order extraction, and
return `null` unless `start <= imageOffsetUtf16 && end > imageOffsetUtf16`.
Map `start` with `before` affinity and `end` with `after` affinity, slice only
the selected text on each side, and return the original normalized direction.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- src/features/notes/imageAtomModel.test.ts`

Expected: PASS with all existing UTF-16 model tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/features/notes/imageAtomModel.ts src/features/notes/imageAtomModel.test.ts
git commit -m "feat(notes): slice image atom clipboard selections"
```

### Task 2: Collapse only empty caret rows

**Files:**
- Modify: `src/features/notes/ImageAtomEditor.tsx`
- Modify: `src/features/notes/notes.css`
- Test: `src/features/notes/ImageAtomEditor.test.tsx`
- Test: `src/features/notes/NotesPageHeader.test.tsx`
- Test: `src/features/notes/NotesAttachmentIngest.test.tsx`

**Interfaces:**
- Consumes: current `before`, `atom`, `after` region structure and caret aids.
- Produces: `data-image-atom-empty="true"` only on empty text regions.

- [ ] **Step 1: Write failing empty-layout contract tests**

Assert an image-only editor has two empty markers and two caret aids, that its
atom has no empty marker, and that before/after typing removes only the matching
marker. Assert the row and page-header render paths expose the same contract.

```ts
expect(
  host.querySelectorAll('[data-image-atom-empty="true"]')
).toHaveLength(2);

act(() => handle.current!.restoreSelection({ anchorUtf16: 0, focusUtf16: 0 }));
beforeInput(host, "insertText", "A");
expect(
  host.querySelector('[data-image-atom-region="before"]')
).not.toHaveAttribute("data-image-atom-empty");
```

Read `notes.css` in the CSS assertion and require the empty selector to set
`block-size: 0`, `min-block-size: 0`, and `padding-block: 0` without hiding or
removing the region.

- [ ] **Step 2: Run RED**

Run: `npm test -- src/features/notes/ImageAtomEditor.test.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesAttachmentIngest.test.tsx`

Expected: FAIL because no empty marker or zero-layout rule exists.

- [ ] **Step 3: Mark empty regions and add zero-layout CSS**

Set the marker from `segments.beforeText.length === 0` and
`segments.afterText.length === 0`. Keep the regions and caret aids mounted.
Add the empty rule after the row/page typography rules so its zero block size
and zero padding win while `overflow: visible` keeps the native caret paintable.

- [ ] **Step 4: Run GREEN**

Run the Task 2 command again.

Expected: PASS; selection mapping and typing tests retain their current results.

- [ ] **Step 5: Commit**

```bash
git add src/features/notes/ImageAtomEditor.tsx src/features/notes/notes.css src/features/notes/ImageAtomEditor.test.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesAttachmentIngest.test.tsx
git commit -m "fix(notes): collapse empty image caret rows"
```

### Task 3: Wire byte-safe copy and cut to the image editor

**Files:**
- Modify: `src/features/notes/ImageAtomEditor.tsx`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/NotesPageHeader.tsx`
- Test: `src/features/notes/ImageAtomEditor.test.tsx`
- Test: `src/features/notes/NotesPageHeader.test.tsx`
- Test: `src/features/notes/NotesAttachmentIngest.test.tsx`

**Interfaces:**
- Consumes: `selectedImageAtomFragment`, `useNotesImageByteLease`,
  `writeNotesImageAtomClipboard`, `settleNotesImageAtomCut`, attachment identity,
  and `actions.loadAttachmentBytes`.
- Extends `ImageAtomEditorProps` with:

```ts
readonly loadAttachmentBytes?: (attachmentId: string) => Promise<Uint8Array>;
readonly onAtomCut?: (selection: LogicalSelection) => Promise<boolean>;
```

- [ ] **Step 1: Write failing editor clipboard tests**

Cover atom-only and mixed forward/reverse selection copy, text-only native
fallthrough, cut success, clipboard rejection, missing bytes, stale selection,
read-only copy without deletion, and one prewarm per attachment identity.

Use a clipboard stub whose `setData` records `text/plain`, `text/html`, and
`NOTES_IMAGE_ATOM_CLIPBOARD_MIME`. Verify exact atom selection serializes empty
`beforeText`/`afterText`; mixed selection serializes only selected side text.

```ts
const cut = fireEvent.cut(host, { clipboardData });
expect(cut).toBe(false);
await waitFor(() => expect(onAtomCut).toHaveBeenCalledWith({
  anchorUtf16: 3,
  focusUtf16: 10
}));
```

- [ ] **Step 2: Run RED**

Run: `npm test -- src/features/notes/ImageAtomEditor.test.tsx`

Expected: FAIL because copy/cut handlers and byte-loading props do not exist.

- [ ] **Step 3: Implement prewarm and clipboard event ownership**

When a semantic selection first contains the atom, register the editor as a
byte-lease owner and prewarm `attachment.id`. In `onCopy`/`onCut`, leave
atom-free selections untouched. For atom-containing selections, prevent native
DOM serialization, freeze value/attachment/selection authority, read resident
bytes, and start `writeNotesImageAtomClipboard` synchronously with the native
event.

For cut, pass the settlement to `settleNotesImageAtomCut`. Its current-authority
predicate must compare the frozen semantic selection authority, value, and
attachment. Its remove callback calls `onAtomCut`; treat a result other than
`true` as removal failure. Release the byte lease on attachment change/unmount.

- [ ] **Step 4: Connect committed structural removal in row and header**

Pass `actions.loadAttachmentBytes`. Implement `onAtomCut` by awaiting
`actions.applyImageAtomEdit(nodeId, selection, { kind: "remove", replacementText: "" })`
and return `outcome === "committed"`. Do not reuse the fire-and-forget keyboard
wrapper because cut settlement must know whether deletion actually committed.

- [ ] **Step 5: Run GREEN and integration regressions**

Run: `npm test -- src/features/notes/ImageAtomEditor.test.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesAttachmentIngest.test.tsx`

Expected: PASS; failed or stale clipboard writes never call the structural
remove action.

- [ ] **Step 6: Commit**

```bash
git add src/features/notes/ImageAtomEditor.tsx src/features/notes/OutlineNodeRow.tsx src/features/notes/NotesPageHeader.tsx src/features/notes/ImageAtomEditor.test.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesAttachmentIngest.test.tsx
git commit -m "feat(notes): cut and copy image atom selections"
```

### Task 4: Paste internal image atoms at ordinary title carets

**Files:**
- Modify: `src/features/notes/notesImageAtomClipboard.ts`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/NotesPageHeader.tsx`
- Test: `src/features/notes/notesImageAtomClipboard.test.ts`
- Test: `src/features/notes/NotesPageHeader.test.tsx`
- Test: `src/features/notes/NotesAttachmentIngest.test.tsx`
- Test: `src/features/notes/useNotesWorkspace.imageImport.test.tsx`

**Interfaces:**
- Extends `NotesImageAtomPasteCandidate` with `readonly internal: boolean`.
- `internal` is true only for an advertised/read private flavor or HTML carrying
  `data-yonalist-image-atom-v1`; ordinary native/HTML images remain external.
- Consumes existing `actions.applyImageAtomPaste(nodeId, selection, fragment)`
  for text-node conversion.

- [ ] **Step 1: Write failing candidate and title-paste tests**

Assert private MIME and marked HTML candidates are internal, unmarked native
images are not, and throwing data reads fail closed. In row/header tests, paste
an internally serialized atom into a selected title range and verify
`applyImageAtomPaste` receives the exact textarea UTF-16 selection and ordered
fragment. Verify ordinary external images still call `importClipboardImages`,
supporting-note behavior is unchanged, and text/subtree paste still falls
through correctly.

- [ ] **Step 2: Run RED**

Run: `npm test -- src/features/notes/notesImageAtomClipboard.test.ts src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesAttachmentIngest.test.tsx`

Expected: FAIL because candidates do not identify internal payloads and title
paste sends image carriers to generic import first.

- [ ] **Step 3: Add internal-candidate classification**

Compute `internal` in `readNotesImageAtomPasteCandidate` without parsing or
allocating image bytes. Preserve the existing `claimed` meaning so image-editor
and pane ownership do not change.

- [ ] **Step 4: Route marked title paste before generic import**

In each title handler, read the candidate first. If `internal` is false, keep
the existing external-image/subtree/default flow. If true, prevent default,
freeze `selectionStart`/`selectionEnd`, parse the candidate, flush the current
draft, and call `actions.applyImageAtomPaste` only for `kind === "imageAtom"`.
Do not route this branch from supporting notes.

- [ ] **Step 5: Run GREEN and command integration**

Run: `npm test -- src/features/notes/notesImageAtomClipboard.test.ts src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesAttachmentIngest.test.tsx src/features/notes/useNotesWorkspace.imageImport.test.tsx`

Expected: PASS; one backend paste command converts a text node at the frozen
caret, and external images retain the existing importer.

- [ ] **Step 6: Commit**

```bash
git add src/features/notes/notesImageAtomClipboard.ts src/features/notes/OutlineNodeRow.tsx src/features/notes/NotesPageHeader.tsx src/features/notes/notesImageAtomClipboard.test.ts src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesAttachmentIngest.test.tsx src/features/notes/useNotesWorkspace.imageImport.test.tsx
git commit -m "feat(notes): paste image atoms at title carets"
```

### Task 5: Verify the complete interaction and delivery gates

**Files:**
- Modify only if a focused RED exposes a defect in files already listed above.

**Interfaces:**
- Produces no new interface; verifies the approved design and prevents scope
  expansion.

- [ ] **Step 1: Run focused image/editor regression set**

```bash
npm test -- src/features/notes/imageAtomModel.test.ts src/features/notes/imageAtomDomSelection.test.ts src/features/notes/ImageAtomEditor.test.tsx src/features/notes/notesImageAtomClipboard.test.ts src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesAttachmentIngest.test.tsx src/features/notes/useNotesWorkspace.imageImport.test.tsx
```

Expected: PASS with zero failed tests.

- [ ] **Step 2: Run the frontend delivery gate**

```bash
npm test
npm run lint -- --quiet
npm run build
npm run test:architecture
git diff --check
```

Expected: all commands exit 0. `useNotesWorkspace.ts` remains within its current
architecture budget. Skip Cargo only if `git diff --name-only` confirms no Rust,
Tauri IPC, persistence schema, or native configuration change.

- [ ] **Step 3: Inspect repository state and requirement coverage**

Confirm the diff contains only the approved frontend/tests/docs files, no
dependency change, and no relaxed assertion or budget. Record any native Tauri
manual-test limitation without converting it to PASS.

- [ ] **Step 4: Commit any verification-only test correction**

If Step 1 or 2 required a focused correction, commit only that correction after
re-running its RED/GREEN test and the complete gate. If no correction was
required, create no empty verification commit.
