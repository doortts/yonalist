# Yonalist v2 core rewrite design

## Delivery contract

| Field | Decision |
| --- | --- |
| Goal | Ship a fresh Windows/macOS Yonalist desktop application whose first release is a complete text-outliner Notes experience backed by a new Rust/SQLite core. |
| Acceptance | Current macOS layout and interaction geometry remain unchanged; page creation, outline editing, zoom, split view, search, tags, dates, trash, session Undo/Redo, autosave, restart persistence, and safe close work through the new stack; the fixed functional, architecture, bundle, visual, and performance gates pass. |
| Non-goals | Existing Vault/database/settings compatibility, images, attachments, export, Markdown sync, external sources, CRDT/event sourcing, new visual design, and long-term side-by-side legacy support. |
| Boundaries | React presentation and external stores; generated TypeScript IPC contracts; thin Tauri commands; pure Rust domain/application crates; a dedicated SQLite worker; Windows functional proof and macOS functional plus golden-image proof. |
| Manual proof | Start a freshly built v2 app with an isolated 5,000-node database, edit Korean and Latin text, create and restructure bullets, zoom and split panes, search and trash/restore a page, Undo/Redo, restart, then confirm content and geometry. |

## Frozen decisions

- The legacy behavior oracle is `main@502af65`.
- The implementation branch is `codex/yonalist-v2-core`.
- The final stack remains React, TypeScript, Tauri, Rust, rusqlite, and SQLite.
- The new database begins at schema 1 and has no compatibility readers or migrations.
- macOS is the visual reference; Windows and macOS have equal functional support.
- The renderer budget is p95 20 ms from WebView readiness to an editable current note.
- The separate cold-launch budget is p50 300 ms and p95 500 ms.
- Production file, test file, and direct-dependency budgets are warnings; reverse-layer imports and dependency cycles are errors.

## Architecture

The final repository owns one modular monolith:

- `apps/desktop`: React presentation, external stores, generated IPC client, and the thin Tauri desktop adapter.
- `crates/notes-core`: dependency-free Notes entities, commands, invariants, and inverse operations.
- `crates/notes-application`: command/query services, session history, revisions, and storage ports.
- `crates/notes-sqlite`: schema, transactions, viewport queries, FTS5, and the dedicated database worker.
- `packages/contracts`: TypeScript IPC types generated from Rust DTOs with `ts-rs`.

Dependencies point inward. Database rows and domain entities never cross IPC.
Commands return revision patches rather than a reloaded workspace. The frontend
renders confirmed state plus a temporary pending overlay and keeps focus,
selection, scroll, and zoom state inside pane sessions.

## First vertical slice

The first production slice proves the entire boundary with one page:

1. Create a fresh SQLite store.
2. Bootstrap the first page and bounded viewport.
3. Create and edit a child bullet through a typed command.
4. Return a `MutationReceipt` containing only changed/removed nodes and history state.
5. Restart the application service and reload the saved content.
6. Undo and redo the mutation inside the current session.

Every production step begins with a focused failing test and stops at the
smallest implementation that makes that test pass.

## Rollout

The existing app remains the oracle until v2 passes all acceptance gates. At
cutover, create annotated tag `yonalist-v1-legacy-2026-07-27`, make v2 the only
build target, delete legacy production/test/documentation assets from `main`,
and retain only active v2 ADRs, specifications, fixtures, and reports.
