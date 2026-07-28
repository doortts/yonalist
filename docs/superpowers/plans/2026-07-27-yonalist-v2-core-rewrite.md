# Yonalist v2 core rewrite implementation plan

## Checkpoint 1: Freeze the oracle

- Record the clean worktree and known Windows/frontend/architecture/plan failures.
- Repair deterministic oracle failures with one regression test per root cause.
- Capture current behavior contracts and macOS golden states.
- Move development-only performance probes out of the production entry graph.

## Checkpoint 2: Establish enforceable boundaries

- Add the Cargo/npm workspace for `apps/desktop`, `notes-core`,
  `notes-application`, `notes-sqlite`, and generated contracts.
- Add dependency-direction, cycle, file-size, direct-dependency, and bundle
  checks.
- Generate TypeScript IPC DTOs from Rust and fail CI on a stale generated diff.

## Checkpoint 3: Prove the first vertical slice

- RED/GREEN `notes-core` invariants and create/update command inversion.
- RED/GREEN SQLite schema, atomic command, revision, and bounded bootstrap query.
- RED/GREEN application service, session history, restart persistence, and
  structured errors.
- RED/GREEN Tauri serialization and the React external-store patch path.
- Verify the slice in a fresh Tauri process with an isolated database.

## Checkpoint 4: Expand Notes v1

- Port the existing shell and Notes DOM/CSS without visual changes.
- Add outline keyboard/IME, selection, move/indent/outdent/duplicate,
  completion/star, zoom/breadcrumb, and split panes one acceptance row at a
  time.
- Add search, tags, dates, trash/restore, close draining, and failure recovery.
- Keep images, attachments, export, sync, external sources, and compatibility
  code absent from the production graph.

## Checkpoint 5: Performance and cutover

- Implement viewport-first bootstrap, cursor paging, on-demand feature chunks,
  and idle SQLite maintenance.
- Run fixed 1/5,000/50,000-node suites, 50 cold launches, and 200 interaction
  samples on Windows and Apple Silicon macOS.
- Pass frontend/Rust/architecture/contract/bundle/visual gates.
- Tag the legacy app, switch the default build, and delete the legacy surface
  only after all acceptance rows pass.
