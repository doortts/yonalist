# Notes Left-Caret Navigation and Toolbar Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move a title-start Left press to the end of the previous visible bullet and align the Notes detail maximize control with the existing outline-toolbar actions.

**Architecture:** Keep keyboard intent pure in `resolveOutlineKey`, then carry an explicit primary selection through the existing pending-focus restoration path. Expose App-owned detail layout state through a small React context so Notes can render the same maximize action inline while the fixed TitleBar fallback remains available to other features.

**Tech Stack:** React 19, TypeScript 6, Vitest, Testing Library, Tauri 2, Lucide React.

## Global Constraints

- Frontend-only change; do not modify Rust, IPC, SQLite, Vault, export, attachments, or history behavior.
- Left at title offset `0` replaces the existing collapse/parent behavior with previous-visible-item end-caret navigation.
- ArrowRight, ArrowUp, ArrowDown, pointer collapse, composition, modifier, repeat, selection, note-editor, and image-editor guards remain unchanged.
- Notes must expose exactly one maximize control in `.notes-outline-toolbar`; non-Notes screens retain their current maximize controls.
- Preserve the user-owned untracked file `docs/superpowers/plans/2026-07-21-notes-file-ssot-sync-implementation.md`.
- Commit each completed task and run only owning tests during the edit loop.

---

### Task 1: Previous-visible bullet end-caret navigation

**Files:**
- Modify: `src/features/notes/outlineKeyboard.ts`
- Modify: `src/features/notes/outlineKeyboard.test.ts`
- Modify: `src/features/notes/notesWorkspaceTypes.ts`
- Modify: `src/features/notes/notesWorkspaceRuntime.ts`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/NotesPageHeader.tsx`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**
- Produces: `OutlineKeyResolution` focus variant with optional `selection: NotesHistoryPrimarySelection`.
- Produces: `NotesWorkspaceActions.focusNode(nodeId, selection?)`.
- Consumes: existing `pendingPrimarySelectionRef`, `nextPrimarySelectionRequestIdRef`, and textarea/image selection restorers.

- [ ] **Step 1: Write failing pure keyboard tests**

Replace the old Left collapse/parent assertion with previous-visible navigation:

```ts
const endSelection = {
  anchorUtf16: Number.MAX_SAFE_INTEGER,
  focusUtf16: Number.MAX_SAFE_INTEGER
};

expect(resolveOutlineKey(input({
  key: "ArrowLeft",
  nodeId: "child-b",
  title: "child-b",
  selectionStart: 0,
  selectionEnd: 0
}))).toEqual({
  type: "focus",
  nodeId: "grandchild",
  selection: endSelection
});

expect(resolveOutlineKey(input({
  key: "ArrowLeft",
  nodeId: "root-a",
  selectionStart: 0,
  selectionEnd: 0
}))).toBeNull();
```

- [ ] **Step 2: Run the pure test and confirm RED**

Run: `npx vitest run src/features/notes/outlineKeyboard.test.ts -t 'previous visible'`

Expected: FAIL because Left still emits collapse/parent navigation.

- [ ] **Step 3: Implement pure Left intent**

Use the current visible projection and emit an end-caret request:

```ts
if (input.key === "ArrowLeft") {
  if (!collapsedSelection || (!imageTarget && selectionStart !== 0)) {
    return null;
  }
  const previousId = visibleIds[visibleIndex - 1];
  return previousId
    ? {
        type: "focus",
        nodeId: previousId,
        selection: {
          anchorUtf16: Number.MAX_SAFE_INTEGER,
          focusUtf16: Number.MAX_SAFE_INTEGER
        }
      }
    : null;
}
```

- [ ] **Step 4: Carry the selection through focus settlement**

Extend the action signature and seed the existing one-shot selection request:

```ts
focusNode(
  nodeId: NoteId,
  selection?: NotesHistoryPrimarySelection
): Promise<void>;
```

```ts
if (selection) {
  pendingPrimarySelectionRef.current = {
    requestId: ++nextPrimarySelectionRequestIdRef.current,
    nodeId,
    field: "title",
    selection
  };
} else {
  pendingPrimarySelectionRef.current = null;
}
applyAction({ type: "focusNode", nodeId });
```

Both title handlers call `actions.focusNode(resolution.nodeId, resolution.selection)` only when the selection is present, preserving one-argument calls for other arrows.

- [ ] **Step 5: Add the workspace regression test**

Configure two visible text nodes, focus the second title at offset `0`, press Left, then assert the first title owns focus and both selection offsets equal `first.value.length`. Update the existing horizontal-boundary integration test to assert Left does not call `toggleCollapsed`.

- [ ] **Step 6: Run owning tests and confirm GREEN**

Run: `npx vitest run src/features/notes/outlineKeyboard.test.ts src/features/notes/NotesWorkspace.test.tsx -t 'previous visible|horizontal caret'`

Expected: focused tests pass with no collapse mutation from Left.

- [ ] **Step 7: Review and commit Task 1**

Run: `git diff --check`

Commit:

```bash
git add src/features/notes/outlineKeyboard.ts src/features/notes/outlineKeyboard.test.ts src/features/notes/notesWorkspaceTypes.ts src/features/notes/notesWorkspaceRuntime.ts src/features/notes/OutlineNodeRow.tsx src/features/notes/NotesPageHeader.tsx src/features/notes/NotesWorkspace.test.tsx
git commit -m "fix(notes): move left caret to previous bullet"
```

### Task 2: Inline Notes detail maximize control

**Files:**
- Create: `src/PaneLayoutContext.ts`
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/features/notes/NotesOutlinePane.tsx`

**Interfaces:**
- Produces: `PaneLayoutContext` value `{ detailMaximized: boolean; toggleDetailMaximized(): void }`.
- Consumes: existing `detailMaximized` and `toggleDetailMaximized` from `usePaneResize`.

- [ ] **Step 1: Write the failing App integration test**

Open Notes and assert one maximize control is inside the Notes toolbar:

```ts
await user.click(screen.getByRole("button", { name: "Notes" }));
const toolbar = document.querySelector(".notes-outline-toolbar");
expect(toolbar).not.toBeNull();
const maximize = within(toolbar as HTMLElement).getByRole("button", {
  name: "상세 최대화"
});
expect(screen.getAllByRole("button", { name: "상세 최대화" })).toHaveLength(1);
await user.click(maximize);
expect(screen.getByLabelText("Yonalist layout")).toHaveAttribute(
  "data-detail-maximized",
  "true"
);
expect(maximize).toHaveAttribute("aria-pressed", "true");
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npx vitest run src/App.test.tsx -t 'Notes maximize'`

Expected: FAIL because the control is still in the fixed TitleBar group.

- [ ] **Step 3: Add the pane layout context and provider**

Create:

```ts
import { createContext } from "react";

export interface PaneLayoutControls {
  detailMaximized: boolean;
  toggleDetailMaximized(): void;
}

export const PaneLayoutContext = createContext<PaneLayoutControls | null>(null);
```

Memoize the value in `App`, wrap the shell with the provider, and set
`showDetailMaximizeToggle` false only when the active ready feature is Notes.

- [ ] **Step 4: Render the inline Notes action**

Consume the context in `NotesOutlinePane` and append a toolbar button after `NotesExportMenu`:

```tsx
{paneLayout && (
  <IconTooltip
    label={paneLayout.detailMaximized ? "상세 최대화 해제" : "상세 최대화"}
    side="bottom"
  >
    <button
      className="notes-completed-toggle"
      type="button"
      aria-label="상세 최대화"
      aria-pressed={paneLayout.detailMaximized}
      onClick={paneLayout.toggleDetailMaximized}
    >
      {paneLayout.detailMaximized ? (
        <Minimize2 size={16} aria-hidden="true" />
      ) : (
        <Maximize2 size={16} aria-hidden="true" />
      )}
    </button>
  </IconTooltip>
)}
```

- [ ] **Step 5: Run the App test and confirm GREEN**

Run: `npx vitest run src/App.test.tsx -t 'Notes maximize'`

Expected: one inline control toggles the existing App shell state.

- [ ] **Step 6: Review and commit Task 2**

Run: `git diff --check`

Commit:

```bash
git add src/PaneLayoutContext.ts src/App.tsx src/App.test.tsx src/features/notes/NotesOutlinePane.tsx
git commit -m "fix(notes): align maximize toolbar action"
```

### Task 3: Focused verification and desktop proof

**Files:**
- Review only: all Task 1 and Task 2 files

**Interfaces:**
- Consumes: completed keyboard and toolbar changes.
- Produces: verified frontend commits with no additional boundary changes.

- [ ] **Step 1: Run owning tests**

Run:

```bash
npx vitest run src/features/notes/outlineKeyboard.test.ts src/App.test.tsx
npx vitest run src/features/notes/NotesWorkspace.test.tsx -t 'previous visible|horizontal caret'
```

Expected: all selected tests pass.

- [ ] **Step 2: Run focused static checks and build**

Run ESLint on changed TypeScript files, then run `npm run build` and `git diff --check`.

Expected: zero ESLint errors, successful TypeScript/Vite build, and no whitespace errors. Cargo checks are skipped because no Rust, IPC, persistence, or native configuration changed.

- [ ] **Step 3: Perform fresh Tauri smoke proof**

Restart or freshly launch the Tauri dev app without replacing user Vault data. Verify:

1. The maximize, completed-items, and export controls share one toolbar row.
2. Only one maximize control is visible in Notes.
3. Toggling maximize preserves icon alignment and restores panes.
4. On a disposable two-bullet sequence, Left at the second title's start focuses the first title at its end; restore or remove any disposable data afterward.

- [ ] **Step 4: Adversarial diff review**

Check selection replay ownership, stale-node handling, Notes inactive mounting, duplicate maximize controls, non-Notes maximize behavior, and user-owned untracked files. Rework only confirmed defects and rerun their owning tests.

- [ ] **Step 5: Record final status**

Confirm `git status --short --branch` contains only the pre-existing user-owned untracked plan file, then report test counts, build result, desktop proof, skipped Cargo gates, and both commit hashes.
