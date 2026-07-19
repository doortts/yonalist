<!-- reconciliation: auditedHead=ec8a9ff3d016449255992adf70e128ea5e222e9a status=complete -->
> **증거 대조 상태 (2026-07-19): 완료.** commit·artifact 근거는 [감사 ledger](../reports/2026-07-19-historical-plan-ledger.json)에 기록했다.

# Notes Single Menu Trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure that at most one left-side Notes action-menu trigger is visible on desktop pointer devices.

**Architecture:** Keep trigger ownership in CSS at the `.notes-outline` boundary. Existing hover, focus, and popup attributes remain local to each row; outline-level `:has()` overrides enforce popup-open → hover → focus priority without adding React state or rerenders.

**Tech Stack:** React 19, TypeScript 6, CSS `:has()`, Vitest 4, Testing Library

## Global Constraints

- Popup-open ownership has highest priority, followed by hover, then keyboard focus.
- Selection alone must not reveal a trigger.
- Coarse-pointer and touch behavior must remain unchanged.
- Do not add shared React hover state or change menu commands and popup contents.

---

### Task 1: Enforce one desktop menu-trigger owner

**Files:**
- Modify: `src/features/notes/NotesWorkspace.test.tsx:4124`
- Modify: `src/features/notes/notes.css:1648`

**Interfaces:**
- Consumes: Base UI's existing `data-popup-open` attribute on `.notes-bullet-menu-trigger` and the existing `.notes-outline`, `.notes-node-main`, and `.notes-page-title-row` structure.
- Produces: A CSS-only popup-open → hover → focus visibility contract for desktop fine-pointer environments.

- [x] **Step 1: Replace the selected-state style expectation with failing priority assertions**

Add a focused style-contract test after `uses stable Workflowy row geometry without action overlap`:

```tsx
it("shows only the highest-priority desktop note menu trigger", () => {
  expect(notesStyles).not.toContain(
    '.notes-node[data-selected="true"] .notes-bullet-menu-trigger'
  );
  expect(notesStyles).not.toContain(
    '.notes-page-header[data-selected="true"] .notes-bullet-menu-trigger'
  );
  expect(notesStyles).toMatch(
    /\.notes-outline:has\(\.notes-bullet-menu-trigger\[data-popup-open\]\)\s+\.notes-bullet-menu-trigger:not\(\[data-popup-open\]\)\s*{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/s
  );
  expect(notesStyles).toMatch(
    /\.notes-outline:not\(\s*:has\(\.notes-bullet-menu-trigger\[data-popup-open\]\)\s*\):has\(\s*\.notes-node-main:hover,\s*\.notes-page-title-row:hover\s*\)\s+:is\(\.notes-node-main,\s*\.notes-page-title-row\):not\(:hover\)\s+\.notes-bullet-menu-trigger\s*{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/s
  );
});
```

In the existing geometry test, replace the long visibility-selector assertion
with this exact local ownership assertion:

```tsx
expect(notesStyles).toMatch(
  /@media \(hover:\s*hover\) and \(pointer:\s*fine\)\s*{[\s\S]*\.notes-node-main:hover\s*>\s*\.notes-node-menu-slot\s+\.notes-bullet-menu-trigger,[\s\S]*\.notes-node-main:focus-within\s*>\s*\.notes-node-menu-slot\s+\.notes-bullet-menu-trigger,[\s\S]*\.notes-page-title-row:hover\s*>\s*\.notes-page-menu-slot\s+\.notes-bullet-menu-trigger,[\s\S]*\.notes-page-title-row:focus-within\s*>\s*\.notes-page-menu-slot\s+\.notes-bullet-menu-trigger,[\s\S]*\.notes-bullet-menu-trigger:focus-visible,[\s\S]*\.notes-bullet-menu-trigger\[data-popup-open\]\s*{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/s
);
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
PATH="/Users/doortts/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" npm test -- src/features/notes/NotesWorkspace.test.tsx
```

Expected: FAIL because both selected-state selectors still exist and neither outline-level priority override exists.

- [x] **Step 3: Implement the minimal desktop priority CSS**

Inside `@media (hover: hover) and (pointer: fine)`, keep the default hidden rule and replace the reveal selectors with direct page/row ownership:

```css
.notes-node-main:hover
  > .notes-node-menu-slot
  .notes-bullet-menu-trigger,
.notes-node-main:focus-within
  > .notes-node-menu-slot
  .notes-bullet-menu-trigger,
.notes-page-title-row:hover
  > .notes-page-menu-slot
  .notes-bullet-menu-trigger,
.notes-page-title-row:focus-within
  > .notes-page-menu-slot
  .notes-bullet-menu-trigger,
.notes-bullet-menu-trigger:focus-visible,
.notes-bullet-menu-trigger[data-popup-open] {
  opacity: 1;
  pointer-events: auto;
}
```

Immediately after that reveal block, add the two higher-specificity ownership overrides:

```css
.notes-outline:has(.notes-bullet-menu-trigger[data-popup-open])
  .notes-bullet-menu-trigger:not([data-popup-open]) {
  opacity: 0;
  pointer-events: none;
}

.notes-outline:not(
    :has(.notes-bullet-menu-trigger[data-popup-open])
  ):has(.notes-node-main:hover, .notes-page-title-row:hover)
  :is(.notes-node-main, .notes-page-title-row):not(:hover)
  .notes-bullet-menu-trigger {
  opacity: 0;
  pointer-events: none;
}
```

Do not change the coarse-pointer media block.

- [x] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
PATH="/Users/doortts/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" npm test -- src/features/notes/NotesWorkspace.test.tsx
```

Expected: every `NotesWorkspace.test.tsx` test passes, including `shows only the highest-priority desktop note menu trigger`.

- [x] **Step 5: Run frontend regression checks**

Run each command and require exit code 0:

```bash
PATH="/Users/doortts/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" npm test -- src/features/notes
PATH="/Users/doortts/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" npm run lint
PATH="/Users/doortts/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" npm run build
```

Expected: all Notes frontend tests pass, ESLint reports no errors, and Vite completes the production build.

- [x] **Step 6: Verify the running app**

With the onboarding page selected, focus a child title and leave the pointer over a different row. Confirm:

- the hovered row alone shows its menu trigger;
- moving the pointer off all rows restores the focused child's trigger;
- opening a menu keeps only its own trigger visible;
- touch/coarse-pointer CSS remains unchanged by source inspection.

- [x] **Step 7: Commit the fix**

```bash
git add src/features/notes/NotesWorkspace.test.tsx src/features/notes/notes.css
git commit -m "fix(notes): show one row menu trigger"
```
