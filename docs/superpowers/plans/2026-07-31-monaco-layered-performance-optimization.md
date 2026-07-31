# Monaco Layered Performance Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce Monaco first-edit readiness and repeated-input tail latency while preserving the current visual design and Monaco-native editing behavior.

**Architecture:** A single lazy runtime loader owns Monaco import and Monaco-query-only idle preload. A bounded development harness replaces the continuous per-key probe, constant-time diagnostics expose lifetime growth, and pane-local decoration windows keep injected bullets near visible ranges without changing canonical model text.

**Tech Stack:** React 19, TypeScript 6, Vite 8 virtual modules, Vitest 4, Monaco Editor 0.53.0, Tauri v2 shell.

## Global Constraints

- Keep the existing design, layout, typography, colors, and keyboard behavior unchanged.
- Keep `MonacoOutlineSession.model` as the only in-memory edit authority.
- Keep the React outline as the default and runtime fallback.
- Run idle preload only when `outline=monaco`, after the first shell paint, while the document is visible.
- Keep benchmark code out of the production asset graph.
- Do not fork Monaco or edit `node_modules`.
- Do not change Rust, SQLite, IPC payload contracts, or persisted formats.
- Preserve native IME, cursor, selection, clipboard, find, and Undo/Redo.
- Keep the initial shell at or below 300 KB raw / 90 KB gzip.
- Use three warmups and 31 recorded browser samples; report median and p95.
- Target warm reload to editable median at or below 530 ms, key-to-frame p95 at or below 20 ms, and zero 50 ms long tasks.

---

### Task 1: Replace the continuous probe with a bounded benchmark run

**Files:**
- Modify: `apps/desktop/src/monaco-outline/runtimeProbe.test.ts`
- Modify: `apps/desktop/src/monaco-outline/runtimeProbe.ts`
- Modify: `apps/desktop/src/monaco-outline/runtimeProbeVirtual.d.ts`
- Modify: `apps/desktop/vite.config.ts`
- Modify: `apps/desktop/src/MonacoOutlineSurface.tsx`

**Interfaces:**
- Consumes: `IStandaloneCodeEditor.onKeyDown`, `requestAnimationFrame`, `PerformanceObserver`, `MonacoOutlineSession.metrics`.
- Produces: `attachBenchmarkRun(editor, session, options?) => IDisposable` and `window.__YONALIST_MONACO_BENCHMARK__?.result() => MonacoOutlineBenchmarkResult | null`.
- The default options are exactly `{ warmupSamples: 3, recordedSamples: 31 }`.

- [ ] **Step 1: Write the failing bounded-lifetime test**

Replace the existing continuous-probe expectation with a test that dispatches
33 keydowns and proves no result exists, dispatches the 34th keydown, then
proves one immutable result is published and the listener is removed:

```ts
const attachment = attachBenchmarkRun(editor, session);
for (let index = 0; index < 33; index += 1) {
  keyDownListeners.forEach((listener) => listener());
  await vi.advanceTimersByTimeAsync(20);
}
expect(window.__YONALIST_MONACO_BENCHMARK__?.result()).toBeNull();

keyDownListeners.forEach((listener) => listener());
await vi.advanceTimersByTimeAsync(20);

expect(window.__YONALIST_MONACO_BENCHMARK__?.result()?.samples)
  .toHaveLength(31);
expect(keyDownListeners.size).toBe(0);
expect(host.hasAttribute("data-monaco-outline-probe")).toBe(false);
attachment.dispose();
```

Add a second test proving early `dispose()` disconnects the key listener and
observer without publishing a partial result.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm run test --prefix apps/desktop -- src/monaco-outline/runtimeProbe.test.ts
```

Expected: FAIL because `attachBenchmarkRun` and
`__YONALIST_MONACO_BENCHMARK__` do not exist.

- [ ] **Step 3: Implement the bounded harness**

Use one final publish and immediate teardown:

```ts
export interface MonacoOutlineBenchmarkResult {
  readonly samples: readonly number[];
  readonly median: number;
  readonly p95: number;
  readonly longTasks: number | null;
  readonly lineCount: number;
  readonly modelSetValueCount: number;
}

export function attachBenchmarkRun(
  editor: monaco.editor.IStandaloneCodeEditor,
  session: MonacoOutlineSession,
  options = { warmupSamples: 3, recordedSamples: 31 }
): monaco.IDisposable {
  // Record keydown-to-animation-frame durations.
  // Ignore the first three completed frames.
  // Freeze exactly 31 remaining samples, publish once, and disconnect.
}
```

The global controller exposes only `result()`. It returns `null` before the
run finishes. Remove per-key DOM serialization and the rolling 500-sample
buffer. Report `longTasks: null` when long-task observation is unavailable.

- [ ] **Step 4: Gate the virtual module with an explicit query**

The serve-only virtual module calls the harness only for
`benchmark=monaco`; every production build exports a no-op:

```ts
if (new URLSearchParams(location.search).get("benchmark") !== "monaco") {
  return null;
}
return attachBenchmarkRun(editor, session);
```

Rename the surface import to `attachDevelopmentBenchmarkRun` and keep its
effect lifecycle unchanged.

- [ ] **Step 5: Verify GREEN and the production graph**

Run:

```powershell
npm run test --prefix apps/desktop -- src/monaco-outline/runtimeProbe.test.ts src/MonacoOutlineSurface.test.tsx
npm run build --prefix apps/desktop
rg -n "YONALIST_MONACO_BENCHMARK|attachBenchmarkRun" apps/desktop/dist
```

Expected: tests PASS, build PASS, and `rg` finds no benchmark implementation
in production assets.

- [ ] **Step 6: Commit Task 1**

```powershell
git add apps/desktop/vite.config.ts apps/desktop/src/MonacoOutlineSurface.tsx apps/desktop/src/monaco-outline/runtimeProbe.ts apps/desktop/src/monaco-outline/runtimeProbe.test.ts apps/desktop/src/monaco-outline/runtimeProbeVirtual.d.ts
git commit -m "perf(monaco): bound runtime benchmark sampling"
```

---

### Task 2: Share one Monaco runtime promise and preload after first paint

**Files:**
- Create: `apps/desktop/src/monaco-outline/runtimeLoader.ts`
- Create: `apps/desktop/src/monaco-outline/runtimeLoader.test.ts`
- Create: `apps/desktop/src/monaco-outline/runtime.ts`
- Modify: `apps/desktop/src/monaco-outline/lazyRegistry.ts`
- Modify: `apps/desktop/src/NotesOutline.tsx`
- Modify: `apps/desktop/src/App.tsx`

**Interfaces:**
- Consumes: existing `MonacoOutlineSurface`, `MonacoOutlineSessionRegistry`, and `outlineSurfaceFromSearch(search)`.
- Produces: `loadMonacoOutlineRuntime()`, `preloadMonacoOutlineRuntime(search, scheduler?)`, and `resetMonacoOutlineRuntimeForTests()`.
- `MonacoOutlineRuntime` contains `{ Surface, MonacoOutlineSessionRegistry }`.

- [ ] **Step 1: Write failing loader tests**

Create tests with injected import and scheduling functions proving:

```ts
expect(preload("?outline=react", scheduler)).toBe(false);
expect(scheduler.animationFrame).not.toHaveBeenCalled();

expect(preload("?outline=monaco", scheduler)).toBe(true);
scheduler.runAnimationFrame();
expect(importRuntime).not.toHaveBeenCalled();
scheduler.runIdle();
expect(importRuntime).toHaveBeenCalledOnce();

const [first, second] = await Promise.all([loader.load(), loader.load()]);
expect(first).toBe(second);
expect(importRuntime).toHaveBeenCalledOnce();
```

Add a failure test: rejected preload clears the promise and the next explicit
`load()` calls the importer once more. Add a hidden-document test that does not
schedule a preload.

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
npm run test --prefix apps/desktop -- src/monaco-outline/runtimeLoader.test.ts
```

Expected: FAIL because `runtimeLoader.ts` does not exist.

- [ ] **Step 3: Implement the runtime module and loader**

`runtime.ts` is the only runtime aggregation point:

```ts
export { default as Surface } from "../MonacoOutlineSurface";
export { MonacoOutlineSessionRegistry } from "./sessionRegistry";
```

`runtimeLoader.ts` owns one promise and a testable scheduler:

```ts
export interface MonacoOutlineRuntime {
  readonly Surface: typeof import("../MonacoOutlineSurface").default;
  readonly MonacoOutlineSessionRegistry:
    typeof import("./sessionRegistry").MonacoOutlineSessionRegistry;
}

export function loadMonacoOutlineRuntime(): Promise<MonacoOutlineRuntime> {
  runtimePromise ??= import("./runtime").catch((cause) => {
    runtimePromise = null;
    throw cause;
  });
  return runtimePromise;
}
```

Schedule `requestAnimationFrame` first, then `requestIdleCallback` with a
1,000 ms timeout. Use a zero-delay timer after the animation frame when idle
callbacks are unavailable. Do not construct the editor or worker.

- [ ] **Step 4: Route every runtime consumer through the loader**

Change `NotesOutline` to:

```ts
const MonacoOutlineSurface = lazy(() =>
  loadMonacoOutlineRuntime().then(({ Surface }) => ({ default: Surface }))
);
```

Change `LazyMonacoOutlineSessionRegistry.load()` to obtain
`MonacoOutlineSessionRegistry` from the same promise. In `App`, schedule the
preload in an effect after the shell mounts. Preserve existing load-error
fallback behavior.

- [ ] **Step 5: Verify GREEN and load-boundary regression tests**

```powershell
npm run test --prefix apps/desktop -- src/monaco-outline/runtimeLoader.test.ts src/outlineSurface.test.ts src/MonacoOutlineSurface.test.tsx src/monaco-outline/sessionRegistry.test.ts
npm run build --prefix apps/desktop
```

Expected: tests and build PASS; the React query never imports Monaco; both
Monaco consumers share one runtime chunk.

- [ ] **Step 6: Commit Task 2**

```powershell
git add apps/desktop/src/App.tsx apps/desktop/src/NotesOutline.tsx apps/desktop/src/monaco-outline/lazyRegistry.ts apps/desktop/src/monaco-outline/runtime.ts apps/desktop/src/monaco-outline/runtimeLoader.ts apps/desktop/src/monaco-outline/runtimeLoader.test.ts
git commit -m "perf(monaco): preload one shared runtime"
```

---

### Task 3: Attribute and reduce the public Monaco ESM graph

**Files:**
- Create: `scripts/reportMonacoBundle.mjs`
- Create: `scripts/reportMonacoBundle.test.mjs`
- Modify: `package.json`
- Modify only when evidence permits: `apps/desktop/src/MonacoOutlineSurface.tsx`
- Modify only when evidence permits: `apps/desktop/src/monaco-outline/internalAdapter.ts`

**Interfaces:**
- Consumes: Vite `manifest.json`, generated asset files, and the Monaco runtime entry emitted by Task 2.
- Produces: `npm run report:v2:monaco-bundle` with initial/lazy raw and gzip totals plus the largest Monaco assets.

- [ ] **Step 1: Write a failing manifest-attribution test**

Create a temporary manifest fixture containing an initial entry, a dynamic
Monaco runtime, Monaco CSS, and worker asset. Assert the report returns:

```js
assert.deepEqual(report, {
  initial: { raw: 300, gzip: 120 },
  monacoJavaScript: { raw: 900, gzip: 330 },
  monacoCss: { raw: 100, gzip: 40 },
  workers: { raw: 200 },
  largestMonacoAssets: ["assets/runtime-monaco.js"]
});
```

- [ ] **Step 2: Run the report test and verify RED**

```powershell
node --test scripts/reportMonacoBundle.test.mjs
```

Expected: FAIL because the reporter does not exist.

- [ ] **Step 3: Implement manifest attribution**

Export `readMonacoBundleReport({ root, manifestPath })`. Traverse manifest
imports and dynamic imports without double-counting assets, read generated
bytes, calculate gzip with `node:zlib`, and classify the worker separately.
The CLI prints stable JSON suitable for before/after comparison.

Add:

```json
"report:v2:monaco-bundle": "npm run v2:build && node scripts/reportMonacoBundle.mjs"
```

- [ ] **Step 4: Audit public ESM imports**

Build once and record the report. Inspect the emitted runtime import graph and
the source imports rooted at `monaco-editor/esm/vs/editor/editor.api`. Remove
an import only if all of these focused behaviors remain covered: model create,
standalone editor create, plaintext mode, text input/IME, selection, clipboard,
find, cursor movement, Undo/Redo, hidden areas, injected text, and worker
creation. Do not add a new internal Monaco import solely to save bytes.

- [ ] **Step 5: Verify the graph and capability suite**

```powershell
node --test scripts/reportMonacoBundle.test.mjs
npm run test --prefix apps/desktop -- src/monaco-outline/internalAdapter.test.ts src/monaco-outline/nativeEditing.test.ts src/MonacoOutlineSurface.test.tsx
npm run report:v2:monaco-bundle
```

Expected: tests PASS, initial shell remains at or below 300 KB raw / 90 KB
gzip, and the lazy graph does not exceed 2,519 KB raw / 646 KB gzip. If no
safe public import reduction exists, commit only the truthful attribution tool
and its measured report path.

- [ ] **Step 6: Commit Task 3**

```powershell
git add package.json scripts/reportMonacoBundle.mjs scripts/reportMonacoBundle.test.mjs apps/desktop/src/MonacoOutlineSurface.tsx apps/desktop/src/monaco-outline/internalAdapter.ts
git commit -m "perf(monaco): attribute lazy bundle cost"
```

---

### Task 4: Add constant-time session and pane lifetime diagnostics

**Files:**
- Modify: `apps/desktop/src/monaco-outline/metadata.ts`
- Modify: `apps/desktop/src/monaco-outline/decorations.ts`
- Modify: `apps/desktop/src/monaco-outline/persistenceQueue.ts`
- Modify: `apps/desktop/src/monaco-outline/session.ts`
- Modify: `apps/desktop/src/monaco-outline/session.test.ts`
- Modify: `apps/desktop/src/monaco-outline/paneAdapter.ts`
- Modify: `apps/desktop/src/monaco-outline/paneAdapter.test.ts`

**Interfaces:**
- Produces: `MonacoOutlineSession.diagnostics(): MonacoOutlineSessionDiagnostics` and `MonacoOutlinePaneAdapter.diagnostics(): MonacoOutlinePaneDiagnostics`.
- Snapshots contain numbers and scalar persistence state only; no Monaco object, array clone, map clone, or DOM serialization.

- [ ] **Step 1: Write failing session lifetime tests**

Assert exact counters before and after editor binding, metadata subscription,
edit, Undo, redo-branch pruning, and disposal:

```ts
expect(session.diagnostics()).toMatchObject({
  boundEditors: 0,
  metadataListeners: 0,
  forwardTransitions: 0,
  reverseTransitions: 0,
  metadataVersions: 1,
  modelDecorations: 1,
  pendingPersistenceCommands: 0
});
const unbind = session.bindEditor(editor);
expect(session.diagnostics().boundEditors).toBe(1);
unbind();
expect(session.diagnostics().boundEditors).toBe(0);
```

The prune test creates edit A, undoes it, creates edit B, and proves the
invalid redo transition counters are removed rather than accumulated.

- [ ] **Step 2: Run session tests and verify RED**

```powershell
npm run test --prefix apps/desktop -- src/monaco-outline/session.test.ts
```

Expected: FAIL because the diagnostics interface does not exist.

- [ ] **Step 3: Implement O(1) getters and counters**

Add size getters to metadata, decoration, and persistence ownership classes.
Build the session snapshot directly from existing `Set.size`, `Map.size`, and
numeric metrics:

```ts
diagnostics(): MonacoOutlineSessionDiagnostics {
  return Object.freeze({
    boundEditors: this.boundEditors.size,
    metadataListeners: this.metadataListeners.size,
    forwardTransitions: this.transitionsFrom.size,
    reverseTransitions: this.transitionsTo.size,
    metadataVersions: this.metadata.versionCount,
    modelDecorations: this.decorations.size,
    pendingPersistenceCommands: this.persistenceQueue.pendingCommandCount,
    persistenceKind: this.persistenceQueue.getSnapshot().kind,
    fullModelReplacementCount: this.metricState.fullModelReplacementCount,
    maxDecorationLinesPerEdit: this.metricState.maxDecorationLinesPerEdit
  });
}
```

- [ ] **Step 4: Add pane lifetime counters and tests**

The pane snapshot reports whether it is disposed, the number of saved view
states, and its live subscriptions. Test that dispose unsubscribes metadata,
clears hidden areas and view state, and is idempotent.

- [ ] **Step 5: Verify GREEN and repeated lifecycle stability**

```powershell
npm run test --prefix apps/desktop -- src/monaco-outline/session.test.ts src/monaco-outline/paneAdapter.test.ts src/monaco-outline/sessionRegistry.test.ts
```

Expected: PASS; 20 bind/unbind and pane create/dispose cycles return all live
lifetime counters to the original values.

- [ ] **Step 6: Commit Task 4**

```powershell
git add apps/desktop/src/monaco-outline/metadata.ts apps/desktop/src/monaco-outline/decorations.ts apps/desktop/src/monaco-outline/persistenceQueue.ts apps/desktop/src/monaco-outline/session.ts apps/desktop/src/monaco-outline/session.test.ts apps/desktop/src/monaco-outline/paneAdapter.ts apps/desktop/src/monaco-outline/paneAdapter.test.ts
git commit -m "perf(monaco): expose bounded lifetime metrics"
```

---

### Task 5: Move injected bullets into pane-local viewport windows

**Files:**
- Create: `apps/desktop/src/monaco-outline/decorationWindow.ts`
- Create: `apps/desktop/src/monaco-outline/decorationWindow.test.ts`
- Modify: `apps/desktop/src/monaco-outline/decorations.ts`
- Modify: `apps/desktop/src/monaco-outline/session.ts`
- Modify: `apps/desktop/src/monaco-outline/paneAdapter.ts`
- Modify: `apps/desktop/src/monaco-outline/paneAdapter.test.ts`
- Modify: `apps/desktop/src/monaco-outline/plugin.test.ts`

**Interfaces:**
- Consumes: pane editor visible ranges, session metadata snapshots, existing `buildOutlineDecorations`, and injected bullet attached node IDs.
- Produces: `PaneDecorationWindow` with `invalidate(lines)`, `scheduleVisibleRangeUpdate()`, `diagnostics()`, and `dispose()`.
- Changes metadata subscription payload to `MetadataChange` with
  `affectedLineNumbers: readonly number[]` and `structural: boolean` so panes
  never infer invalidation by scanning the complete snapshot.
- Use named `VIEWPORT_OVERSCAN_MULTIPLIER = 1` for one viewport above and below.

- [ ] **Step 1: Write failing pure range tests**

For a 5,000-line model with visible lines 101-140, assert the calculated
window covers 61-180, clamps at the model boundaries, and remains unchanged
while the new visible range stays inside the current center viewport:

```ts
expect(decorationWindowFor({
  visibleStart: 101,
  visibleEnd: 140,
  lineCount: 5_000,
  overscanMultiplier: 1
})).toEqual({ startLineNumber: 61, endLineNumber: 180 });
```

- [ ] **Step 2: Run the range test and verify RED**

```powershell
npm run test --prefix apps/desktop -- src/monaco-outline/decorationWindow.test.ts
```

Expected: FAIL because the window module does not exist.

- [ ] **Step 3: Implement the pure range and pane collection**

Use `editor.createDecorationsCollection()` so each split pane owns its own
injected bullets. Read `editor.getVisibleRanges()`, calculate the union, add
one viewport above and below, and call `collection.set()` only when the desired
window changes or affected visible metadata changes. Perform one synchronous
initial refresh in the pane constructor; if Monaco has not reported a visible
range yet, derive the first bounded range from the cursor line, layout height,
and configured 25 px line height so the first painted editor never shows text
without bullets.

Coalesce later scroll and layout events with one animation frame. A test scheduler
must permit deterministic flushes without fake Monaco layout.

- [ ] **Step 4: Remove session-global visual decoration ownership**

Keep model/metadata transition metrics in the session, but move visual bullet
creation and disposal to `MonacoOutlinePaneAdapter`. `session.applyNormalEdit`
and Undo/Redo notify metadata listeners with a `MetadataChange` payload so each
pane invalidates only its own current window. Set `structural: true` when line
identity or line numbering may change; that rebuilds the bounded pane window.
Metadata-only indent/outdent uses `structural: false` with its exact affected
line numbers.

Preserve the existing decoration contract:

```ts
before: {
  content: "\u00a0".repeat(line.depth * 4) + "\u2022\u00a0\u00a0",
  cursorStops: monaco.editor.InjectedTextCursorStops.Right,
  attachedData: { kind: "yonalist-bullet", nodeId: line.nodeId }
}
```

- [ ] **Step 5: Prove split, scroll, hit testing, and disposal**

Tests must show:

- two panes decorate independent visible ranges over one model;
- rapid scroll events schedule one animation-frame update;
- Page Up/Down-sized jumps produce a decorated target window;
- metadata edits outside the window do not rebuild it;
- line insert/delete inside the window refreshes correct node IDs;
- bullet mouse attached data still routes same-pane and Shift+click navigation;
- disposal removes the pane collection and every scroll/layout listener;
- model text, copied text, and full-model replacement count remain unchanged.

- [ ] **Step 6: Run focused and owning tests**

```powershell
npm run test --prefix apps/desktop -- src/monaco-outline/decorationWindow.test.ts src/monaco-outline/decorations.test.ts src/monaco-outline/paneAdapter.test.ts src/monaco-outline/plugin.test.ts src/monaco-outline/nativeEditing.test.ts src/monaco-outline/performance.test.ts
```

Expected: PASS with at most a bounded pane window of decorations, zero normal
full-model replacements, and unchanged editing behavior.

- [ ] **Step 7: Commit Task 5**

```powershell
git add apps/desktop/src/monaco-outline/decorationWindow.ts apps/desktop/src/monaco-outline/decorationWindow.test.ts apps/desktop/src/monaco-outline/decorations.ts apps/desktop/src/monaco-outline/session.ts apps/desktop/src/monaco-outline/paneAdapter.ts apps/desktop/src/monaco-outline/paneAdapter.test.ts apps/desktop/src/monaco-outline/plugin.test.ts
git commit -m "perf(monaco): window pane bullet decorations"
```

---

### Task 6: Run fresh runtime evidence and final frontend gates

**Files:**
- Modify: `docs/v2/monaco-outline-spike-report.md`
- Modify: `docs/superpowers/plans/2026-07-31-monaco-layered-performance-optimization.md`

**Interfaces:**
- Consumes: completed benchmark global, diagnostics snapshots, Vite manifest report, and the same browser workload used for the baseline.
- Produces: one reproducible before/after table with raw series, median, p95, long tasks, readiness, bundle totals, and remaining risks.

- [ ] **Step 1: Start a fresh isolated preview**

Run a new Vite process on an unused fixed port with the current worktree and
verify its served source references `outlineRuntimeLoader`. Use the existing
preview fixture and do not reuse a process started before the build.

- [ ] **Step 2: Execute the 31-sample browser protocol**

Open `?outline=monaco&benchmark=monaco`, perform three warmups followed by 31
recorded Enter, Backspace, and ArrowDown samples, and capture the completed
one-shot result. Repeat once in the same editor lifetime to detect tail growth.
Record the full raw arrays before calculating median and p95.

- [ ] **Step 3: Measure readiness and Workflowy directionally**

Measure 31 warm cached reloads from navigation start until the editor is
editable. Run the same Enter x20 and ArrowDown x40 control-channel workload
against the fixed v2 core commit and the signed-in Workflowy page. Label the
remote Workflowy startup as context only.

- [ ] **Step 4: Measure bundle output**

```powershell
npm run report:v2:monaco-bundle
```

Record initial JS, Monaco lazy JS/CSS, worker raw bytes, and the largest Monaco
assets. Fail the stage if the initial shell exceeds 300 KB raw / 90 KB gzip or
the lazy graph grows beyond the approved baseline.

- [ ] **Step 5: Run final frontend gates once**

```powershell
npm test
npm run lint:v2
npm run v2:build
git diff --check
```

Expected: all applicable frontend tests, lint, build, and whitespace checks
PASS. Explicitly skip Cargo, Rust formatting, and Clippy because this plan does
not change Rust, native configuration, IPC payloads, persistence, or SQLite.

- [ ] **Step 6: Review the frozen diff**

Check `git status --short`, `git diff --stat`, and the complete diff. Confirm
no benchmark fixture, development global, test Vault data, generated timing
artifact, or server log is committed.

- [ ] **Step 7: Update evidence and commit Task 6**

Update the spike report with the exact commit, environment, raw series,
derived statistics, bundle report, behavior proof, and any gate that remains
unmet. Mark completed checkboxes in this plan without rewriting historical
requirements.

```powershell
git add docs/v2/monaco-outline-spike-report.md docs/superpowers/plans/2026-07-31-monaco-layered-performance-optimization.md
git commit -m "docs(monaco): record layered performance results"
```
