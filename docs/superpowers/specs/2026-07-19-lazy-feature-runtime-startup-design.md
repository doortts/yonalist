# Codebase Structure, Startup, and Maintenance Design

## Summary

Yonalist will improve the verified codebase weaknesses through three separate,
reviewable workstreams. The startup workstream splits synchronous feature
metadata from feature runtime code so the Inbox shell starts without importing
or evaluating Notes. The Notes structure workstream turns `useNotesWorkspace`
into a composition facade and moves cohesive behavior behind independently
tested controllers. The maintenance workstream reconciles historical plan
checkboxes with commits reachable from the current main branch.

This change also removes verified TypeScript dead code and makes the compiler
reject future unused locals and parameters. It does not perform speculative
Rust cleanup: focused Clippy checks currently report zero production no-effect,
unused-result, unused-variable, or dead-code findings.

## Goals

- Reduce the JavaScript required for an Inbox startup by at least 20% in both
  minified and gzip byte counts.
- Keep the main App chunk below Vite's 500,000-byte warning threshold.
- Prevent Notes and `@dnd-kit` modules from loading on an Inbox startup.
- Preserve Notes drafts, selection, scroll, and workspace session state after
  the user has opened Notes once and switches away and back.
- Give feature runtime loading one explicit lifecycle: idle, loading, ready, or
  failed, with user-triggered retry after failure.
- Remove all currently detected TypeScript unused declarations and keep them
  from returning.
- Prove performance changes with deterministic bundle measurements and repeated
  release-app runtime measurements.
- Reduce `useNotesWorkspace.ts` from its measured 4,959 lines to at most 1,500
  lines without changing its public behavior or context identity guarantees.
- Move controller-specific tests out of the 13,591-line
  `useNotesWorkspace.test.tsx` integration suite and reduce its dependence on
  mock call ordinals and Vitest invocation metadata.
- Reconcile every checkbox-bearing historical plan with commit and artifact
  evidence from the current main branch, without presenting abandoned or
  superseded work as complete.

## Non-goals

- A third-party plugin SDK, external feature discovery, or runtime feature
  installation.
- Unloading Notes after first activation. Retaining its live local workspace is
  a product requirement.
- Eager or idle prefetching of Notes. Such prefetching would move bytes back into
  the Inbox startup window and violate the bundle/request contract.
- Broad Rust style cleanup. Full `cargo clippy --all-targets -- -D warnings`
  currently reports style and API-shape findings, but the focused no-effect
  check reports no real Rust no-op. Changes without a measured startup benefit
  are excluded.
- Changing user-visible feature behavior, navigation order, auth rules, or
  Notes persistence semantics.
- Replacing one oversized hook with one oversized class or utility module. New
  extracted production modules must each remain at or below 1,500 lines.
- Deleting semantically important ordering tests. Ordering remains asserted
  where it is the behavior; only coupling to mock implementation details is
  removed.
- Marking a historical plan complete merely because a similarly named feature
  exists. Completion requires a reachable commit plus matching artifact or test
  evidence.

## Measured Baseline

The baseline was produced on 2026-07-19 with:

```text
npx vite build --manifest --sourcemap
```

The immediately requested startup graph consists of the entry, Rolldown
runtime, vendor, App, and shared SettingsCategoryPane chunks.

| Metric | Baseline |
| --- | ---: |
| Initial JavaScript | 1,146,420 bytes |
| Initial JavaScript, gzip | 346,049 bytes |
| App chunk | 692,446 bytes |
| App chunk, gzip | 199,599 bytes |
| Notes source files in App source map | 60 files |
| Notes source content in App source map | 944,599 bytes |
| `@dnd-kit` source files in App source map | 4 files |
| `@dnd-kit` source content in App source map | 133,557 bytes |

The source-map content numbers are evidence of coupling, not direct estimates
of compressed savings. Acceptance uses measured output chunk bytes instead.

The current correctness baseline is:

- Frontend: 154 test files passed, 1 skipped; 3,196 tests passed, 27 skipped.
- Frontend lint: zero errors.
- Frontend production build: passed, with the 692,446-byte App warning above.
- Rust: 628 tests passed, 3 ignored; zero failed.
- Focused Rust no-effect Clippy check: zero findings.
- TypeScript unused-declaration check: 17 findings, of which 9 are production
  declarations and 8 are test-only declarations or parameters.

Additional structure and maintenance baselines were measured directly from
current main at commit `57fee99`:

| Metric | Baseline | Required result |
| --- | ---: | ---: |
| `useNotesWorkspace.ts` | 4,959 lines | at most 1,500 lines |
| `useNotesWorkspace.test.tsx` | 13,591 lines | at most 5,500 lines |
| Ordinal/mock-order observations in that test | 149 lines | at most 25 lines |
| `toHaveBeenNthCalledWith` in that test | 14 lines | 0 lines |
| `invocationCallOrder` in that test | 10 lines | 0 lines |
| Indexed `mock.calls[...]` in that test | 125 lines | at most 25 lines |
| Ordinal/mock-order observations in all tests | 283 lines | no increase |
| Historical plans containing checkboxes | 23 files | 23 reconciled files |
| Historical plan checkboxes | 684 total | 684 evidence-reviewed |
| Checked historical boxes | 26 | matches reachable evidence |
| Unchecked historical boxes | 658 | complete, partial, or superseded state recorded |

The 4,959-line count is the current main-branch value. Earlier handoff material
records 5,194 and 3,491 lines at older commits; those historical numbers are not
used as the new baseline.

## Workstreams and Sequencing

The expanded scope contains three independently testable workstreams and will
produce separate implementation plans. They must not be combined into one
large code review.

1. **Startup and no-op cleanup:** add comparable measurement events, split the
   Notes runtime, enforce bundle budgets, and remove verified dead code. This
   remains first because startup speed is the user-selected priority.
2. **Notes facade and test de-brittling:** extract cohesive controllers from
   `useNotesWorkspace`, preserve its external contract, and move tests to the
   new ownership boundaries.
3. **Historical plan reconciliation:** audit checkbox evidence against the main
   commit graph and current artifacts. This changes documentation only and can
   be reviewed independently from runtime code.

Each workstream ends with its own verification evidence and commit series. A
failure in one does not justify weakening another workstream's acceptance gate.

## Architecture

### Feature catalog

The synchronous feature catalog contains navigation and policy metadata only:

- id, label, icon, section, and order;
- whether GitHub authentication is required;
- whether an activated runtime stays mounted;
- a runtime loader for features that are not eager.

Importing the catalog must not statically import `NotesFeature`. Inbox and the
small Settings feature adapter may remain eager because they do not dominate
the startup chunk. The catalog remains the single source for Sidebar entries,
auth decisions, ordering, and active-feature validation.

### Feature runtime

A runtime contains the behavior that currently lives on `FeatureDefinition`:

- the feature Provider;
- the function that renders its middle and detail panes.

Notes exports a runtime from its existing module. The catalog reaches that
runtime only through dynamic `import()`. This is a Loadable Registry pattern,
not a general plugin framework.

### Feature runtime host

One host owns runtime lifecycle for the active feature. It:

1. seeds eager runtimes synchronously;
2. loads a missing active runtime exactly once;
3. records loading, ready, and failed status per feature;
4. retains every successfully loaded `keepMounted` runtime;
5. exposes an explicit retry operation that creates a new load attempt after a
   failed promise;
6. returns the loaded runtimes to the existing App layout so their Providers
   can continue wrapping both middle and detail pane locations.

The host does not restructure the CSS grid and does not introduce portals.
This preserves the existing shared Notes context across its two panes.

### Notes result contract

`useNotesWorkspace` always constructs `stateSlice`, `draftsSlice`, and
`actionsSlice`, but its declared result makes them optional for hand-built test
fixtures. A precise hook-result subtype will mark these three properties as
required. `NotesWorkspaceProvider` can then use them directly and remove the
three runtime `?? workspace` branches. The looser fixture-facing base type stays
available to avoid unrelated test boilerplate.

### Notes workspace composition facade

`useNotesWorkspace` remains the public React hook but stops owning every
lifecycle directly. It composes the existing draft engine, coordinator, and
command layer with focused controllers. Extraction follows actual state and
transaction boundaries rather than technical categories alone:

- a workspace-session controller owns initialization, subscriptions, teardown,
  deletion gates, and authoritative projection settlement;
- a history controller owns history-entry lifetimes, replay, focus snapshots,
  and structural sequencing;
- a library-navigation controller owns scope, tag filters, search, zoom, and
  navigation versions;
- an attachment workflow controller owns upload-attempt admission, import,
  retry, byte loading, viewing, downloading, resizing, and removal;
- a selection controller owns anchor/head state and prepared move or batch
  authority.

Controllers receive explicit dependencies and return typed state plus actions.
They reuse `NotesDraftEngine`, `notesCommands`, and
`notesWorkspaceCoordinator`; they do not duplicate those implementations. React
hooks are used only where React lifecycle or state subscription is required.
Framework-free behavior remains in plain TypeScript controllers.

The facade keeps the current `UseNotesWorkspaceResult` API, action identity
contracts, context slices, and command settlement semantics. No extracted
production file may exceed 1,500 lines, so the work cannot satisfy the metric
by moving the same monolith unchanged.

### Semantic test observers

Controller tests will prefer real controller instances with lightweight fake
repositories and an append-only semantic event journal. Events are named for
behavior, such as draft persistence, structural command start, committed
history entry, projection settlement, and retry. Tests assert state and named
event sequences instead of reading `mock.calls[3]` or Vitest's global
`invocationCallOrder` values.

Where call order is itself the requirement, a test asserts one complete semantic
sequence. Tests that only need a produced history context capture it by name
from the fake repository instead of depending on its ordinal position. This
preserves sequencing coverage while making tests independent of unrelated
calls inserted before the observation.

### Historical plan reconciliation

All 23 checkbox-bearing files under `docs/superpowers/plans/` receive a compact
reconciliation header containing:

- status: `complete`, `partial`, `superseded`, or `planned`;
- reconciliation date and the audited main commit;
- reachable evidence commits;
- successor plan when superseded;
- unresolved items when partial.

Each of the 684 checkbox lines is reviewed. A box becomes checked only when its
specific deliverable is supported by a commit reachable from audited main and
the referenced file, test, or report still demonstrates the outcome. A box
stays unchecked when evidence is absent, the implementation differs materially,
or the item was deferred. Historical instructions are not rewritten to resemble
the current implementation. The final reconciliation records before/after
counts and any commit references that were not reachable.

## Runtime Data Flow

### Inbox startup

1. The app reads the persisted feature id.
2. The catalog supplies Inbox metadata and its eager runtime.
3. The shell, Sidebar, auth gate, and Inbox panes render.
4. No Notes module or `@dnd-kit` chunk is requested.

### First Notes activation

1. The active feature changes to Notes and remains persisted as today.
2. The host records `feature_runtime_load_start` and invokes the Notes loader.
3. The shell and navigation remain usable while pane slots show the Notes
   loading state.
4. On success, the host records `feature_runtime_load_done`, mounts the Notes
   Provider and panes, and retains that runtime.

### Later feature switches

The Notes runtime and Provider remain mounted when hidden. Returning to Notes
does not issue another import, parse the module again, or create another Notes
workspace session.

### Persisted Notes startup

If Notes was persisted as the initial feature, the host immediately loads the
Notes runtime. Notes remains available without GitHub authentication. This path
deliberately pays the Notes module cost because Notes is the requested first
screen; the Inbox performance gate is measured with Inbox persisted.

## Loading and Error Handling

Feature runtime state is a discriminated union with these states:

- `idle`: registered but not requested;
- `loading`: one promise is in flight;
- `ready`: runtime cached and usable;
- `failed`: the latest attempt failed and its error is retained for display.

An import rejection records `feature_runtime_load_error`, does not cache a
runtime, and does not silently redirect the active feature. The shell remains
mounted and the active pane area shows a concise error with Retry. Retry starts
a new promise; there is no automatic loop. A failed new feature load does not
unmount any previously loaded keep-mounted runtime.

An Error Boundary at the runtime rendering boundary handles render-time module
failures separately from import failures and from Notes' own storage errors.
Retrying an import does not erase Notes data or reset unrelated App state.

## No-op and Dead-code Policy

The refactor will enable `noUnusedLocals` and `noUnusedParameters` in the
TypeScript configuration and resolve all 17 current findings. Production
cleanup includes unused type imports, unused value imports, one unused callback
wrapper, one unused event-loop binding, and one unused repository-count helper.
Test-only unused declarations and parameters will be removed or deliberately
underscore-prefixed where the callback signature documents the ignored input.

Intentional no-ops stay explicit:

- the browser fallback returned from the native image-drop subscription is a
  valid unsubscribe contract;
- best-effort native teardown intentionally suppresses cleanup failures;
- resolved promises used as queue or optional-action identities preserve async
  method contracts.

These are not dead code and will not be replaced by a shared no-op abstraction.

Rust will be checked with focused no-effect lints. It will not be churned merely
to clear unrelated Clippy style warnings.

## Performance Contract

### Deterministic bundle gates

The post-change build must satisfy every row:

| Metric | Required result |
| --- | ---: |
| Initial JavaScript | at most 917,136 bytes |
| Initial JavaScript, gzip | at most 276,839 bytes |
| App chunk | less than 500,000 bytes |
| App chunk, gzip | at most 150,000 bytes |
| Notes sources in initial App source map | 0 files |
| `@dnd-kit` sources in initial App source map | 0 files |
| Notes chunk requests during Inbox startup | 0 requests |

The first two limits are exactly a 20% reduction from the recorded baseline.
A small Node-standard-library bundle budget check will read the Vite manifest,
chunk files, gzip sizes, and source maps after an analysis build. It will fail
with the measured actual and limit for any exceeded row.

### Release runtime gates

Runtime performance will use the existing `YONALIST_PERF` trace path plus the
new feature-runtime events. The measurement events will be added and committed
before the runtime-loading refactor, so the baseline and post-change builds use
identical instrumentation. Before and after builds will each be launched 20
times as fresh processes on the same machine with Inbox persisted. No settings,
network, or machine-power changes are allowed between samples.

The primary measure is `renderer_entry` to `app_mounted`:

- post-change p50 must be at most 85% of baseline p50;
- post-change p95 must not exceed baseline p95.

The current and new first-Notes activation times will also be measured from the
same user action to a visible Notes outline:

- first activation may not exceed the baseline p50 by more than 100 ms;
- subsequent Notes activation p50 may not regress by more than 5%;
- subsequent activation must issue zero runtime-load events.

`notifications_list_visible` remains informational because it includes cache,
authentication, and remote-data timing not controlled by this refactor.

Passing bundle gates alone is not enough to claim a runtime startup
improvement. If the 20-run runtime gates fail, the result will be reported as a
bundle reduction without a proven startup-time improvement.

### Notes extraction performance gates

The structural extraction must not trade a smaller source file for slower Notes
interactions. The existing frontend Notes performance harness remains at its
recorded `1.20x` regression ceiling. The release Rust performance harness is
unchanged because this workstream does not alter native storage behavior.

In addition:

- action and context-slice identity tests must retain their current render
  counts;
- the Inbox initial-byte gates above remain valid after the Notes extraction;
- the first and subsequent Notes activation runtime gates remain valid after
  all workstreams, not only immediately after code splitting.

## Test Strategy

Implementation follows red-green-refactor. Tests will first fail against the
current static registry, then drive the smallest runtime-host behavior.

Required focused tests:

- importing the catalog for Inbox does not evaluate the Notes module;
- Inbox startup invokes the Notes loader zero times;
- first Notes activation invokes the loader once and shows a loading state;
- a successful Notes load mounts its Provider and panes;
- switching away and back invokes the loader zero additional times;
- the Notes Provider and a probe of its local state do not remount or reset;
- a persisted Notes id starts the Notes load without requiring GitHub auth;
- a rejected import shows the load error and Retry starts exactly one new
  attempt;
- a successful retry replaces the failure state without resetting other loaded
  runtimes;
- the precise hook result makes all three Notes context slices required;
- the bundle budget check rejects a fixture above each byte/source limit.

Required Notes facade and test-structure checks:

- the facade returns the same state, draft, and action slice contracts before
  and after extraction;
- draft, history, library navigation, attachment, and selection controllers
  have focused behavior tests at their new boundaries;
- state-transition and semantic-event assertions replace mock ordinals without
  deleting ordering coverage;
- `useNotesWorkspace.test.tsx` is at most 5,500 lines;
- `useNotesWorkspace.test.tsx` contains zero `toHaveBeenNthCalledWith` and zero
  `invocationCallOrder` observations;
- indexed `mock.calls[...]` observations in that file fall from 125 to at most
  25 and are allowed only when the indexed occurrence is explicitly the
  behavior under test;
- the whole test suite does not exceed its current 283 ordinal/mock-order
  observation lines;
- `useNotesWorkspace.ts` and every newly extracted production module are at
  most 1,500 lines;
- the existing Notes `1.20x` frontend performance gate passes unchanged.

Required plan-reconciliation checks:

- all 23 checkbox-bearing plans contain the reconciliation header;
- all 684 checkbox lines were reviewed against a main-reachable commit and
  current artifact evidence;
- every checked box has evidence recorded in its document or reconciliation
  report;
- every partial or superseded plan names its remaining or successor work;
- a repository-wide report records final checked/unchecked counts and
  unreachable evidence references.

Full verification after focused tests:

```text
npm run lint
npm test
npm run build
npx tsc --noEmit --noUnusedLocals --noUnusedParameters --pretty false
cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -A warnings -W clippy::no_effect -W clippy::no_effect_underscore_binding -W clippy::let_underscore_drop -W clippy::drop_non_drop -W clippy::unit_arg -W unused_must_use -W unused_variables -W dead_code
```

The analysis build and bundle budget check run after the normal production
build. Release runtime measurements run only after correctness and deterministic
bundle gates pass.

## Expected File Boundaries

- `src/features/core/featureTypes.ts`: catalog and runtime contracts.
- `src/features/core/featureRegistry.tsx`: metadata and dynamic Notes loader;
  no static Notes import.
- `src/features/core/useFeatureRuntimeHost.ts`: lifecycle, cache, and retry.
- `src/features/notes/NotesFeature.tsx`: Notes runtime export and precise hook
  result consumption.
- `src/App.tsx`: host integration, loading/error panes, provider wrapping, and
  performance events.
- Focused core/App/Notes tests: lazy-load, persistence, retry, and remount
  contracts.
- `scripts/` and a focused test: deterministic bundle measurement using only
  Node standard-library APIs.
- `tsconfig.json` and the files currently reported by the unused-declaration
  check: enforcement and cleanup.
- `src/features/notes/useNotesWorkspace.ts`: composition facade, at most 1,500
  lines.
- Focused Notes controller modules and tests: session, history, library
  navigation, attachment workflow, and selection ownership. Each production
  module remains at or below 1,500 lines.
- `src/features/notes/useNotesWorkspace.test.tsx`: integration contracts only,
  at most 5,500 lines and within the mock-order budgets above.
- `docs/superpowers/plans/*.md`: checkbox and status reconciliation only; no
  historical requirement rewriting.
- `docs/superpowers/reports/`: one reconciliation report with audited commit,
  evidence method, counts, and unresolved references.

No production Rust file is expected to change unless implementation evidence
reveals a startup-facing Rust no-op or regression not present in the focused
baseline.

## Acceptance

The refactor is complete only when:

1. all focused lifecycle tests pass;
2. all existing frontend and Rust correctness tests pass;
3. TypeScript reports zero unused locals and parameters;
4. focused Rust no-effect Clippy reports zero findings;
5. every deterministic bundle gate passes;
6. the 20-run release measurement is recorded with baseline and post-change
   p50/p95 values;
7. Notes state survives feature switching after its first activation;
8. `useNotesWorkspace.ts` and all extracted production modules satisfy the
   1,500-line ceiling while their focused and integration tests pass;
9. the Notes integration test and repository-wide mock-order metrics satisfy
   the numeric budgets without weakened semantic assertions;
10. all 23 historical plans and 684 checkboxes have recorded evidence-based
   reconciliation results;
11. no unrelated user files or existing untracked `.agents/` and
   `skills-lock.json` content is committed.
