# Yonalist v2 Monaco Outline Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an A/B-selectable whole-page Monaco text-outline surface and measure whether it improves Yonalist's Enter, Backspace, caret, split-pane, and large-outline behavior.

**Architecture:** Keep the existing NotesStore, Rust commands, SQLite, IPC, history, header, and React outline as the control. Add a pure node-to-line projection and a lazy Monaco adapter that owns the immediate text model while routing structural gestures and Undo/Redo back through existing Yonalist authorities.

**Tech Stack:** React 19, TypeScript 6, Vite 8, Vitest 4, `monaco-editor` 0.53, existing Yonalist NotesStore and generated contracts.

## Global Constraints

- The complete bullet page, never one Monaco instance per bullet, is the experimental editor unit.
- The existing design, tokens, typography, colors, spacing, and shell remain unchanged.
- Rust, SQLite, IPC contracts, persisted schema, and session-history authority remain unchanged.
- Monaco private DOM and VS Code private services are forbidden.
- `?outline=monaco` selects the experiment; the query-free React outline remains the A/B control.
- Image editing, multi-selection, menus, supporting notes, and cross-pane drag/drop are reported as unsupported in this spike rather than faked.
- Every production behavior begins with a focused failing test.

---

### Task 1: Pure Monaco outline projection

**Files:**
- Create: `apps/desktop/src/monacoOutlineProjection.ts`
- Create: `apps/desktop/src/monacoOutlineProjection.test.ts`

**Interfaces:**
- Consumes: generated `NoteView` and `OutlineIndex`.
- Produces: `MonacoOutlineLine`, `MonacoOutlineProjection`,
  `buildMonacoOutlineProjection(nodes, index, rootId, titleForId)`, and
  `planMonacoProjectionEdit(previous, next)`.

- [ ] **Step 1: Write the failing projection tests**

Cover literal fixtures for text order, draft text, depth, read-only image
lines, one-based node lookup, inserted-line reconciliation, removed-line
reconciliation, and a one-line text replacement. The mutation caught is a
full-document replacement or stale node-to-line identity after structure
changes.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm run test --prefix apps/desktop -- monacoOutlineProjection.test.ts
```

Expected: FAIL because `monacoOutlineProjection.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure projection**

Use these public types:

```ts
export interface MonacoOutlineLine {
  readonly nodeId: string;
  readonly text: string;
  readonly depth: number;
  readonly editable: boolean;
}

export interface MonacoProjectionEdit {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
  readonly text: string;
}
```

The differential planner finds the longest identical prefix and suffix by
`nodeId`, `text`, `depth`, and `editable`, then emits at most one contiguous
replacement. Empty-to-nonempty and nonempty-to-empty projections are explicit
branches.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Task 1 command and expect all projection tests to pass.

- [ ] **Step 5: Commit the projection slice**

```powershell
git add apps/desktop/src/monacoOutlineProjection.ts apps/desktop/src/monacoOutlineProjection.test.ts
git commit -m "feat(v2): add Monaco outline projection"
```

### Task 2: Monaco editor lifecycle and A/B surface

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `package-lock.json`
- Create: `apps/desktop/src/outlineSurface.ts`
- Create: `apps/desktop/src/outlineSurface.test.ts`
- Create: `apps/desktop/src/MonacoOutlineSurface.tsx`
- Modify: `apps/desktop/src/NotesOutline.tsx`
- Modify: `apps/desktop/src/notes.css`

**Interfaces:**
- Consumes: Task 1 projection and the already-derived `bodyNodes`,
  `OutlineIndex`, `outlineRootId`, and `NotesStore`.
- Produces: `outlineSurfaceFromSearch(search): "react" | "monaco"` and
  `MonacoOutlineSurface`.

- [ ] **Step 1: Write the failing surface-selection test**

Assert literal results:

```ts
expect(outlineSurfaceFromSearch("")).toBe("react");
expect(outlineSurfaceFromSearch("?outline=monaco")).toBe("monaco");
expect(outlineSurfaceFromSearch("?outline=unknown")).toBe("react");
```

The mutation caught is accidentally shipping Monaco as the control path or
accepting an unknown mode.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm run test --prefix apps/desktop -- outlineSurface.test.ts
```

Expected: FAIL because `outlineSurface.ts` does not exist.

- [ ] **Step 3: Add Monaco and the lazy host**

Install exactly `monaco-editor@0.53.0` in `apps/desktop`. Dynamically import the
Monaco surface only when selected. Create and dispose one editor and one model
per mounted pane, set the initial projection once, apply later Task 1 edits
with `executeEdits`, and restore selection by node ID after reconciliation.

- [ ] **Step 4: Match the existing text geometry**

Configure public options with no line numbers, minimap, glyph margin chrome,
overview ruler, code suggestions, bracket behavior, smooth scrolling, or extra
bottom space. Use the existing Notes font stack and the current row's 28px
minimum line geometry.
Add scoped bullet and depth decorations without changing shell CSS.

- [ ] **Step 5: Run focused tests, build, and inspect the chunks**

Run:

```powershell
npm run test --prefix apps/desktop -- outlineSurface.test.ts monacoOutlineProjection.test.ts
npm run build --prefix apps/desktop
```

Expected: tests pass; the control entry remains below the existing budget and
Monaco appears as a lazy chunk rather than in the control entry.

- [ ] **Step 6: Commit the host slice**

```powershell
git add package-lock.json apps/desktop/package.json apps/desktop/src/outlineSurface.ts apps/desktop/src/outlineSurface.test.ts apps/desktop/src/MonacoOutlineSurface.tsx apps/desktop/src/NotesOutline.tsx apps/desktop/src/notes.css
git commit -m "feat(v2): add experimental Monaco outline surface"
```

### Task 3: Same-line editing and IME persistence

**Files:**
- Create: `apps/desktop/src/monacoOutlineController.ts`
- Create: `apps/desktop/src/monacoOutlineController.test.ts`
- Modify: `apps/desktop/src/MonacoOutlineSurface.tsx`

**Interfaces:**
- Consumes: current projection, Monaco content-change ranges, composition
  state, and `NotesStore.setDraft`.
- Produces: `MonacoOutlineController.applyContentChange(change)` and
  composition-safe draft publication.

- [ ] **Step 1: Write the failing controller tests**

Use a real projection and a small recording draft port. Prove that a same-line
edit publishes exactly that node's literal title, edits touching a read-only
image line are rejected, multi-line changes are classified as structural, and
composition defers publication until composition ends. The mutation caught is
publishing a draft to the wrong node after a prior insertion.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm run test --prefix apps/desktop -- monacoOutlineController.test.ts
```

Expected: FAIL because the controller does not exist.

- [ ] **Step 3: Implement the controller and wire Monaco events**

The controller receives a `publishDraft(nodeId, text)` port. The React adapter
uses `model.onDidChangeContent`, `editor.onDidCompositionStart`, and
`editor.onDidCompositionEnd`; adapter-owned reconciliation changes are ignored.

- [ ] **Step 4: Run Task 3 tests and the existing draft guards**

Run:

```powershell
npm run test --prefix apps/desktop -- monacoOutlineController.test.ts notesStore.test.ts storeSubscriptions.test.ts
```

Expected: all selected tests pass and the existing row-isolation contracts are
unchanged.

- [ ] **Step 5: Commit the editing slice**

```powershell
git add apps/desktop/src/monacoOutlineController.ts apps/desktop/src/monacoOutlineController.test.ts apps/desktop/src/MonacoOutlineSurface.tsx
git commit -m "feat(v2): persist Monaco outline drafts"
```

### Task 4: Structural keyboard and history bridge

**Files:**
- Create: `apps/desktop/src/monacoOutlineKeyboard.ts`
- Create: `apps/desktop/src/monacoOutlineKeyboard.test.ts`
- Modify: `apps/desktop/src/MonacoOutlineSurface.tsx`
- Modify: `apps/desktop/src/NotesOutline.tsx`
- Modify: `apps/desktop/src/NotesDetailPanes.tsx`
- Modify: `apps/desktop/src/App.tsx`

**Interfaces:**
- Consumes: Monaco key event, selection, projection, `OutlineIndex`, existing
  optimistic NotesStore operations, and application Undo/Redo callbacks.
- Produces: `resolveMonacoOutlineGesture(input)` plus pane-local execution that
  returns the desired `{ nodeId, column }` caret target.

- [ ] **Step 1: Write failing literal gesture tests**

Cover Enter at start/middle/end, repeated Enter tail ownership, non-boundary
Backspace, start-of-line merge, empty-line removal, Tab, Shift+Tab, Korean
composition guard, Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, and ordinary Arrow keys. The
mutation caught is allowing Monaco to insert a raw newline without creating a
Yonalist node or allowing two Undo authorities to run.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm run test --prefix apps/desktop -- monacoOutlineKeyboard.test.ts
```

Expected: FAIL because `monacoOutlineKeyboard.ts` does not exist.

- [ ] **Step 3: Implement minimal gesture resolution**

Return explicit intents:

```ts
type MonacoOutlineGesture =
  | { readonly kind: "native" }
  | { readonly kind: "split"; readonly nodeId: string; readonly offset: number }
  | { readonly kind: "mergeBackward"; readonly nodeId: string }
  | { readonly kind: "removeEmpty"; readonly nodeId: string }
  | { readonly kind: "indent"; readonly nodeId: string }
  | { readonly kind: "outdent"; readonly nodeId: string }
  | { readonly kind: "undo" }
  | { readonly kind: "redo" }
  | { readonly kind: "consume" };
```

Arrow keys and same-line Backspace return `native`. Composition returns
`native`; Enter during composition never becomes structural.

- [ ] **Step 4: Execute through existing authorities**

Use `beginSplitNode`, `beginMergeNodeBackward`, `beginRemoveEmptyNode`,
`indent`, and `outdent`. Reconcile immediately from the optimistic store
snapshot and set the Monaco position by the returned node ID. Pass the existing
`NotesInteractionHistory.undo/redo` callbacks from `App` so Monaco's own
history never runs.

- [ ] **Step 5: Run keyboard, store, and split owning tests**

Run:

```powershell
npm run test --prefix apps/desktop -- monacoOutlineKeyboard.test.ts outlineKeyboard.test.ts notesStore.test.ts splitPaneIntegration.test.tsx
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit the keyboard slice**

```powershell
git add apps/desktop/src/monacoOutlineKeyboard.ts apps/desktop/src/monacoOutlineKeyboard.test.ts apps/desktop/src/MonacoOutlineSurface.tsx apps/desktop/src/NotesOutline.tsx apps/desktop/src/NotesDetailPanes.tsx apps/desktop/src/App.tsx
git commit -m "feat(v2): bridge Monaco outline gestures"
```

### Task 5: Runtime proof and performance decision record

**Files:**
- Create: `apps/desktop/src/monacoOutlinePerformance.test.ts`
- Modify: `docs/v2/performance.md`
- Create: `docs/superpowers/reports/2026-07-30-yonalist-v2-monaco-outline-spike.md`

**Interfaces:**
- Consumes: final React and Monaco A/B surfaces.
- Produces: reproducible control/experiment measurements and an explicit
  adopt, continue, or reject decision.

- [ ] **Step 1: Add a deterministic projection performance guard**

Build literal 5,000-row projections, perform 200 single-line updates and 100
line insertions, and assert that each reconciliation emits one bounded edit
rather than a full-model replacement. Record timings as diagnostics; the
behavioral assertion is bounded edit scope, not a machine-sensitive duration.

- [ ] **Step 2: Run the focused performance test**

Run:

```powershell
npm run test --prefix apps/desktop -- monacoOutlinePerformance.test.ts
```

Expected: PASS with bounded edits for all samples.

- [ ] **Step 3: Start a fresh preview and exercise the manual contract**

Run:

```powershell
npm run v2:dev
```

Compare `http://127.0.0.1:1421/` and
`http://127.0.0.1:1421/?outline=monaco` using the Manual Proof in the design.
Use isolated preview data and restore it before finishing.

- [ ] **Step 4: Freeze and run the frontend gates once**

Run:

```powershell
npm run test:v2:frontend
npm run lint:v2
npm run v2:build
npm run test:v2:architecture
npm run test:v2:contracts
git diff --check
```

Cargo, Rust formatting, and Clippy are explicitly skipped because this spike
does not change Rust, IPC payloads, persistence, or native configuration.

- [ ] **Step 5: Write the decision report and commit**

Record baseline and experiment raw/gzip chunks, key interaction evidence,
unsupported parity rows, and the next decision without weakening existing
budgets.

```powershell
git add apps/desktop/src/monacoOutlinePerformance.test.ts docs/v2/performance.md docs/superpowers/reports/2026-07-30-yonalist-v2-monaco-outline-spike.md
git commit -m "docs(v2): record Monaco outline spike"
```
