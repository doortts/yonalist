<!-- reconciliation: auditedHead=ec8a9ff3d016449255992adf70e128ea5e222e9a status=complete -->
> **증거 대조 상태 (2026-07-19): 완료.** commit·artifact 근거는 [감사 ledger](../reports/2026-07-19-historical-plan-ledger.json)에 기록했다.

# Notes Inline Caret Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one click on ordinary Notes bullet-title text enter editing with the caret at the clicked UTF-16 position and without a title underline.

**Architecture:** Keep the mounted textarea plus tokenized presentation architecture. Add an opt-in pointer-caret policy to `NoteTextField`, resolve the presentation hit through the standard caret-position API with the WebKit range fallback, and apply the resulting collapsed selection after the textarea becomes visible. Enable the policy only for `OutlineNodeRow` titles and remove only the editing textarea's underline.

**Tech Stack:** React 19, TypeScript, DOM Range/Caret APIs, Vitest, Testing Library, Tauri 2, CSS.

## Global Constraints

- Apply click-position editing only to active outline bullet titles.
- Keep page-library rename, page-header title, and supporting-note behavior unchanged.
- Keep tag filtering, date editing, bullet Zoom, collapse, and action-menu behavior unchanged.
- Keep keyboard Enter/Space editing entry unchanged, and retain focus indication on the resting title presentation and command controls.
- Do not replace the editor with `contenteditable`.
- Treat offsets as UTF-16 indices because textarea selection APIs use UTF-16.
- Do not modify or stage `docs/superpowers/specs/2026-07-12-notes-trash-history-and-library-rename-design.md`.

---

### Task 1: Pointer Hit Testing And Caret Placement

**Files:**
- Modify: `src/features/notes/NoteTextField.tsx:1-230`
- Test: `src/features/notes/NoteTextField.test.tsx`

**Interfaces:**
- Consumes: `NoteTextFieldProps`, the resting `.notes-token-text` element, `Document.caretPositionFromPoint`, `Document.caretRangeFromPoint`, and the mounted textarea.
- Produces: optional `placeCaretFromPointer?: boolean` on `NoteTextFieldProps`; internal `resolvePointerCaretOffset(root: HTMLElement, clientX: number, clientY: number, fallback: number): number` behavior.

- [x] **Step 1: Add failing pointer-caret tests**

Add tests that stub the browser hit-testing APIs and activate the presentation through a pointer event:

```tsx
it("places the editing caret at the clicked UTF-16 text position", () => {
  const original = document.caretPositionFromPoint;
  const { container } = render(
    <NoteTextField
      placeCaretFromPointer
      value="A😀BC"
      aria-label="Edit title"
      onChange={vi.fn()}
      onTagClick={vi.fn()}
    />
  );
  const presentation = container.querySelector(".notes-token-text")!;
  const textNode = presentation.firstChild!;
  document.caretPositionFromPoint = vi.fn(() => ({
    offsetNode: textNode,
    offset: 3,
    getClientRect: vi.fn()
  } as CaretPosition));

  fireEvent.pointerDown(presentation, { clientX: 32, clientY: 12 });

  const textarea = screen.getByRole("textbox", { name: "Edit title" });
  expect(textarea).toHaveFocus();
  expect(textarea).toHaveProperty("selectionStart", 3);
  expect(textarea).toHaveProperty("selectionEnd", 3);
  document.caretPositionFromPoint = original;
});
```

Add a WebKit fallback test by making `caretPositionFromPoint` unavailable and stubbing `caretRangeFromPoint` with a range whose `startContainer` is the presentation text node and `startOffset` is `2`. Expect selection `2..2`.

Add an invalid-hit fallback test whose hit node is outside the presentation. For value `"Plan"`, expect selection `4..4`.

Add a non-opt-in regression test that spies on the textarea's `setSelectionRange`, pointer-activates the presentation without `placeCaretFromPointer`, and verifies no pointer-derived selection is assigned.

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run src/features/notes/NoteTextField.test.tsx --maxWorkers=1
```

Expected: the new tests fail because `placeCaretFromPointer` and pointer hit-position application do not exist.

- [x] **Step 3: Add the opt-in property and hit-position resolver**

Extend `NoteTextFieldProps`:

```ts
placeCaretFromPointer?: boolean;
```

Add a document compatibility type and a resolver near `setForwardedRef`:

```ts
interface CaretDocument extends Document {
  caretPositionFromPoint?: (
    x: number,
    y: number
  ) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
}

function textOffsetWithin(
  root: HTMLElement,
  node: Node,
  nodeOffset: number
): number | null {
  if (node !== root && !root.contains(node)) return null;
  try {
    const range = root.ownerDocument.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, nodeOffset);
    return range.toString().length;
  } catch {
    return null;
  }
}

function resolvePointerCaretOffset(
  root: HTMLElement,
  clientX: number,
  clientY: number,
  fallback: number
): number {
  const documentWithCaret = root.ownerDocument as CaretDocument;
  const position = documentWithCaret.caretPositionFromPoint?.(clientX, clientY);
  const range = position
    ? null
    : documentWithCaret.caretRangeFromPoint?.(clientX, clientY);
  const offset = position
    ? textOffsetWithin(root, position.offsetNode, position.offset)
    : range
      ? textOffsetWithin(root, range.startContainer, range.startOffset)
      : null;
  return Math.max(0, Math.min(fallback, offset ?? fallback));
}
```

- [x] **Step 4: Apply the resolved selection after reveal**

Destructure `placeCaretFromPointer`, add `selectionAfterRevealRef`, and update the reveal layout effect:

```ts
const selectionAfterRevealRef = useRef<number | null>(null);

const textarea = textareaRef.current;
textarea?.focus();
const selection = selectionAfterRevealRef.current;
selectionAfterRevealRef.current = null;
if (textarea && selection !== null) {
  textarea.setSelectionRange(selection, selection);
}
```

Update the presentation pointer handler:

```ts
if (placeCaretFromPointer) {
  selectionAfterRevealRef.current = resolvePointerCaretOffset(
    event.currentTarget,
    event.clientX,
    event.clientY,
    value.length
  );
}
event.preventDefault();
revealAndFocusTextarea();
```

Clear `selectionAfterRevealRef` when the field becomes noneditable. Do not set it from the keyboard handler.

- [x] **Step 5: Run the focused tests and verify GREEN**

Run:

```bash
npx vitest run src/features/notes/NoteTextField.test.tsx --maxWorkers=1
```

Expected: all `NoteTextField` tests pass, including exact UTF-16, WebKit fallback, invalid-hit fallback, and non-opt-in behavior.

- [x] **Step 6: Commit Task 1**

```bash
git add src/features/notes/NoteTextField.tsx src/features/notes/NoteTextField.test.tsx
git commit -m "feat(notes): place caret at clicked title position"
```

---

### Task 2: Outline Wiring And Underline Removal

**Files:**
- Modify: `src/features/notes/OutlineNodeRow.tsx:600-680`
- Modify: `src/features/notes/notes.css:1413-1435`
- Test: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**
- Consumes: `NoteTextFieldProps.placeCaretFromPointer` from Task 1.
- Produces: click-position editing for outline title fields only; title textarea focus without a bottom box-shadow.

- [x] **Step 1: Add a failing outline integration test**

In `NotesWorkspace.test.tsx`, render a node titled `"Alpha 😀 omega"`, stub `document.caretPositionFromPoint` to return the resting title text node and UTF-16 offset `8`, then pointer-activate that title presentation:

```tsx
const presentation = screen.getByRole("group", { name: "Edit node title" });
const textNode = presentation.firstChild!;
document.caretPositionFromPoint = vi.fn(() => ({
  offsetNode: textNode,
  offset: 8,
  getClientRect: vi.fn()
} as CaretPosition));

fireEvent.pointerDown(presentation, { clientX: 80, clientY: 20 });

const title = screen.getByRole("textbox", { name: "Edit node title" });
expect(title).toHaveFocus();
expect(title.selectionStart).toBe(8);
expect(title.selectionEnd).toBe(8);
```

Restore the original document API in `finally` or `afterEach`. Assert that a supporting-note field rendered in the same workspace does not receive the opt-in pointer selection.

- [x] **Step 2: Run the integration test and verify RED**

Run:

```bash
npx vitest run src/features/notes/NotesWorkspace.test.tsx --maxWorkers=1 -t "clicked title position"
```

Expected: FAIL because `OutlineNodeRow` has not enabled `placeCaretFromPointer`.

- [x] **Step 3: Enable click-position editing only on outline titles**

Add the property to the title field in `OutlineNodeRow`:

```tsx
<NoteTextField
  placeCaretFromPointer
  className="notes-node-title"
  containerClassName="notes-node-title-field"
  // existing props remain unchanged
/>
```

Do not add the property to the supporting-note `NoteTextField`, `NotesPageHeader`, or library rename input.

- [x] **Step 4: Remove only the focused title textarea underline**

Replace:

```css
.notes-node-title:focus-visible {
  outline: 0;
  box-shadow: inset 0 -2px 0 var(--accent);
}
```

with:

```css
.notes-node-title:focus-visible {
  outline: 0;
  box-shadow: none;
}
```

Keep `.notes-node-note:focus-visible`, token presentation focus styles, and command-control focus styles unchanged.

- [x] **Step 5: Run integration and focused regression tests**

Run:

```bash
npx vitest run \
  src/features/notes/NoteTextField.test.tsx \
  src/features/notes/NotesWorkspace.test.tsx \
  src/features/notes/NotesDatePickerIntegration.test.tsx \
  --maxWorkers=1
```

Expected: all tests pass. Tag/date activation and keyboard editing tests remain green.

- [x] **Step 6: Commit Task 2**

```bash
git add src/features/notes/OutlineNodeRow.tsx src/features/notes/notes.css src/features/notes/NotesWorkspace.test.tsx
git commit -m "fix(notes): edit bullets without a focus underline"
```

---

### Task 3: Full Verification, Visual QA, And Review

**Files:**
- Review: `src/features/notes/NoteTextField.tsx`
- Review: `src/features/notes/OutlineNodeRow.tsx`
- Review: `src/features/notes/notes.css`
- Review: `src/features/notes/NoteTextField.test.tsx`
- Review: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**
- Consumes: completed click-position implementation from Tasks 1 and 2.
- Produces: verified build, native visual evidence, and an adversarial review verdict.

- [x] **Step 1: Run all Notes tests**

```bash
npx vitest run src/features/notes --maxWorkers=1
```

Expected: all active Notes tests pass; existing intentionally skipped tests remain skipped.

- [x] **Step 2: Run the full frontend suite and product build**

```bash
npm test -- --maxWorkers=1
npm run build
```

Expected: both commands exit `0`. The existing large-chunk warning may remain, but no new TypeScript or Vite error is allowed.

- [x] **Step 3: Run source hygiene checks**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors. The only unrelated worktree change remains `docs/superpowers/specs/2026-07-12-notes-trash-history-and-library-rename-design.md`.

- [x] **Step 4: Run native visual and interaction verification**

Start the latest desktop app:

```bash
npm run tauri:dev
```

Verify in the active Notes outline:

1. Click before, inside, and after ordinary title text; the caret appears at each clicked position.
2. Click a title containing Korean and an emoji; the caret remains at a valid character boundary.
3. Confirm no underline appears while the title is editing.
4. Confirm tag click, date click, bullet Zoom, collapse, and menu still execute their original actions.
5. Confirm the supporting note keeps its previous activation behavior.

Capture a native window screenshot showing an editing title without an underline.

- [x] **Step 5: Request adversarial code review**

Give a read-only reviewer the implementation range and require findings-first review of:

- UTF-16 offset correctness and Range containment.
- WebKit fallback behavior.
- pointer versus keyboard activation separation.
- tag/date event isolation.
- disabled/read-only behavior.
- stale selection ref cleanup.
- visual focus and keyboard accessibility regressions.

Fix every Critical or Important finding, rerun the affected tests, and request a fresh re-review until approved.

- [x] **Step 6: Record final verification**

Update the execution ledger with exact test counts, build status, screenshot path, reviewer verdict, and any residual risk. Do not commit generated review packages or screenshots.
