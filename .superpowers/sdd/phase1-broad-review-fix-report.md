# Phase 1 Broad Review Fix Report

## Status

Completed. All three Important feature-host review findings are covered by
App-level regressions and fixed within the owned host files. The static
first-party registry and feature descriptors were not changed.

## Review Findings Addressed

### 1. Offline Notes access during startup auth restoration

`AuthRestorePage` now exposes an accessible `Notes` button. Its callback only
selects the Notes feature; it does not call `authGate.skipLogin`, alter the auth
gate, or stop the existing session-restoration hooks. Selecting an auth-gated
feature afterward still returns to the normal login/auth boundary.

The regression renders the initial restoration screen, activates Notes
immediately, confirms the Notes library is visible, and verifies that
`yonalist.auth.skipLogin.v1` was neither populated nor passed to
`localStorage.setItem`.

### 2. App-owned notification selection survives feature changes

The effect that cleared `selectedNotification` whenever the active feature was
not Inbox was removed. The selection remains App-owned across Notes and
Settings navigation.

The existing `activeSelectedNotification` guard remains the only value passed
to notification detail and prefetch consumers. It becomes `null` whenever
Inbox Notifications is hidden, preserving the existing isolation behavior.
The regression selects a real sample notification, visits Notes, returns to
Notifications, and confirms both the selected row and conversation detail are
restored.

### 3. Active feature Provider hosts both resolved panes

`App` now resolves `activeFeature.Provider` and mounts it around the active
middle pane, the shared middle/detail resizer, and the active detail pane. This
gives both feature panes the same future feature-local context while leaving
the Sidebar and app-wide chrome outside the changing provider boundary.

The App integration test temporarily replaces the real mutable Notes
descriptor's Provider with a sentinel, renders the real Notes panes, confirms
both panes are descendants of that provider, and restores the original
Provider in `finally`.

An initial implementation wrapped the whole shell. The existing project
visibility test exposed that changing Provider component types remounted the
Sidebar. The boundary was narrowed to the feature pane region, after which
both the new provider regression and the existing Sidebar regression passed.

## TDD Evidence

### RED

Command:

```sh
npm test -- src/App.test.tsx
```

Result before production changes: 1 test file failed; 3 tests failed and 86
passed. Each new regression failed for its intended missing behavior:

- no accessible Notes button on `AuthRestorePage`;
- notification detail was empty after returning from Notes;
- the Notes Provider sentinel was absent.

### Focused GREEN

Command:

```sh
npm test -- src/App.test.tsx
```

Result after implementation: 1 test file passed; 89 tests passed.

Relevant integration command:

```sh
npm test -- src/App.test.tsx src/components/Sidebar.test.tsx src/components/LoginPage.test.tsx src/features/core/featureRegistry.test.tsx
```

Result: 4 test files passed; 98 tests passed.

## Full Verification

- `npm test`: 85 test files passed; 726 tests passed.
- `npm run build`: TypeScript and Vite production build passed; 2,256 modules
  transformed.
- `cargo test --manifest-path src-tauri/Cargo.toml`: 28 Rust unit tests passed;
  main and doc-test targets passed with no failures.
- `git diff --check`: passed with no whitespace errors.

## Changed Files

- `src/App.tsx`
- `src/App.test.tsx`
- `.superpowers/sdd/phase1-broad-review-fix-report.md`

## Constraint Check

- Notifications remains the post-auth Inbox landing view.
- Inbox and Settings remain auth-gated.
- Login-screen and restoration-screen Notes access does not persist skip-login.
- Notes keeps neutral metrics and inactive notification detail/prefetch inputs.
- Selected notification state is retained only in App and is not consumed while
  the notification subview is hidden.
- No SQLite, Notes persistence, drag-and-drop, dynamic plugins, CSS, or native
  behavior was added.

## Concerns

None outstanding for these findings. Feature Provider changes intentionally
remount the feature pane subtree when switching descriptors; App-wide shell and
Sidebar state remain mounted outside that boundary.
