# Notes Workflowy Development Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a local-only, Workflowy-inspired Notes workspace in Yonalist without changing the behavior, storage format, or reliability of the existing GitHub Inbox.

**Architecture:** Yonalist gains a static, compile-time feature registry with three first-party features: Inbox, Notes, and Settings. Notes owns its React workspace, SQLite database, command adapter, and export pipeline; Inbox continues to own GitHub hooks, Markdown vault documents, and outbox behavior.

**Tech Stack:** React 18, TypeScript, Tauri 2, bundled rusqlite/SQLite FTS5, Base UI, Lucide, @dnd-kit/core, @dnd-kit/sortable, Tauri Dialog plugin, and printpdf.

## Global Constraints

- Notes is a compiled first-party feature, never a third-party runtime plugin system.
- Existing GitHub Inbox, notifications, settings, Markdown vault documents, and outbox behavior must remain behaviorally unchanged.
- Notes works with no GitHub token and with network state set to offline.
- `<vault>/.yonalist/notes.sqlite` is Notes user data; `<vault>/.yonalist/index.sqlite` remains cache/index data only.
- SQLite access is available only through typed `notes_*` Tauri commands; React never opens the database directly.
- "Reset settings and caches" must preserve `notes.sqlite`; deleting Notes data is a separate confirmed action.
- Markdown and PDF are export formats, never Notes source-of-truth formats.
- Every structural tree mutation is one SQLite transaction and must reject self/descendant moves.
- Every step follows test-driven development and leaves the TypeScript build and Rust test suite green.
- Do not add synchronization, collaboration, cloud storage, dynamic plugin loading, or Markdown import in this program.

---

## Program Shape

```text
Phase 1: Feature host and Inbox-preservation adapter
    |
Phase 2: SQLite Notes domain and native command boundary
    |
Phase 3: Workflowy-style outline editing MVP
    |
Phase 4: Discovery, resilience, and data lifecycle
    |
Phase 5: Frontmatter Markdown and PDF export
    |
Release: Local-only Notes V1
    |
Separate approval: mirrors/backlinks, boards/tables, timeline/date views
```

## Delivery Map

| Phase | Deliverable | User-visible result | Primary verification | Detailed plan |
| --- | --- | --- | --- | --- |
| 1 | Internal feature host | Notes appears as a left navigation feature; Inbox state and login behavior remain intact | Sidebar and App regression tests | [Feature host](2026-07-10-notes-feature-host-foundation.md) |
| 2 | Notes persistence core | A separate Notes SQLite database can safely create, change, move, duplicate, and recover nodes | Rust transaction and Tauri-adapter tests | [SQLite core](2026-07-10-notes-sqlite-core.md) |
| 3 | Outline MVP | Users can create and edit a zoomable, nested bullet tree with keyboard and drag interactions | React interaction tests and native data round-trip | [Outliner MVP](2026-07-10-notes-outliner-mvp.md) |
| 4 | Discovery and resilience | Search, tags, star/recent/trash views, write recovery, and explicit data deletion work locally | FTS, error recovery, reset-isolation tests | [Discovery](2026-07-10-notes-discovery-and-resilience.md) |
| 5 | Exports | A node subtree or page saves as frontmatter Markdown or Korean-capable PDF | Snapshot, atomic-write, and UI export tests | [Exports](2026-07-10-notes-export.md) |

## Ownership Boundaries

| Area | Owner | Must not depend on |
| --- | --- | --- |
| `src/features/core/` | Static feature registry, active-feature persistence, shell contracts | GitHub hooks, Notes SQL, feature-private UI |
| `src/features/inbox/` | Legacy Inbox adapter only | Notes hooks, Notes store, Notes components |
| `src/features/notes/` | Notes panes, reducers, keyboard and drag behavior | GitHub API, vaultStore, outbox |
| `src/domain/notes.ts` | Shared TypeScript Notes types and pure tree helpers | React, Tauri, browser APIs |
| `src/services/notesStore.ts` | Typed renderer-to-Tauri command adapter | React components, GitHub services |
| `src-tauri/src/notes/` | Schema, migrations, transactional repository, commands, export renderer | Frontend DOM and GitHub code |
| `src/services/vaultStore.ts` | Existing GitHub Markdown-vault persistence | Notes database and Notes commands |

## V1 Functional Contract

V1 is complete only when it provides all of the following:

- Root pages and infinitely nested bullets.
- Inline title editing and a supporting note per node.
- New sibling, child, and root nodes.
- Enter, Tab, Shift+Tab, Backspace, Arrow, collapse/expand, duplicate,
  complete, trash, restore, and zoom behavior with defined tree invariants.
- Pointer and keyboard-accessible drag ordering.
- Starred, recent, tagged, searched, and trashed node views.
- Separate Notes data deletion with confirmation.
- Export of a selected subtree or current zoomed page to frontmatter Markdown
  and PDF.
- Storage and operation without GitHub authentication or network access.

## Cross-Phase Contracts

### Feature selection

`FeatureId` is always one of `"inbox"`, `"notes"`, or `"settings"`. The
selection lives in `yonalist.activeFeature.v1`; a missing or invalid value
falls back to `"inbox"`. Existing users therefore keep the current Inbox
landing behavior, while a user who selected Notes can return there before
GitHub authentication completes.

### Tree model

`NoteNode` uses opaque UUID text IDs, nullable `parentId`, integer `sortKey`,
title, supporting note, collapse/star/complete flags, and UTC timestamps.
All UI projections derive from a normalized `Record<NoteId, NoteNode>` plus
ordered child ID arrays. No UI component mutates nested tree objects in place.

### Persistence

`notes.sqlite` uses WAL, foreign keys, `PRAGMA user_version` migrations through
schema version 2, and FTS5. Version 2 keeps `deleted_at` as the UTC deletion
timestamp and adds repository-only `deleted_batch_id` provenance so restore is
scoped to one deletion operation rather than timestamp equality. Version 1
deleted rows migrate non-destructively to deterministic
`legacy:<stored deleted_at>` groups; equal pre-v2 timestamps remain ambiguous
because version 1 did not store operation identity. Structural changes call
one typed native command each. The renderer serializes mutations per vault so
responses cannot arrive out of order.

### Export

Both exporters call one Rust `load_export_snapshot` helper. Markdown and PDF
must therefore have the same root node, visible order, completion state, and
supporting-note content.

## Release Gates

### Gate A: After Phase 1

- `npm test -- src/App.test.tsx src/components/Sidebar.test.tsx` passes.
- Existing Inbox regression tests remain unmodified unless their assertions
  explicitly cover the new Notes route.
- The Notes item is reachable from the left navigation and from the sign-in
  screen, without triggering GitHub requests.

### Gate B: After Phase 2

- `cargo test --manifest-path src-tauri/Cargo.toml notes` passes.
- A temporary vault contains both independent files after initialization:
  `.yonalist/index.sqlite` and `.yonalist/notes.sqlite`.
- New Notes databases finish at schema version 2 through the version 0-to-1
  and version 1-to-2 sequence; existing version 1 data migrates transactionally
  and a failed migration leaves version 1 intact.
- Same-timestamp child and ancestor deletions retain distinct batch provenance,
  and restoring the ancestor does not revive the independently trashed child.
- Concurrent initializers are released from a held migration lock only after a
  test observer proves both workers reached SQLite's busy path; both calls then
  succeed against one valid version 2 schema.
- Clearing cache/index data leaves a persisted Notes node untouched.

### Gate C: After Phase 3

- `npm test -- src/features/notes` passes.
- A keyboard-only user can create, nest, outdent, move, complete, zoom, and
  delete/restore a node.
- Reopening the workspace renders the tree in its persisted order.

### Gate D: After Phase 4

- Tag, star, recent, trash, and FTS result counts agree with the database.
- A failed write restores the last confirmed projection and presents a retry
  action without changing the Inbox.
- The global reset command leaves Notes data in place.

### Gate E: After Phase 5

- Markdown output has valid YAML frontmatter and deterministic node ordering.
- PDF output is nonempty, begins with a PDF header, includes embedded Korean
  font data, and is written atomically.
- A canceled save dialog leaves no file and no user-data changes.

## Commit Boundaries

Each numbered task in a detailed plan ends in one focused commit. Use these
prefixes so review history mirrors the architecture:

```text
refactor: introduce feature registry
feat(notes): add sqlite tree repository
feat(notes): add outline editor
feat(notes): add discovery views
feat(notes): add markdown and pdf export
test(notes): cover tree invariant
```

Do not combine a phase boundary with unrelated Inbox cleanup, CSS redesign, or
GitHub API changes.

## Advanced Workflowy Parity

The following capabilities are intentionally not part of V1 because each
changes the model or rendering contract. Their implementation starts only
after a dedicated product/design approval and an independent migration plan.

| Capability | Planned model extension | Required approval condition |
| --- | --- | --- |
| Mirrors and backlinks | `notes_links` with source/target identity and cycle checks | Reference behavior and copy/export rules agreed |
| Board and table modes | Per-root layout preferences with the same node tree | Keyboard behavior and accessibility model agreed |
| Date/timeline views | Parsed local date index derived from tags/text | Natural-language parsing rules and locale behavior agreed |

The V1 model and exported node IDs must remain compatible with every advanced
release.

## Planning Index

1. [Feature host foundation](2026-07-10-notes-feature-host-foundation.md)
2. [SQLite Notes core](2026-07-10-notes-sqlite-core.md)
3. [Outliner MVP](2026-07-10-notes-outliner-mvp.md)
4. [Discovery and resilience](2026-07-10-notes-discovery-and-resilience.md)
5. [Markdown and PDF export](2026-07-10-notes-export.md)
