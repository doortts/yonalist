# Notes Split Pane Polish and Workflowy Zoom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the Notes split view, restore zoom-page editing, add Workflowy zoom shortcuts across every bullet editing surface, and simplify the Show completed icon.

**Architecture:** Keep the existing two-pane registry and pane-bound actions. `NotesDetailSplitHost` owns the asymmetric open/close controls and primary-editor focus restoration; `NotesPageHeader` claims the same editing lease as ordinary rows; `outlineKeyboard` resolves platform chords while `NotesOutlinePane` maps the focused editing surface to a pane-local zoom target. CSS separates the 6px resize hit area from the visible 1px divider.

**Tech Stack:** React 19, TypeScript 6, Vitest 4, Testing Library, lucide-react, CSS, Tauri desktop smoke verification.

## Global Constraints

- Keep the existing two-pane Notes architecture; do not add a third pane or a generic pane command bus.
- Preserve the existing `Columns2` icon while split view is closed.
- While split view is open, render no split control in the primary toolbar and render one `PanelRightClose` control in the secondary toolbar.
- Closing from the secondary toolbar returns focus to the last editable primary Notes surface, then falls back to the primary zoom title, first visible primary bullet title, and finally the reopened `Columns2` button.
- Keep the divider's pointer and keyboard resize hit area at 6px while rendering only a 1px visible line.
- Use Workflowy chords exactly: macOS `⌘ + .` / `⌘ + ,`; Windows and Linux `Alt + .` / `Alt + ,`.
- Resolve zoom relative to the containing bullet for title, supporting-note, and image editors.
- Keep pane navigation histories independent and do not add history entries for zoom-in on the current page or zoom-out from the root view.
- Replace only the Show completed glyph from `ListChecks` to 16px `Check`; preserve tooltip, accessible name, pressed state, disabled state, and projection behavior.
- Do not add dependencies or change Notes storage, SQLite, IPC, Rust, native configuration, or Undo/Redo persistence contracts.
- Use an isolated test Vault and a freshly built/restarted Tauri process for final desktop proof.

---

### Task 1: Split controls, primary focus restoration, and 1px divider

**Files:**
- Modify: `src/features/notes/NotesDetailSplitHost.tsx:1-240`
- Modify: `src/features/notes/notes.css:436-477`
- Test: `src/features/notes/NotesFeature.test.tsx:124-175`
- Test: `src/features/notes/NotesWorkspace.test.tsx:10490`

**Interfaces:**
- Consumes: existing `NotesOutlinePane({ toolbarTrailing })`, `actions.flushAllDrafts(): Promise<boolean>`, secondary `releaseEditingFocus?()`, and pane registry activation.
- Produces: separate `openSplit()` and `closeSplit()` callbacks, `primaryOpenControl`, `secondaryCloseControl`, and primary editor restoration through `focusPrimaryEditor()`.

- [ ] **Step 1: Write failing split-control and focus-restoration tests**

Replace the existing open/close assertions in
`opens and closes one secondary pane without opening another workspace` with
state-specific accessible controls:

```tsx
const primary = container.querySelector<HTMLElement>(
  '[data-notes-pane-id="primary"]'
)!;
const open = within(primary).getByRole("button", {
  name: "Open split view"
});
expect(open.querySelector(".lucide-columns-2")).not.toBeNull();

fireEvent.click(open);
await waitFor(() =>
  expect(screen.getAllByLabelText("Notes outline")).toHaveLength(2)
);

const secondary = container.querySelector<HTMLElement>(
  '[data-notes-pane-id="secondary"]'
)!;
expect(
  within(primary).queryByRole("button", { name: /split view/i })
).toBeNull();
const close = within(secondary).getByRole("button", {
  name: "Close split view"
});
expect(close.querySelector(".lucide-panel-right-close")).not.toBeNull();

fireEvent.click(close);

await waitFor(() =>
  expect(screen.getAllByLabelText("Notes outline")).toHaveLength(1)
);
```

In `zooms the primary pane when its bullet is clicked in split view`, which
already supplies a real `Root` node, reopen split view and add the caret
restoration assertion:

```tsx
const primaryTitle = within(primary).getByRole<HTMLTextAreaElement>(
  "textbox",
  { name: "Edit node title" }
);
primaryTitle.focus();
primaryTitle.setSelectionRange(2, 2);
fireEvent.click(
  within(
    container.querySelector<HTMLElement>(
      '[data-notes-pane-id="secondary"]'
    )!
  ).getByRole("button", { name: "Close split view" })
);

await waitFor(() =>
  expect(screen.getAllByLabelText("Notes outline")).toHaveLength(1)
);
expect(primaryTitle).toHaveFocus();
expect(primaryTitle.selectionStart).toBe(2);
expect(primaryTitle.selectionEnd).toBe(2);
```

Add a CSS contract assertion to the existing style-contract section of `NotesWorkspace.test.tsx`:

```tsx
expect(notesStyles).toMatch(
  /\.notes-detail-split\[data-split-open="true"\]\s*{[^}]*6px/s
);
expect(notesStyles).toMatch(
  /\.notes-split-divider::before\s*{[^}]*width:\s*1px;[^}]*background:\s*var\(--border\);/s
);
expect(notesStyles).toMatch(
  /\.notes-split-divider:hover::before,[\s\S]*\.notes-split-divider:focus-visible::before\s*{[^}]*background:\s*var\(--accent\);/s
);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm test -- src/features/notes/NotesFeature.test.tsx src/features/notes/NotesWorkspace.test.tsx -t "secondary pane|divider"
```

Expected: FAIL because the only control is still named `Split view`, it remains in the primary toolbar while open, no secondary close control exists, close focuses the old toolbar button, and the divider paints the full 6px background.

- [ ] **Step 3: Implement asymmetric controls and focus restoration**

In `NotesDetailSplitHost.tsx`, import `PanelRightClose` and `FocusEvent`, retain `Columns2`, and add the editable selector:

```tsx
import { Columns2, PanelRightClose } from "lucide-react";
import {
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState
} from "react";

const PRIMARY_EDITOR_SELECTOR = [
  "textarea.notes-page-title:not(:disabled):not([readonly])",
  "textarea.notes-page-note:not(:disabled):not([readonly])",
  "textarea.notes-node-title:not(:disabled):not([readonly])",
  "textarea.notes-node-note:not(:disabled):not([readonly])",
  ".notes-image-atom-editor[contenteditable='true']"
].join(",");
```

Replace the single toggle with explicit open and close paths:

```tsx
const splitOpenButtonRef = useRef<HTMLButtonElement>(null);
const primaryPaneRef = useRef<HTMLDivElement>(null);
const lastPrimaryEditorRef = useRef<HTMLElement | null>(null);

const rememberPrimaryEditor = useCallback(
  (event: ReactFocusEvent<HTMLDivElement>) => {
    if (
      event.target instanceof HTMLElement &&
      event.target.matches(PRIMARY_EDITOR_SELECTOR)
    ) {
      lastPrimaryEditorRef.current = event.target;
    }
  },
  []
);

const focusPrimaryEditor = useCallback(() => {
  const primary = primaryPaneRef.current;
  const remembered = lastPrimaryEditorRef.current;
  if (
    remembered?.isConnected &&
    remembered.matches(PRIMARY_EDITOR_SELECTOR)
  ) {
    remembered.focus();
    return;
  }
  const fallback = primary?.querySelector<HTMLElement>(
    [
      "textarea.notes-page-title:not(:disabled):not([readonly])",
      "textarea.notes-node-title:not(:disabled):not([readonly])"
    ].join(",")
  );
  (fallback ?? splitOpenButtonRef.current)?.focus();
}, []);

const openSplit = useCallback(() => {
  setLayout((current) => ({ ...current, splitOpen: true }));
}, []);

const closeSplit = useCallback(async () => {
  if (!(await actions.flushAllDrafts())) return;
  registry.panes.secondary.actionsSlice.actions.releaseEditingFocus?.();
  if (registry.activePaneId === "secondary") {
    registry.setActivePaneId("primary");
  }
  setLayout((current) => ({ ...current, splitOpen: false }));
  requestAnimationFrame(focusPrimaryEditor);
}, [actions, focusPrimaryEditor, registry]);
```

Render controls only in their owning state:

```tsx
const primaryOpenControl = !layout.splitOpen ? (
  <IconTooltip label="Open split view" side="bottom">
    <button
      ref={splitOpenButtonRef}
      className="notes-export-trigger notes-split-toggle"
      type="button"
      aria-label="Open split view"
      onClick={openSplit}
    >
      <Columns2 size={16} aria-hidden="true" />
    </button>
  </IconTooltip>
) : undefined;

const secondaryCloseControl = layout.splitOpen ? (
  <IconTooltip label="Close split view" side="bottom">
    <button
      className="notes-export-trigger notes-split-toggle"
      type="button"
      aria-label="Close split view"
      onClick={() => void closeSplit()}
    >
      <PanelRightClose size={16} aria-hidden="true" />
    </button>
  </IconTooltip>
) : undefined;
```

Attach `ref={primaryPaneRef}` and `onFocusCapture={rememberPrimaryEditor}` to the primary pane. Pass `primaryOpenControl` to the primary `NotesOutlinePane` and `secondaryCloseControl` to the secondary one.

- [ ] **Step 4: Render a 1px line inside the existing 6px divider**

Change `notes.css`:

```css
.notes-split-divider {
  position: relative;
  z-index: 4;
  width: 6px;
  min-height: 0;
  outline: 0;
  background: transparent;
  cursor: col-resize;
  touch-action: none;
}

.notes-split-divider::before {
  position: absolute;
  inset-block: 0;
  inset-inline-start: calc(50% - 0.5px);
  width: 1px;
  background: var(--border);
  content: "";
}

.notes-split-divider:hover::before,
.notes-split-divider:focus-visible::before {
  background: var(--accent);
}
```

- [ ] **Step 5: Run the owning tests and verify GREEN**

Run:

```bash
npm test -- src/features/notes/NotesFeature.test.tsx src/features/notes/NotesWorkspace.test.tsx -t "secondary pane|divider"
```

Expected: PASS; the split opens from `Columns2`, closes only from secondary `PanelRightClose`, returns the primary caret, and retains the 6px resize contract with a 1px visible line.

- [ ] **Step 6: Commit the split slice**

```bash
git add src/features/notes/NotesDetailSplitHost.tsx src/features/notes/notes.css src/features/notes/NotesFeature.test.tsx src/features/notes/NotesWorkspace.test.tsx
git commit -m "fix(notes): polish split pane controls"
```

### Task 2: Restore editing ownership in zoomed page headers

**Files:**
- Modify: `src/features/notes/NotesPageHeader.tsx:69-1145`
- Test: `src/features/notes/NotesPageHeader.test.tsx:165-275`
- Test: `src/features/notes/NotesPageHeader.test.tsx:443-590`

**Interfaces:**
- Consumes: optional `actions.claimEditingFocus(nodeId, field): Promise<boolean>` and legacy `actions.markEditingFocus?(nodeId, field)`.
- Produces: direct page-title and page-note focus behavior identical to `OutlineNodeRow`: claim the pane editing lease, or blur the target if the claim is rejected.

- [ ] **Step 1: Add failing page-header lease tests**

Add `claimEditingFocus` and `markEditingFocus` spies to `workspaceValue()`:

```tsx
claimEditingFocus: vi.fn().mockResolvedValue(true),
markEditingFocus: vi.fn(),
```

Then add:

```tsx
it.each([
  ["Edit page title", "title"],
  ["Supporting note: Project", "note"]
] as const)("claims editing ownership from %s", async (name, field) => {
  const workspace = workspaceValue();
  renderZoomedOutline(workspace);

  fireEvent.focus(getTextareaByName(name));

  await waitFor(() =>
    expect(workspace.actions.claimEditingFocus).toHaveBeenCalledWith(
      "project",
      field
    )
  );
});

it("blurs a page title when another pane rejects its editing claim", async () => {
  const workspace = workspaceValue();
  vi.mocked(workspace.actions.claimEditingFocus!).mockResolvedValue(false);
  renderZoomedOutline(workspace);
  const title = getTextareaByName("Edit page title");

  fireEvent.focus(title);

  await waitFor(() => expect(title).not.toHaveFocus());
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- src/features/notes/NotesPageHeader.test.tsx -t "editing ownership|editing claim"
```

Expected: FAIL because the page title has no focus hook and the page note only updates local composition state.

- [ ] **Step 3: Add the same lease claim used by ordinary rows**

Inside `NotesPageHeader`, add:

```tsx
const claimEditingFocus = (
  field: "title" | "note",
  target: HTMLElement
): void => {
  if (!actions.claimEditingFocus) {
    actions.markEditingFocus?.(nodeId, field);
    return;
  }
  void actions.claimEditingFocus(nodeId, field).then((claimed) => {
    if (!claimed && document.activeElement === target) target.blur();
  });
};
```

Add to the page title `NoteTextField`:

```tsx
onFocus={(event) => {
  claimEditingFocus("title", event.currentTarget);
}}
```

Extend the existing page supporting-note focus handler:

```tsx
onFocus={(event) => {
  noteBlurredDuringCompositionRef.current = false;
  setRevealedNoteNodeId(nodeId);
  claimEditingFocus("note", event.currentTarget);
}}
```

Keep the existing pending-focus `acknowledgeFocus()` path unchanged; it already acquires the lease through the pane registry.

- [ ] **Step 4: Run page-header tests and verify GREEN**

Run:

```bash
npm test -- src/features/notes/NotesPageHeader.test.tsx
```

Expected: PASS, including ownership claim/rejection, caret placement, pending history focus, Korean auto-grow, and image-page behavior.

- [ ] **Step 5: Commit the editing regression fix**

```bash
git add src/features/notes/NotesPageHeader.tsx src/features/notes/NotesPageHeader.test.tsx
git commit -m "fix(notes): reclaim zoom page editing focus"
```

### Task 3: Resolve Workflowy zoom chords

**Files:**
- Modify: `src/features/notes/outlineKeyboard.ts:1-125`
- Test: `src/features/notes/outlineKeyboard.test.ts:1-150`

**Interfaces:**
- Produces: `resolveWorkflowyZoomShortcut(input): "zoomIn" | "zoomOut" | "consume" | null`.
- Consumes later: `NotesOutlinePane.handleSelectionKeyDownCapture`.

- [ ] **Step 1: Write the failing resolver tests**

Import `resolveWorkflowyZoomShortcut` and its input type, add a helper, and test exact platform behavior:

```ts
function zoomShortcutInput(
  overrides: Partial<ResolveWorkflowyZoomShortcutInput> = {}
): ResolveWorkflowyZoomShortcutInput {
  return {
    key: ".",
    altKey: false,
    ctrlKey: false,
    metaKey: true,
    shiftKey: false,
    isComposing: false,
    repeat: false,
    platform: "mac",
    ...overrides
  };
}

describe("resolveWorkflowyZoomShortcut", () => {
  it("maps Workflowy zoom chords by platform", () => {
    expect(resolveWorkflowyZoomShortcut(zoomShortcutInput())).toBe("zoomIn");
    expect(
      resolveWorkflowyZoomShortcut(zoomShortcutInput({ key: "," }))
    ).toBe("zoomOut");
    expect(
      resolveWorkflowyZoomShortcut(
        zoomShortcutInput({
          platform: "other",
          metaKey: false,
          altKey: true
        })
      )
    ).toBe("zoomIn");
    expect(
      resolveWorkflowyZoomShortcut(
        zoomShortcutInput({
          key: ",",
          platform: "other",
          metaKey: false,
          altKey: true
        })
      )
    ).toBe("zoomOut");
  });

  it("consumes repeats and rejects IME or extra modifiers", () => {
    expect(
      resolveWorkflowyZoomShortcut(zoomShortcutInput({ repeat: true }))
    ).toBe("consume");
    for (const overrides of [
      { isComposing: true },
      { key: "Process" },
      { shiftKey: true },
      { altKey: true },
      { ctrlKey: true },
      { metaKey: false }
    ]) {
      expect(
        resolveWorkflowyZoomShortcut(zoomShortcutInput(overrides))
      ).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Run the resolver test and verify RED**

Run:

```bash
npm test -- src/features/notes/outlineKeyboard.test.ts -t "resolveWorkflowyZoomShortcut"
```

Expected: FAIL because the resolver and input type do not exist.

- [ ] **Step 3: Implement the pure resolver**

Add to `outlineKeyboard.ts`:

```ts
export interface ResolveWorkflowyZoomShortcutInput {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  repeat: boolean;
  platform: OutlineShortcutPlatform;
}

export type WorkflowyZoomShortcut = "zoomIn" | "zoomOut" | "consume";

export function resolveWorkflowyZoomShortcut(
  input: ResolveWorkflowyZoomShortcutInput
): WorkflowyZoomShortcut | null {
  if (
    input.isComposing ||
    input.key === "Process" ||
    input.shiftKey ||
    (input.key !== "." && input.key !== ",")
  ) {
    return null;
  }
  const modifierMatches =
    input.platform === "mac"
      ? input.metaKey && !input.altKey && !input.ctrlKey
      : input.altKey && !input.ctrlKey && !input.metaKey;
  if (!modifierMatches) return null;
  if (input.repeat) return "consume";
  return input.key === "." ? "zoomIn" : "zoomOut";
}
```

- [ ] **Step 4: Run the keyboard module and verify GREEN**

Run:

```bash
npm test -- src/features/notes/outlineKeyboard.test.ts
```

Expected: PASS for zoom, history, selection movement, supporting-note navigation, and structural outline commands.

- [ ] **Step 5: Commit the resolver**

```bash
git add src/features/notes/outlineKeyboard.ts src/features/notes/outlineKeyboard.test.ts
git commit -m "feat(notes): resolve Workflowy zoom shortcuts"
```

### Task 4: Apply zoom chords to title, note, and image surfaces

**Files:**
- Modify: `src/features/notes/NotesOutlinePane.tsx:1-80`
- Modify: `src/features/notes/NotesOutlinePane.tsx:560-625`
- Modify: `src/features/notes/NotesOutlinePane.tsx:2260-2310`
- Test: `src/features/notes/NotesWorkspace.test.tsx:9320-9465`

**Interfaces:**
- Consumes: `resolveWorkflowyZoomShortcut`, `getStateSnapshot()`, pane-bound `actions.zoomTo(nodeId | null)`, `.notes-page-header`, and row `data-outline-id`.
- Produces: pane-level shortcut ownership for `.notes-page-title`, `.notes-page-note`, `.notes-node-title`, `.notes-node-note`, and `.notes-image-atom-editor`.

- [ ] **Step 1: Add failing integration tests for all editing surfaces**

Add a target resolver used only by the test:

```tsx
it.each([
  { surface: "title", nodeKind: "text" as const },
  { surface: "note", nodeKind: "text" as const },
  { surface: "image", nodeKind: "image" as const }
])(
  "zooms into the containing bullet from its $surface editor",
  async ({ surface, nodeKind }) => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
    const target = node({
      id: "target",
      nodeKind,
      title: nodeKind === "image" ? "diagram.png" : "Target",
      note: "Target note"
    });
    configureRepository(
      [target],
      nodeKind === "image"
        ? { target: [attachment({ id: "target-image", nodeId: "target" })] }
        : {}
    );
    renderNotesWorkspace();

    const editor =
      surface === "title"
        ? await findTitleInput("Target")
        : surface === "note"
          ? await findTextareaByName("Supporting note: Target")
          : await screen.findByRole("textbox", { name: "Image note" });
    expect(
      fireEvent.keyDown(editor, { key: ".", metaKey: true })
    ).toBe(false);

    if (nodeKind === "image") {
      const page = document.querySelector<HTMLElement>(".notes-page-header")!;
      expect(
        await within(page).findByRole("textbox", { name: "Image note" })
      ).toBeVisible();
    } else {
      expect(
        await screen.findByRole("heading", { name: "Target", level: 1 })
      ).toBeVisible();
    }
  }
);
```

Add zoom-out and no-op coverage:

```tsx
it("zooms out from a page editor and consumes root/page no-ops", async () => {
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
  configureRepository([
    node({ id: "parent", title: "Parent" }),
    node({ id: "child", parentId: "parent", title: "Child", note: "Detail" })
  ]);
  renderNotesWorkspace();
  fireEvent.click(
    await screen.findByRole("button", { name: "Zoom into Child" })
  );
  const pageNote = await findTextareaByName("Supporting note: Child");

  expect(fireEvent.keyDown(pageNote, { key: ".", metaKey: true })).toBe(false);
  expect(fireEvent.keyDown(pageNote, { key: ",", metaKey: true })).toBe(false);
  expect(
    await screen.findByRole("heading", { name: "Parent", level: 1 })
  ).toBeVisible();

  fireEvent.keyDown(
    getTextareaByName("Supporting note: Parent"),
    { key: ",", metaKey: true }
  );
  expect(await findTitleInput("Parent")).toBeVisible();
});
```

- [ ] **Step 2: Run focused workspace tests and verify RED**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "containing bullet|page editor"
```

Expected: FAIL because the pane capture handler currently handles selection shortcuts and clipboard only.

- [ ] **Step 3: Identify the containing bullet without coupling child editors**

Add near `rowIdFromPointerTarget()`:

```ts
const ZOOM_EDITABLE_SELECTOR = [
  ".notes-page-title",
  ".notes-page-note",
  ".notes-node-title",
  ".notes-node-note",
  ".notes-image-atom-editor"
].join(",");

function zoomNodeIdFromTarget(
  target: EventTarget | null,
  zoomRootId: NoteId | null
): NoteId | null {
  if (!(target instanceof Element) || !target.closest(ZOOM_EDITABLE_SELECTOR)) {
    return null;
  }
  if (target.closest(".notes-page-header")) {
    return zoomRootId;
  }
  return (
    target.closest<HTMLElement>("[data-outline-id]")?.dataset.outlineId ?? null
  );
}
```

- [ ] **Step 4: Handle zoom before selection shortcuts**

At the start of `handleSelectionKeyDownCapture`, after reading the current snapshot:

```tsx
const snapshot = getStateSnapshot().state;
const zoomShortcut = resolveWorkflowyZoomShortcut({
  key: event.key,
  altKey: event.altKey,
  ctrlKey: event.ctrlKey,
  metaKey: event.metaKey,
  shiftKey: event.shiftKey,
  isComposing: event.nativeEvent.isComposing,
  repeat: event.repeat,
  platform: detectOutlineShortcutPlatform()
});
const zoomNodeId =
  zoomShortcut === null
    ? null
    : zoomNodeIdFromTarget(event.target, snapshot.zoomRootId);
if (zoomShortcut !== null && zoomNodeId !== null) {
  event.preventDefault();
  event.stopPropagation();
  if (zoomShortcut === "consume") return;
  if (zoomShortcut === "zoomIn") {
    if (zoomNodeId !== snapshot.zoomRootId) {
      void actions.zoomTo(zoomNodeId);
    }
    return;
  }
  if (snapshot.zoomRootId !== null) {
    void actions.zoomTo(
      snapshot.nodesById[snapshot.zoomRootId]?.parentId ?? null
    );
  }
  return;
}
```

Include `actions`, `getStateSnapshot`, and the resolver in the callback dependencies/imports. A root-view zoom-out must also be consumed when the target is a row editor, so derive `zoomNodeId` from the target even when `snapshot.zoomRootId` is `null`.

- [ ] **Step 5: Run keyboard and workspace tests and verify GREEN**

Run:

```bash
npm test -- src/features/notes/outlineKeyboard.test.ts src/features/notes/NotesWorkspace.test.tsx -t "zoom|containing bullet|page editor"
```

Expected: PASS; title, note, and image editors zoom within their own pane, page/root no-ops are consumed, and the pure resolver guards repeat and IME.

- [ ] **Step 6: Commit pane-level zoom**

```bash
git add src/features/notes/NotesOutlinePane.tsx src/features/notes/NotesWorkspace.test.tsx
git commit -m "feat(notes): add Workflowy pane zoom shortcuts"
```

### Task 5: Simplify Show completed and run final verification

**Files:**
- Modify: `src/features/notes/NotesOutlinePane.tsx:10-22`
- Modify: `src/features/notes/NotesOutlinePane.tsx:3764-3785`
- Test: `src/features/notes/NotesWorkspace.test.tsx:3664-3693`
- Verify: frontend tests, lint, build, diff, and fresh desktop smoke.

**Interfaces:**
- Consumes: existing `notes-completed-toggle` state and tooltip contract.
- Produces: 16px Lucide `Check` glyph with no behavior changes.

- [ ] **Step 1: Make the existing completion projection test fail on the old glyph**

Add before clicking the toggle:

```tsx
const toggle = screen.getByRole("button", { name: "Completed items" });
expect(toggle.querySelector(".lucide-check")).not.toBeNull();
expect(toggle.querySelector(".lucide-list-checks")).toBeNull();
expect(toggle).toHaveAttribute("aria-pressed", "true");
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "hides completed node subtrees"
```

Expected: FAIL because the toggle still renders `ListChecks`.

- [ ] **Step 3: Replace only the glyph**

In `NotesOutlinePane.tsx`, replace the Lucide import and JSX:

```tsx
import {
  Check,
  ChevronRight,
  Home,
  Maximize2,
  Minimize2,
  Trash2
} from "lucide-react";
```

```tsx
<Check size={16} aria-hidden="true" />
```

Do not change the button class, tooltip label expression, accessible label, `aria-pressed`, disabled condition, or `showCompleted` state.

- [ ] **Step 4: Run the completion slice and verify GREEN**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "completed"
```

Expected: PASS for glyph, hide/show projection, completed zoom root, and existing completion commands.

- [ ] **Step 5: Review the frozen diff**

Run:

```bash
git diff --check
git diff --stat
git status --short
```

Expected: no whitespace errors; only the planned Notes frontend, tests, CSS, and approved docs are changed.

- [ ] **Step 6: Run the frontend final gates once**

Run:

```bash
npm test
npm run lint
npm run build
git diff --check
```

Expected: all tests pass, ESLint exits 0, TypeScript and Vite build successfully, and the final diff has no whitespace errors. Skip Cargo tests, Rust formatting, and Clippy because Rust, IPC, persistence, and native configuration are unchanged.

- [ ] **Step 7: Perform fresh Tauri desktop proof**

Use an isolated test Vault, rebuild/restart the Tauri app, and verify:

1. Closed split view shows the existing `Columns2`.
2. Open split view hides the primary control and shows only secondary `PanelRightClose`.
3. The divider looks 1px wide while drag and arrow resizing remain easy.
4. Closing from secondary restores the last primary title/note/image editor and caret.
5. A zoomed sub-bullet page title and note accept edits after switching pane ownership.
6. `⌘ + .` and `⌘ + ,` work from title, note, and image surfaces in each pane.
7. Show completed renders the simple `Check` and keeps its tooltip and pressed behavior.

Expected: all seven observable checks pass in the fresh process; restore the isolated Vault after the smoke test.

- [ ] **Step 8: Commit the completed-icon slice**

```bash
git add src/features/notes/NotesOutlinePane.tsx src/features/notes/NotesWorkspace.test.tsx
git commit -m "refactor(notes): simplify completed toggle icon"
```
