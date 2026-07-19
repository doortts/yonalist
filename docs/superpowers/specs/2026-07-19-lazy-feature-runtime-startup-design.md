# Lazy Feature Runtime Startup Design

## Summary

Yonalist will split synchronous feature metadata from feature runtime code. The
Inbox shell will start without importing or evaluating Notes. A small runtime
host will load Notes only when Notes becomes active, keep the loaded Notes
provider and panes mounted across later feature switches, and expose explicit
loading, failure, and retry states.

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
8. no unrelated user files or existing untracked `.agents/` and
   `skills-lock.json` content is committed.
