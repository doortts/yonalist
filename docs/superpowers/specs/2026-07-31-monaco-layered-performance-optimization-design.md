# Monaco Layered Performance Optimization Design

**Date:** 2026-07-31

**Status:** Approved design; implementation plan pending

## Summary

The Monaco-authoritative outliner will keep its current visual design and
editing semantics while its performance work is separated into five measured
layers: an isolated benchmark harness, Monaco-only idle preloading, selective
runtime loading, bounded lifetime diagnostics, and viewport-scoped visual
decorations.

The work remains behind `?outline=monaco`. The React outline remains the
default control and performance reference. No optimization may create a second
editing authority, replace Monaco's model after normal edits, or reimplement
native cursor, IME, selection, clipboard, and Undo/Redo behavior.

## Delivery Contract

| Field | Contract |
| --- | --- |
| Goal | Reduce time to the first editable Monaco frame and remove repeated-input tail degradation without changing visible behavior. |
| Acceptance | The same-machine benchmark gates in this document pass, the initial shell stays within budget, and focused interaction tests remain green. |
| Non-goals | No redesign, React outline rewrite, SQLite/schema change, IPC contract change, Monaco fork, or new editor feature. |
| Boundaries | React shell and outline surface, Vite development/build loading, Monaco editor/model/plugin, pane-local decoration rendering, and frontend tests. Rust, SQLite, and persisted formats are unchanged. |
| Manual proof | Fresh `?outline=monaco` preview: first editor appears, repeated Enter/Backspace and arrows remain responsive, Undo restores the exact model, split panes preserve independent scroll, and bullets never flash or disappear while scrolling. |

## Baseline

The comparison at `codex/monaco-outline-spike@09ca3c8` produced these
directional results on the same Windows development machine:

| Measurement | Monaco baseline | React v2 core | Workflowy |
| --- | ---: | ---: | ---: |
| Enter x20 browser median | 1,040 ms | 1,537 ms | 977 ms |
| ArrowDown x40 browser median | 1,050 ms | 1,101 ms | 947 ms |
| Warm reload to editable median | 665 ms | 375 ms | 965 ms remote |
| Initial editable JS gzip | 88.0 KB | 90.0 KB | N/A |
| Lazy Monaco JS gzip | 646.0 KB | N/A | N/A |

The late Monaco samples degraded to 5,517 ms for Enter x20 and 2,295 ms for
ArrowDown x40. The development runtime probe continuously published a sorted
copy and a DOM attribute after every measured key, then retained a rolling
500-sample buffer. Those results do not prove that the probe caused the tail,
but they make the current tail result unsuitable as a production-path gate.

The current model benchmark also proves that 5,000 lines can execute 200 text
edits and 100 line splits without `setValue`, with at most three decoration
lines changed per edit. It does not measure editor layout, paint, scrolling,
worker startup, or repeated-session lifetime growth.

## Goals

- Measure the production-shaped editor path without a permanently attached
  per-key probe.
- Start Monaco preloading only when `outline=monaco` is selected and only
  after the shell has painted.
- Reuse one loading promise across the React surface, session registry, Monaco
  API, worker factory, and benchmark-only loader.
- Remove unused Monaco contributions when public ESM entry points allow it.
- Detect listener, editor, pane, transition, metadata, decoration, and Undo
  lifetime growth with constant-time snapshots.
- Bound visual decoration work to the union of visible pane ranges plus a
  small overscan, without changing model text or bullet hit testing.
- Preserve the current Yonalist layout, typography, colors, focus behavior,
  Korean IME, native cursor behavior, split-model sharing, and persistence.

## Non-goals

- Do not fork Monaco during this delivery.
- Do not edit files under `node_modules`.
- Do not preload Monaco for the default React outline.
- Do not preload before the first shell paint.
- Do not add a service worker, remote CDN, or persisted preload cache.
- Do not change the Notes database, Rust command boundary, or generated IPC
  contracts.
- Do not make benchmark globals or development probes part of the production
  asset graph.
- Do not trade cursor, IME, Undo, accessibility, or visual correctness for a
  benchmark result.
- Do not claim Workflowy network startup numbers as directly comparable to a
  local preview.

## Performance Gates

Measurements use one fixed Windows machine, a fresh Vite process, a warm asset
cache for reload measurements, three warm-up runs, and at least 31 recorded
runs. Median and p95 are recorded; a five-sample maximum is not called p95.

| Gate | Required result |
| --- | --- |
| Monaco warm reload to editable | Median at or below 530 ms, at least 20% faster than the 665 ms baseline |
| Keydown to next painted frame | p95 at or below 20 ms for Enter, Backspace, and ArrowDown |
| Long tasks | Zero tasks at or above 50 ms during each bounded 31-sample input run |
| Repeated-session stability | The second 31-sample run is no more than 10% slower at p95 than the first |
| Lifetime stability | Editor, pane, listener, and decoration counts return to their baseline after mount/unmount and split open/close cycles |
| Model authority | Zero full-model replacements during normal edits, Undo, Redo, zoom, split, and scrolling |
| Initial shell budget | At or below 300 KB raw and 90 KB gzip |
| Monaco lazy graph | Must not grow from 2,519 KB raw / 646 KB gzip; reductions are reported but not manufactured by removing required behavior |
| Visual range | Scrolling and split panes show every visible bullet with no blank or late-decorated rows |

If a machine is too noisy to satisfy an absolute time gate, the same process
must run the unmodified baseline and candidate consecutively. The candidate
must still satisfy the relative gate and the report must retain both raw
series. A noisy rerun is not repeated merely to obtain a pass.

## Architecture

### 1. One-shot benchmark harness

The current `runtimeProbe` is replaced by a development-only harness that is
loaded only for an explicit benchmark query. It does not subscribe for the
life of the editor and does not write JSON to a DOM attribute after each key.

The harness owns one bounded run:

1. attach timing and `PerformanceObserver` listeners;
2. discard three warm-up samples;
3. collect exactly 31 recorded samples;
4. take one immutable summary containing the raw samples, median, p95, long
   tasks, line count, and session diagnostics;
5. disconnect every listener and observer;
6. expose the completed result to the browser driver once.

Normal development and production sessions attach no input timing listener.
The browser comparison continues to use real keyboard events. Deterministic
model tests remain separate and are never presented as renderer timings.

### 2. Monaco-only idle preloading

An `outlineRuntimeLoader` owns the single promise for the Monaco outline
runtime. `NotesOutline`, `LazyMonacoOutlineSessionRegistry`, and the benchmark
harness consume that loader instead of issuing independent dynamic imports.

Preloading is scheduled only when all conditions hold:

- `outlineSurfaceFromSearch(location.search) === "monaco"`;
- the shell has committed its first paint;
- the document is visible;
- no load is already active or complete.

`requestIdleCallback` is used when available with a bounded timeout so the
editor is not postponed indefinitely. A `requestAnimationFrame` followed by a
short timer is the fallback. Preloading downloads and evaluates the module but
does not create an editor, model, worker, database request, or session before
the surface needs it.

The actual surface acquisition awaits the same promise. Failure clears the
cached promise so a later explicit mount may retry once through the existing
unsupported-Monaco fallback path.

### 3. Selective public ESM loading

The runtime continues to use Monaco 0.53.0. The first optimization audits the
Vite manifest and import graph and removes imports that register features the
outliner disables. Required editor services, model APIs, text input, IME,
cursor, selection, clipboard, find, Undo/Redo, injected-text hit testing,
hidden areas, and editor worker support remain.

Internal Monaco imports already isolated by `internalAdapter.ts` stay version
pinned. New internal imports are not introduced merely to reduce bytes. If the
public ESM graph cannot meet the readiness target, the report records the
remaining dominant modules and proposes a separate Monaco-fork decision; this
delivery does not silently cross that boundary.

### 4. Constant-time lifetime diagnostics

`MonacoOutlineSession` exposes an immutable diagnostic snapshot with numeric
counters only. Production hot paths increment or decrement counters without
sorting, cloning large collections, serializing JSON, or touching the DOM.

The snapshot covers:

- bound editor count;
- metadata listener count;
- forward and reverse transition counts;
- current metadata-version count;
- live model-decoration count;
- full-model replacement count;
- maximum affected decoration lines per edit;
- persistence queue state and pending command count when available.

Pane bindings expose matching live editor, pane adapter, scroll listener, and
view-decoration counts to tests. Diagnostic access is read-only and cannot
mutate or retain Monaco objects.

Undo/Redo history remains Monaco-owned. Tests use the counters to determine
whether repeated edit/undo and split open/close cycles grow transition maps,
metadata versions, listeners, or decorations after the corresponding lifetime
has ended. A bounded active Undo history may grow while edits are intentionally
undoable; that is recorded separately from leaked lifetime state.

### 5. Pane-local viewport decorations

The current session-level `OutlineDecorationSet` initially decorates every
model line. That work is replaced only after the first four stages provide
evidence and tests.

Each editor pane owns a decoration collection for its visible line ranges plus
a fixed overscan. The pane adapter listens to Monaco visible-range and scroll
changes, coalesces updates to one animation frame, and refreshes only when the
desired range leaves the current decorated window. Split panes therefore keep
independent windows over the same canonical model.

Metadata edits invalidate only affected visible lines. Structural edits that
shift line numbers rebuild the bounded pane windows, not all page decorations.
Injected bullet text remains decoration-only, uses the same cursor-stop and
attached node ID contract, and never enters model text, selection, clipboard,
find, or persistence.

The overscan is selected by measurement and stored as a named constant. It
must cover at least one viewport above and below the current visible range so
normal wheel, Page Up, Page Down, and held arrow movement cannot reveal an
undecorated line before the next coalesced update.

## Component Boundaries

| Component | Responsibility |
| --- | --- |
| `outlineRuntimeLoader` | Shared runtime promise, Monaco-query check, first-paint idle scheduling, retry state |
| `MonacoOutlineSurface` | Await runtime, create/dispose editor, bind pane/session; no benchmark policy |
| development benchmark virtual module | Load and run the one-shot harness only for an explicit query |
| one-shot input harness | Bounded timing lifecycle, raw samples, percentiles, long-task observation, final teardown |
| `MonacoOutlineSession` diagnostics | O(1) session/model/transition/listener counters |
| pane decoration window | Pane-local visible range, overscan, coalesced updates, injected bullet collection |
| `internalAdapter` | Existing pinned Monaco internals only |
| bundle report | Manifest-derived initial and lazy asset totals with module attribution |

The runtime loader must not import from React components. The benchmark
harness must not be imported by production runtime files. Pane decorations may
read session metadata but may not enqueue persistence commands or edit model
text.

## Data Flow

### Startup

1. The React shell commits.
2. The app detects `outline=monaco` without importing Monaco.
3. After the first paint, the loader schedules one idle import promise.
4. When `NotesOutline` mounts its Monaco surface, it awaits the same promise.
5. The surface acquires the page session, then creates the editor and pane
   decoration window.
6. The worker is created only when Monaco requests it.

### Input

1. Monaco receives the native key and updates its canonical model and cursor.
2. The session interprets the bounded content change and updates metadata.
3. Each pane invalidates only the affected part of its current decoration
   window.
4. Persistence remains asynchronous and outside the painted input path.
5. A benchmark run, when explicitly active, observes the bounded event-to-frame
   interval and detaches after its 31 samples.

### Scroll and split

1. Monaco virtualizes text lines normally.
2. Each pane calculates its own visible plus overscan range.
3. Scroll events coalesce one decoration-window refresh per animation frame.
4. Both panes continue to share model and metadata, but never share scroll,
   hidden areas, view state, or decoration-window lifetime.

## Failure Handling

- An idle preload failure clears its cached promise and records no permanent
  unsupported state.
- An explicit surface load failure uses the existing React fallback and
  unsupported message path.
- Unsupported `requestIdleCallback` uses the paint-plus-timer fallback.
- `PerformanceObserver` absence disables long-task collection but not sample
  timing; the result identifies the unavailable capability.
- A benchmark timeout fails the run and tears down listeners; partial results
  are not accepted as a pass.
- Decoration-window errors dispose the pane collection and fail to the existing
  unsupported-Monaco path rather than modifying model text.
- Session disposal flushes persistence before disposing listeners,
  decorations, model, and diagnostics exactly once.

## Testing Strategy

Every production change follows test-first red/green/refactor cycles.

### Focused unit tests

- the loader does nothing for the React query;
- Monaco preload runs after a first paint and one idle callback;
- multiple callers share exactly one import promise;
- preload failure permits one later explicit retry;
- the one-shot harness discards warmups, records 31 samples, computes correct
  median/p95, observes long tasks, and fully disconnects;
- no benchmark global or listener exists without the explicit query;
- diagnostic counters return to baseline after editor unbind and session
  disposal;
- redo pruning reduces transition counters;
- split panes maintain independent decoration windows;
- scroll bursts coalesce into one update;
- visible and overscan lines always receive bullets, while off-window lines do
  not;
- structural line shifts refresh the bounded window without model replacement.

### Owning frontend tests

- Monaco native editing, middle-text Enter, boundary Backspace, repeated Enter
  and Backspace, Tab/Shift+Tab, Korean IME, Undo/Redo, zoom, split model sharing,
  bullet click, reload persistence, and fallback remain green;
- 5,000-line deterministic edits retain zero full-model replacements;
- mount/unmount and split open/close lifetime tests show stable counters.

### Fresh runtime proof

- start a fresh Vite process and confirm the served source contains the new
  loader;
- run the 31-sample browser harness without the old continuous probe;
- run the fixed warm-reload-to-editable protocol;
- scroll and hold arrow keys through a large outline in both panes;
- inspect the completed diagnostics snapshot after repeated edit/undo cycles;
- build production assets and verify the manifest budgets and absence of the
  benchmark harness from the production graph.

### Final frontend gates

Because this design changes frontend and Vite boundaries only, the final gate
is one clean run of `npm test`, `npm run lint`, `npm run build`, and
`git diff --check`. Cargo tests, Rust formatting, and Clippy are explicitly
skipped because Rust, native configuration, IPC payloads, persistence, and
SQLite do not change.

## Delivery Sequence

1. Replace the continuous runtime probe with the bounded one-shot benchmark
   harness and establish a trustworthy 31-sample baseline.
2. Add Monaco-query-only first-paint idle preloading through one shared loader
   promise and remeasure editor readiness.
3. Audit and reduce public ESM imports while protecting required editor
   capabilities and bundle budgets.
4. Add constant-time lifetime diagnostics and eliminate any reproduced
   listener, transition, decoration, or session leak.
5. Move injected bullets to pane-local viewport windows with overscan and
   remeasure large-outline scrolling and split panes.

Each stage ends with its focused tests and before/after evidence. A later stage
does not hide a regression introduced by an earlier one. If a stage cannot
meet its gate without changing editing semantics, it is reverted or redesigned
instead of being retained as dormant complexity.

## Rollback and Escalation

All work remains behind `?outline=monaco`, so the React outline is the runtime
fallback. A stage that fails behavior or performance gates is reverted at its
own boundary.

A Monaco source fork requires a separate approved design containing the pinned
source revision, patch ownership, upgrade procedure, security update policy,
and reproducible build. Failure of public ESM optimization alone does not
authorize that fork.
