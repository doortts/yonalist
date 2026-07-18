# Empty Supporting Note Auto-Collapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse a revealed supporting-note editor after ordinary blur when its value is empty or whitespace-only, in both outline rows and the zoomed page header.

**Architecture:** Retain each component's existing local reveal state and draft queue. At the existing blur boundary, use the textarea's live value, normalize whitespace-only input to `""`, flush through the current action, and clear only that component's reveal state; date-picker-owned blur remains untouched.

**Tech Stack:** React 19, TypeScript 6, Vitest, Testing Library.

## Global Constraints

- Implement the approved contract in `docs/superpowers/specs/2026-07-18-empty-supporting-note-auto-collapse-design.md`.
- Apply identical user-visible behavior to `OutlineNodeRow` and `NotesPageHeader`.
- Keep an empty note mounted while it owns focus.
- Collapse only after a blur for which `datePicker.shouldSuppressBlur()` is false.
- Defer blur-time normalization, flushing, and collapse while the supporting note is composing; settle the final live value after `compositionend`.
- Normalize whitespace-only note input to the empty string before flushing.
- Preserve existing nonempty note, `Shift+Enter`, pending-focus, keyboard navigation, and date-picker behavior.
- Do not add a shared abstraction, CSS change, schema change, dependency, or image-atom implementation.
- Follow RED/GREEN: observe each focused regression test fail for the missing behavior before modifying production code.

---

### Task 1: Collapse empty row and page-header supporting notes on blur

**Files:**

- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/NotesPageHeader.tsx`
- Test: `src/features/notes/NotesWorkspace.test.tsx`
- Test: `src/features/notes/NotesPageHeader.test.tsx`

**Interfaces:**

- Consumes: existing `noteOpen`, `setNoteOpen`, `revealedNoteNodeId`, `setRevealedNoteNodeId`, `actions.updateNodeDraft`, `actions.flushNodeDraft`, `commitDrafts`, and `datePicker.shouldSuppressBlur()`.
- Produces: no new public interface; only blur-time visibility and normalization behavior changes.

- [ ] **Step 1: Write the failing row tests**

Extend the empty-row-note coverage so a freshly revealed note remains visible while focused and disappears after an ordinary blur:

```tsx
const note = getTextareaByName("Supporting note: Outside branch");
expect(note).toHaveFocus();
fireEvent.blur(note);
await waitFor(() =>
  expect(
    queryTextareaByName("Supporting note: Outside branch")
  ).not.toBeInTheDocument()
);
```

Add a separate test that clears a persisted row note, enters whitespace, blurs it, and asserts both that the editor disappears and that the store receives `note: ""` through the existing history-aware update path.

Add an IME regression: start composition in a revealed empty row note, blur it, and assert it remains mounted. End composition with committed text and assert the row remains mounted and the final text is sent to `updateNodeDraft` before `flushNodeDraft`.

- [ ] **Step 2: Verify the row tests are RED**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "supporting note"
```

Expected: the new collapse assertion fails because `noteOpen` remains true, and the whitespace case fails because the draft currently retains whitespace.

- [ ] **Step 3: Write the failing page-header tests**

Replace the legacy test named `keeps a revealed page note mounted after its draft becomes empty` with a test that rerenders the empty draft, blurs the live textarea, and expects it to be unmounted while preserving the existing `flushNodeDraft("project")` assertion. Assert `updateNodeDraft` receives an empty note when the live value is whitespace-only.

Add or extend a date-picker integration case: reveal an empty page note through `Add date`, confirm the `Choose date` dialog is open, blur the note while that picker owns the target, and assert the empty textarea remains mounted.

Add the matching page-header IME regression for blur during composition followed by `compositionend`. Cover both the committed-text case and an empty final value that collapses only after composition ends.

- [ ] **Step 4: Verify the page-header tests are RED**

Run:

```bash
npm test -- src/features/notes/NotesPageHeader.test.tsx -t "note"
```

Expected: the ordinary-blur collapse test fails because `revealedNoteNodeId` remains the current node. The date-picker assertion remains green and guards the exception.

- [ ] **Step 5: Implement the minimal row blur branch**

Add two local refs beside the existing note refs:

```tsx
const noteComposingRef = useRef(false);
const noteBlurredDuringCompositionRef = useRef(false);
```

In the supporting `NoteTextField` blur handler, read `event.currentTarget.value`. If the date picker suppresses blur, return. If `noteComposingRef.current` is true, set `noteBlurredDuringCompositionRef.current = true` and return without unmounting. Otherwise:

```tsx
const value = event.currentTarget.value;
if (value.trim().length === 0) {
  setNoteOpen(false);
  if (value.length > 0) {
    actions.updateNodeDraft(
      nodeId,
      { title: titleValue, note: "" },
      "note"
    );
  }
}
commitDrafts();
```

Call `commitDrafts()` after the optional normalization update so the established draft queue performs the flush. Do not introduce timers or a new helper module.

Wire `onCompositionStart` to set the composing ref. In `onCompositionEnd`, clear it and, only when a blur was deferred and the textarea is still unfocused, apply the same normalization/collapse decision to `event.currentTarget.value`. Explicitly update the draft with that final live value before flushing so the committed IME text cannot be lost.

- [ ] **Step 6: Implement the minimal page-header blur branch**

Add the same two local composition refs to the page header. At the existing page-note blur handler, return when the date picker suppresses blur; defer when composition is active. Otherwise read the live value, clear `revealedNoteNodeId` when `value.trim().length === 0`, normalize nonempty whitespace to `""` through `updateNodeDraft`, then invoke the existing `flushNodeDraft(nodeId)` call. Nonempty values keep the reveal state unchanged.

On deferred `compositionend`, update the page draft from the final live value, apply the same collapse decision, and flush once. Reset the deferred flag on focus and after settlement so a later composition cannot inherit it.

- [ ] **Step 7: Verify focused GREEN and adjacent regressions**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesPageHeader.test.tsx
```

Expected: both suites pass with no unexpected warnings. Confirm the pre-existing `Shift+Enter`, keyboard exit, nonempty blur, date picker, and remove-note tests remain green.

- [ ] **Step 8: Run static and full frontend verification**

Run:

```bash
npm run lint
npm run build
npm test
git diff --check
```

Expected: all commands pass. Record exact pass/skip counts in the task report.

- [ ] **Step 9: Self-review and commit**

Check the diff against every global constraint, ensure no unrelated files changed, then commit only the four implementation/test files:

```bash
git add src/features/notes/OutlineNodeRow.tsx src/features/notes/NotesPageHeader.tsx src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesPageHeader.test.tsx
git commit -m "fix(notes): collapse empty supporting notes"
```
