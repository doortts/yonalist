# Workflowy Outline UI Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Rebuild the Notes detail surface so writing, nesting, collapsing,
zooming, annotating, and dragging bullets matches the approved signed-in
Workflowy reference while preserving Yonalist's host shell and storage.

**Architecture:** Keep the existing Notes store, reducer, SQLite commands, and
feature-host boundary. Change only the Notes presentation and interaction
adapters: stable row geometry, a bullet-centered control model, a zoomed page
header, an accessible context menu, and shared indentation and drop-preview
tokens.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, dnd-kit, Lucide,
Tauri 2, existing NotesStore and CSS tokens.

## Global Constraints

- The user-provided Workflowy screenshot is the visual authority.
- Existing Inbox, Notifications, Settings, auth, network, and cache behavior
  must not change.
- Notes remains local-only and persists through the current SQLite adapter.
- Use one implementation agent at a time. Parallel agents are read-only
  reviewers or scouts.
- Every task follows RED, GREEN, focused verification, independent review,
  correction, and re-review before the next task.
- Body rows target 28px minimum height, 16px/24px text, an 18px bullet target,
  and 36px desktop indentation.
- Arrow toggles, bullet zooms and drags, and menu commands remain distinct.
- Do not add boards, tables, mirrors, collaboration, cloud sync, or AI.

---

### Task 1: Bullet-Centered Row Geometry

**Files:**

- Modify: src/features/notes/OutlineNodeRow.tsx
- Modify: src/features/notes/NotesOutlinePane.tsx
- Modify: src/features/notes/outlineDrag.ts
- Modify: src/features/notes/notes.css
- Modify: src/features/notes/NotesWorkspace.test.tsx
- Modify: src/features/notes/outlineDrag.test.ts

**Interfaces:**

- Consumes: current OutlineNodeRow callbacks, dnd-kit sortable attributes,
  actions.zoomTo(nodeId), and toggleCollapsed(nodeId).
- Produces: a shared indentation constant, separate arrow and bullet controls,
  and a bullet drag activator that later tasks reuse.

- [ ] **Step 1: Write failing row-contract tests**

Add assertions equivalent to:

    expect(screen.getByRole("button", { name: "Zoom into Project" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Collapse Project" })).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: /complete/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move Project" })).not.toBeInTheDocument();

Also assert a leaf keeps the arrow slot, the bullet carries sortable attributes,
and clicking the arrow does not call zoomTo.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

    npm test -- src/features/notes/NotesWorkspace.test.tsx src/features/notes/outlineDrag.test.ts

Expected: FAIL because the current row has a dedicated move handle, permanent
checkbox, and double-click title zoom.

- [ ] **Step 3: Implement the stable row grid**

Use this geometry:

    .notes-node-main {
      grid-template-columns: 20px 18px minmax(0, 1fr) 24px;
      min-height: 28px;
      margin-inline-start: var(--notes-indent);
    }

Use the arrow only for collapse and expand. Make the bullet a real button with
click-to-zoom and dnd-kit activator listeners. Keep pointer activation distance
at four pixels so a click does not become a drag.

- [ ] **Step 4: Remove row-wide chrome**

Remove the native checkbox, permanent grip column, filled hover row, and title
input border and background. Preserve focus-visible indication and accessible
names.

- [ ] **Step 5: Align drag projection with CSS**

Export:

    export const OUTLINE_INDENT_PX = 36;

Use it for dnd-kit horizontal projection and set the matching CSS custom
property at the outline root. Test that a 36px horizontal offset changes depth
by one.

- [ ] **Step 6: Verify and commit**

Run:

    npm test -- src/features/notes/NotesWorkspace.test.tsx src/features/notes/outlineDrag.test.ts
    npm run build
    git diff --check

Commit:

    git add src/features/notes
    git commit -m "feat(notes): adopt workflowy bullet row geometry"

### Task 2: Hierarchy Guides And Precise Drop Preview

**Files:**

- Modify: src/features/notes/NotesOutlinePane.tsx
- Modify: src/features/notes/OutlineNodeRow.tsx
- Modify: src/features/notes/outlineTree.ts
- Modify: src/features/notes/outlineDrag.ts
- Modify: src/features/notes/notes.css
- Modify: src/features/notes/outlineTree.test.ts
- Modify: src/features/notes/outlineDrag.test.ts
- Modify: src/features/notes/NotesWorkspace.test.tsx

**Interfaces:**

- Consumes: preorder visible rows and projected drag destination.
- Produces: decorative branch-guide metadata and
  OutlineDropPreview with beforeId, parentId, and depth.

- [ ] **Step 1: Write failing guide and preview tests**

Use an expanded three-level fixture. Assert parent rows expose a guide only when
they have visible descendants, and the guide ends after the final descendant.
Assert drag-over state exposes one insertion preview at the projected depth.

- [ ] **Step 2: Run focused tests and verify RED**

    npm test -- src/features/notes/outlineTree.test.ts src/features/notes/outlineDrag.test.ts src/features/notes/NotesWorkspace.test.tsx

Expected: FAIL because no guide or insertion-line model exists.

- [ ] **Step 3: Add pure projection helpers**

Derive guide continuation and drop-preview metadata from visible rows. Helpers
must not read the DOM or mutate workspace state.

- [ ] **Step 4: Render guides and insertion line**

Render guides with pseudo-elements or ignored spans. Render one absolute
insertion line during drag, aligned to the projected bullet x position. Keep
announcements and keyboard drag behavior unchanged.

- [ ] **Step 5: Verify and commit**

Run focused tests, the full frontend suite, npm run build, and git diff --check.

Commit:

    git add src/features/notes
    git commit -m "feat(notes): show outline guides and drop targets"

### Task 3: Zoomed Page Header And Inline Supporting Note

**Files:**

- Create: src/features/notes/NotesPageHeader.tsx
- Create: src/features/notes/NotesPageHeader.test.tsx
- Modify: src/features/notes/NotesOutlinePane.tsx
- Modify: src/features/notes/OutlineNodeRow.tsx
- Modify: src/features/notes/outlineTree.ts
- Modify: src/features/notes/notes.css
- Modify: src/features/notes/NotesWorkspace.test.tsx
- Modify: src/features/notes/outlineTree.test.ts

**Interfaces:**

- Consumes: zoomRootId, root node, breadcrumb trail, updateNode, and current
  draft flush and retry state.
- Produces: editable NotesPageHeader; body rows exclude the zoom root.

- [ ] **Step 1: Write failing zoom-layout tests**

After zooming into Project, assert:

    expect(screen.getByRole("heading", { name: "Project", level: 1 })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Zoom into Project" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zoom into First child" })).toBeVisible();

Assert the root supporting note is visible below the heading and outside the
child list.

- [ ] **Step 2: Run tests and verify RED**

    npm test -- src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesWorkspace.test.tsx src/features/notes/outlineTree.test.ts

Expected: FAIL because the zoom root is currently the first ordinary row.

- [ ] **Step 3: Implement the page header**

Render the zoom root as a 27px/34px editable title with its supporting note
below. Reuse the existing draft serializer and retry state. Do not create a
second persistence path.

- [ ] **Step 4: Make supporting notes inline**

Show non-empty notes by default. Make empty notes appear after Shift+Enter or
the bullet menu. Use an auto-growing borderless textarea with 14px/20px muted
text. Keep native textarea Enter, Tab, and IME behavior.

- [ ] **Step 5: Verify and commit**

Run focused tests, full frontend tests, production build, and diff checks.

Commit:

    git add src/features/notes
    git commit -m "feat(notes): render zoomed notes as pages"

### Task 4: Accessible Bullet Menu And Workflowy Shortcuts

**Files:**

- Create: src/features/notes/NotesBulletMenu.tsx
- Create: src/features/notes/NotesBulletMenu.test.tsx
- Modify: src/features/notes/OutlineNodeRow.tsx
- Modify: src/features/notes/NotesOutlinePane.tsx
- Modify: src/features/notes/outlineKeyboard.ts
- Modify: src/features/notes/outlineKeyboard.test.ts
- Modify: src/features/notes/notes.css
- Modify: src/features/notes/NotesWorkspace.test.tsx

**Interfaces:**

- Consumes: current star, completion, note, duplicate, delete, retry, and export
  callbacks.
- Produces: one keyboard and touch accessible node menu and shortcut commands.

- [ ] **Step 1: Write failing menu tests**

Assert one menu button exposes Complete, Star, Add note, Duplicate, Export, and
Delete commands. Assert Escape closes the menu and returns focus to its trigger.
Assert Trash rows keep only Restore.

- [ ] **Step 2: Write failing shortcut tests**

Add exact tests:

    Shift+Enter -> open and focus note
    Ctrl/Cmd+Enter -> toggle complete
    Alt/Cmd+Shift+D -> duplicate
    Ctrl/Cmd+Shift+Backspace -> delete

Composition and textarea targets must remain ignored.

- [ ] **Step 3: Run focused tests and verify RED**

    npm test -- src/features/notes/NotesBulletMenu.test.tsx src/features/notes/outlineKeyboard.test.ts src/features/notes/NotesWorkspace.test.tsx

- [ ] **Step 4: Implement the menu and shortcuts**

Use existing menu and dialog primitives if available. Otherwise build a
WAI-ARIA menu with Lucide icons, roving focus, Escape, outside click, and focus
restoration. Keep menu rendering outside the row sizing flow.

- [ ] **Step 5: Add completed visibility**

Keep completion as a state on standard bullets. Add a restrained show or hide
completed toggle to Notes chrome without changing stored data.

- [ ] **Step 6: Verify and commit**

Run focused and full frontend tests, production build, and diff checks.

Commit:

    git add src/features/notes
    git commit -m "feat(notes): add workflowy bullet commands"

### Task 5: Responsive Visual Parity And Reference Fixture

**Files:**

- Modify: src/features/notes/notes.css
- Modify: src/features/notes/NotesWorkspace.test.tsx
- Modify: src/features/notes/NotesOutlinePane.tsx
- Modify: README.md

**Interfaces:**

- Consumes: completed Tasks 1 through 4.
- Produces: approved desktop and mobile rendering plus final Notes usage
  documentation.

- [ ] **Step 1: Add layout regression assertions**

Assert stable hooks for:

    28px row minimum
    36px desktop indent
    28px narrow indent
    700px preferred content width
    16px/24px body text
    14px/20px note text

Assert long Korean titles wrap without overlapping controls.

- [ ] **Step 2: Implement responsive polish**

Center the desktop content column, reduce padding and indent on narrow screens,
truncate breadcrumbs, preserve 28px targets, keep the menu out of document
flow, and add reduced-motion handling.

- [ ] **Step 3: Seed a deterministic visual fixture**

Use local-only test data containing:

    Note app
      google keep #noteapp 2022-01-02
        Mobile access is convenient
        Sync is useful
        Good for short reference numbers
          Supporting note text
      MS To do #noteapp
      Things #noteapp
      Developer tip
        2026
          What I learned building Yona

Include expanded, collapsed, completed, empty, long-wrapped, and failed-draft
states without adding production-only fixture UI.

- [ ] **Step 4: Capture and inspect screenshots**

Run the Tauri development app and inspect:

    Desktop: 1440x900
    Narrow: 390x844

Compare row density, bullet and arrow alignment, guide continuity, note
alignment, title wrapping, breadcrumb compression, and absence of overlap
against the approved reference. Store screenshots under ignored
.superpowers/sdd/artifacts/workflowy-ui/.

- [ ] **Step 5: Run final frontend verification**

    npm test
    npm run build
    git diff --check

Expected: all existing Inbox and Notes tests pass with no console errors.

- [ ] **Step 6: Commit**

    git add src/features/notes README.md
    git commit -m "feat(notes): finish workflowy outline presentation"

## Review And Completion Gate

After each task, dispatch two read-only reviewers in parallel:

1. Behavior and regression reviewer.
2. Workflowy visual and accessibility reviewer.

Fix every Critical or Important finding and repeat affected reviews. After Task
5, run the complete frontend and Rust suites, offline checks, PDF and Markdown
export checks, desktop and mobile functional tests, and performance benchmarks
before declaring the Notes feature complete.
