# Full Runtime And Dependency Upgrade Design

**Status:** Approved for planning

**Date:** 2026-07-14

## Purpose

Bring Yonalist's Rust toolchain and both direct and transitive Rust and npm
dependencies to their current stable releases, while preserving application
behavior and keeping the update reviewable.

## Scope

- Pin the repository Rust toolchain, Cargo minimum supported version, and CI
  toolchain to Rust 1.97.
- Update all direct Cargo dependencies and regenerate `src-tauri/Cargo.lock`.
- Update all direct npm dependencies, including runtime, Tauri, build, test,
  lint, and type packages, and regenerate `package-lock.json`.
- Accept source changes strictly required by upstream API, type, or build
  compatibility.
- Verify the desktop application starts through `npm run tauri:dev`.

## Non-goals

- Adding product features, changing Notes schema or stored user data, or
  redesigning user interfaces.
- Reformatting or refactoring unrelated code.
- Including the pre-existing changes to `src-tauri/Cargo.toml`,
  `src-tauri/Cargo.lock`, or `src-tauri/src/notes/repository.rs` in this work.

## Isolation

The upgrade runs in a new linked worktree created from the committed baseline.
This avoids mixing the dependency lockfile rewrite with the active checkout's
uncommitted Notes work. The final commit contains only upgrade-related files.

## Upgrade Sequence

1. Set `rust-toolchain.toml`, `rust-version`, and CI to Rust 1.97.
2. Update the Tauri Rust crates and the matching `@tauri-apps/*` npm packages
   as one compatibility unit.
3. Update the remaining Cargo dependencies and lockfile. Resolve compiler
   errors at the call sites without broad API redesigns.
4. Update npm runtime packages, then build/test/lint packages. Resolve React,
   TypeScript, Vite, Vitest, ESLint, and type-definition compatibility errors.
5. Re-run the complete verification matrix and start the Tauri development app.

## Compatibility Rules

- Keep Tauri packages aligned to one compatible 2.x release family across
  `Cargo.toml`, `package.json`, and the lockfiles.
- Keep React and React DOM on the same major/minor release.
- Preserve existing dependency feature selections unless an upstream release
  removes or replaces them; record any required replacement in the commit.
- Treat a failing test as a compatibility regression to understand and fix,
  rather than weakening or deleting the test.

## Verification

- `npm ci`, `npm run lint`, `npm test`, and `npm run build`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `npm run tauri:dev`, observing the desktop binary start without a Rust or
  frontend build error
- `git diff --check` and a staged-diff review before commit
