# Notes Internal Plugin Architecture Design

**Status:** Approved for planning

**Date:** 2026-07-10

## Purpose

Add a local-only Notes workspace to Yonalist. Notes provides a Workflowy-inspired
outliner without changing the behavior or data format of the existing GitHub
Inbox. Notes data is stored in SQLite and can be exported as frontmatter-based
Markdown or PDF.

"Workflowy-inspired" means matching the useful interaction model (a nested,
zoomable, keyboard-friendly outliner), not copying Workflowy's visual assets,
branding, or implementation.

## Goals

- Add a `Notes` item to the left application navigation.
- Keep GitHub Inbox, notifications, settings, vault Markdown documents, and
  outbox behavior working as they do today.
- Make Notes independently usable while signed out and while offline.
- Establish a compile-time internal feature registry so future first-party
  workspaces can be added without growing `App.tsx` into another feature
  switchboard.
- Store the authoritative Notes tree in `<vault>/.yonalist/notes.sqlite`.
- Support atomic local tree edits, recoverable deletion, full-text search, and
  frontmatter Markdown/PDF exports.
- Preserve the existing three-pane desktop ergonomics while giving the
  outliner the primary visual weight.

## Non-goals

- Loading executable third-party plugins, plugin marketplaces, manifests,
  signatures, sandboxes, or remote updates.
- Sync, collaboration, sharing, web publishing, or cloud backup.
- Replacing the existing Markdown vault or GitHub outbox storage.
- Importing Markdown as a first release requirement.
- Pixel-for-pixel imitation of Workflowy's UI.
- Rich document attachments, AI actions, calendar integrations, or mobile UI.

## Existing Constraints

- Yonalist is a Tauri 2, React 18, and TypeScript desktop application.
- The existing application keeps GitHub work items and queued drafts in a
  Markdown vault through `src/services/vaultStore.ts`.
- Rust already includes bundled `rusqlite`; the current
  `<vault>/.yonalist/index.sqlite` is a disposable cache/index database.
- `src/App.tsx` currently combines Inbox, Notifications, Settings, panes, and
  auth-gate state directly. This is the coupling that the feature host removes.
- The current reset flow must continue to clear caches without clearing user
  Notes data.

## Architecture Decision

Use a static, in-process feature registry. A feature is compiled into the
application and registered in one TypeScript list. It cannot be installed,
loaded, or updated outside an application release.

```text
AppShell
  |- Core providers: settings, vault root, theme, pane controls, toasts
  |- FeatureRegistry
  |    |- InboxFeature (adapter around existing Inbox behavior)
  |    |- NotesFeature (new, local-only workspace)
  |    `- SettingsFeature (existing settings surface)
  `- AppSidebar (core navigation plus registered feature entries)

NotesFeature
  |- React workspace UI and feature-local state
  |- notesStore TypeScript command adapter
  `- Tauri notes_* commands
       `- notes.sqlite

InboxFeature
  `- Existing GitHub hooks, vaultStore, Markdown documents, and outbox
```

### Feature contract

Create a small shared feature SDK in `src/features/core/`. Features may import
the SDK and shared presentation primitives, but they must not import another
feature's services, hooks, stores, or private components.

```ts
export type FeatureId = "inbox" | "notes" | "settings";

export interface FeatureNavigationEntry {
  id: FeatureId;
  label: string;
  icon: LucideIcon;
  section: "workspace" | "app";
  order: number;
}

export interface FeatureDefinition {
  id: FeatureId;
  navigation: FeatureNavigationEntry;
  requiresGithubAuth: boolean;
  Workspace: React.ComponentType;
}
```

The initial registry is a constant list of the three compiled features. It is
not a generic runtime plugin loader. `AppShell` owns the selected `FeatureId`,
persists the last selection, and renders exactly one feature's panes at a time.
During the first migration, the legacy Inbox controller remains mounted in the
shell so switching to Notes does not discard its current in-memory selection
or filters.

### Shell and authentication boundary

`AppShell` owns only cross-feature concerns:

- settings and vault-root resolution;
- theme, title bar, pane sizing, collapse, and global toast services;
- feature selection and registered sidebar entries; and
- stable provider wiring.

The GitHub auth gate moves behind `InboxFeature`. When Inbox is selected while
authentication is required, its existing sign-in controls remain the content
of the Inbox workspace. `NotesFeature` never waits on authentication,
network reachability, GitHub connection state, notification polling, or
outbox synchronization.

For existing users with no saved feature selection, the app defaults to Inbox
and preserves its current landing behavior. Once a user has selected Notes,
that selection may be restored at launch even if GitHub credentials are
missing or expired.

### Incremental migration rule

The initial feature-host change must wrap the current Inbox implementation
behind an `InboxFeature` adapter before changing any Inbox behavior. Its
existing hooks, document services, rendering decisions, and tests remain
authoritative. Refactoring the Inbox internals is explicitly out of scope for
the Notes delivery unless a narrow extraction is necessary to satisfy the
feature contract.

## Sidebar and Workspace UI

### Application sidebar

`AppSidebar` renders the existing Inbox, repository, notification, and
Settings entries unchanged. The feature registry contributes a new
`Workspace` section with a `Notes` entry using a standard Lucide icon. Active
state derives from `activeFeatureId`; it does not overload Inbox's existing
`ListFilter` or repository selection state.

Selecting Notes retains Inbox selections in memory. Returning to Inbox restores
the current notification, query, filters, and selected item unless the user
explicitly changes them.

### Notes layout

Notes uses the shell's middle and detail panes without nesting cards or adding
a second application sidebar.

- **Middle pane:** Notes library navigation: all root pages, starred pages,
  recent pages, tags, trash, and a new-page action.
- **Detail pane:** the current zoomed outline. It shows a compact breadcrumb,
  inline editable bullets, expand/collapse controls, a persistent add-child
  affordance, and an overflow menu for node actions and export.
- **Responsive pane behavior:** the existing resize, collapse, and detail
  maximize controls remain available. Detail maximize gives the outliner its
  focused writing mode.
- **Node notes:** a node's supporting note opens inline below the bullet or in
  the detail area's lightweight editor; it is not a separate document type.

The visual system reuses Yonalist's typography, spacing, controls, focus
states, light/dark theme tokens, and accessible tooltips. The interaction
model is Workflowy-like, but the appearance remains Yonalist-native.

## Notes Domain and Persistence

### Database location and ownership

The database lives at:

```text
<vault>/.yonalist/notes.sqlite
```

It is a user-data database, not a cache. The existing
`<vault>/.yonalist/index.sqlite` remains exclusively responsible for
Markdown-vault indexing and caches. `clear_vault_cache` must never open,
modify, vacuum, or remove `notes.sqlite`.

All SQLite access happens in Rust. React uses a typed TypeScript adapter that
invokes `notes_*` Tauri commands; it never opens or interprets the database
directly.

### Database initialization and migration

Create a separate `connect_notes_db` and `initialize_notes_db` path in Rust.
Initialization enables `WAL`, foreign keys, and a bounded busy timeout.
Schema migrations execute transactionally and are versioned with
`PRAGMA user_version`. A failed migration leaves the preceding schema intact
and returns a clear, user-facing error without attempting a destructive reset.

### Initial schema

```sql
CREATE TABLE notes_nodes (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES notes_nodes(id),
  sort_key INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  layout_mode TEXT NOT NULL DEFAULT 'bullets',
  is_collapsed INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX notes_nodes_active_parent_order
  ON notes_nodes(parent_id, deleted_at, sort_key);

CREATE TABLE notes_tags (
  node_id TEXT NOT NULL REFERENCES notes_nodes(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  normalized_tag TEXT NOT NULL,
  PRIMARY KEY (node_id, normalized_tag)
);

CREATE INDEX notes_tags_normalized_tag ON notes_tags(normalized_tag);

CREATE TABLE notes_preferences (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE VIRTUAL TABLE notes_search USING fts5(
  node_id UNINDEXED,
  title,
  note,
  tokenize = 'unicode61'
);
```

`sort_key` begins in sparse increments of 1024. Insert and move operations
calculate a key between adjacent siblings. If no integer gap remains, the
operation atomically rebalances only that sibling set. This makes ordering
deterministic without floating-point ranks or a broad initial dependency.

The initial migration also installs triggers so active `title` and `note`
content stays mirrored in `notes_search`. Nodes with `deleted_at` set are
removed from the FTS index and restored when they return from trash.
`notes_update_node` extracts `#tag` tokens from title and supporting-note text,
normalizes them case-insensitively, and updates `notes_tags` in the same
transaction as the edited node.

### Tree invariants

- A live node has either a live parent or no parent, in which case it is a root
  page.
- A node cannot be moved under itself or any descendant.
- One atomic mutation changes a node and all affected sibling order values.
- Deletion is soft deletion. Deleting a node soft-deletes its live descendants
  in the same transaction and preserves parent and sort information so a
  restore can return the subtree to its original position when that parent is
  still live; otherwise it restores the subtree at the root.
- Permanent deletion is limited to a deliberate empty-trash command.
- Duplication creates a deep copy of the selected subtree with fresh IDs and
  inserts the copy immediately after the source node.
- Every user-visible mutation updates `updated_at` in UTC ISO-8601 format.
- IDs are opaque UUID strings generated in Rust or the browser once per new
  node and validated by the command boundary.

### Command boundary

Expose narrowly scoped, typed commands rather than a generic SQL command:

```text
notes_initialize(vaultPath)
notes_load_workspace(vaultPath, scope)
notes_create_node(vaultPath, input)
notes_update_node(vaultPath, input)
notes_move_node(vaultPath, input)
notes_toggle_complete(vaultPath, nodeId)
notes_toggle_collapsed(vaultPath, nodeId)
notes_toggle_star(vaultPath, nodeId)
notes_duplicate_node(vaultPath, nodeId)
notes_soft_delete_node(vaultPath, nodeId)
notes_restore_node(vaultPath, nodeId)
notes_empty_trash(vaultPath)
notes_search(vaultPath, query)
notes_export_markdown(vaultPath, scope, destination)
notes_export_pdf(vaultPath, scope, destination)
notes_delete_database(vaultPath)
```

The TypeScript adapter translates command payloads into domain types and is
the only Notes UI dependency permitted to invoke those commands.

## Workflowy-Inspired Functional Scope

### Core release

The first usable Notes release provides the following behavior:

- infinitely nested bullets and multiple root pages;
- inline title editing plus supporting notes per bullet;
- create sibling, child, and root nodes;
- keyboard-first movement: Enter creates a sibling, Tab indents, Shift+Tab
  outdents, and Backspace on an empty node merges or removes it when valid;
- mouse drag-and-drop ordering with the same tree invariants as keyboard
  movement;
- selected-node navigation with Arrow keys, expand/collapse, duplicate,
  complete, soft delete, restore, and permanent trash emptying;
- zoom into a node and zoom out through a breadcrumb; zoom is UI state and
  never changes tree ownership;
- starred pages, recently edited pages, tags, and full-text search;
- light/dark theme and accessible keyboard focus behavior; and
- Markdown and PDF export for a selected node subtree or the current zoomed
  page.

### Follow-on parity releases

These are deliberately separate feature deliveries because they alter the
tree model or rendering contract more substantially:

1. **Mirrors and backlinks:** live references to a source node, reference
   cycle prevention, and backlink navigation. This adds a `notes_links` table
   in a later migration; it does not duplicate subtree data.
2. **Alternative layouts:** board mode for a root's direct children and a
   table-oriented view. These reuse the same node model and add layout
   preferences rather than a second database.
3. **Date-oriented views:** parsed date tags and a local timeline/today view.
   Date parsing remains local and opt-in.

No follow-on release may alter the meaning of exported core bullets or require
a migration that rewrites existing node IDs.

## State, Writes, and Errors

`useNotesWorkspace` owns Notes feature state. It loads a normalized tree
projection and maintains selection, zoom, search query, and local editing
state. Writes are serialized per vault in a small command queue so rapid
keyboard input cannot reorder acknowledgements.

Title edits display immediately and persist with a short debounce. Structural
operations persist immediately. A failed command restores the last confirmed
projection, keeps the user's unsaved title in the editor when possible, and
shows a retryable error toast. A failed export never modifies the source tree.

Database-open, migration, validation, disk, and write errors must include a
safe operation-specific message. Raw SQL and vault paths are not shown in the
normal interface. Errors in Notes never disable Inbox and errors in Inbox
never prevent opening Notes.

## Export Design

### Markdown

Exports are generated from a snapshot of the selected subtree inside one read
transaction. A page export uses its root title as the Markdown H1. A selected
non-root node export uses an H1 based on that node title. The output starts
with interoperable YAML frontmatter:

```markdown
---
kind: yonalist-notes-export
format_version: 1
source: notes.sqlite
root_node_id: "8c4d..."
exported_at: "2026-07-10T12:00:00Z"
---

# Project plan

- [ ] First task <!-- yonalist-node-id: 3a1b... -->
  - Supporting note
```

Completed nodes use `- [x]`. Supporting notes are indented below their node.
Stable node IDs are preserved in HTML comments so a future importer can
recognize identity without polluting the visible document. The Markdown file
is an export artifact, never the source of truth.

### PDF

Markdown and PDF share one export-tree snapshot and one semantic renderer.
The PDF layout supports the initial outline surface: title, breadcrumbs,
headings, bullets, checkboxes, supporting notes, and page numbers. It does
not rasterize the application UI or depend on a user-selected print dialog.
The Rust implementation uses `printpdf` 0.9.x with explicit semantic block
layout rather than its experimental HTML-to-PDF path. The application bundles
an OFL-licensed Noto Sans KR regular font for reliable Korean and Unicode text
output; the renderer embeds and subsets that font in every exported document.
It runs without network access or an external executable.

The official Tauri dialog plugin provides the native save dialog. Destination
files are written atomically: write a sibling temporary file, flush it, then
rename it into place. An existing destination requires explicit overwrite
confirmation.

## Reset and Data Lifecycle

- Existing "Reset settings and caches" continues to preserve the Markdown
  vault and outbox and now also explicitly preserves `notes.sqlite`.
- Notes exposes a separate destructive "Delete all Notes data" action in its
  own settings surface. It requires a confirmation dialog and closes the
  Notes workspace only after the database removal succeeds.
- Switching vault folders selects that vault's independent `notes.sqlite`.
  No cross-vault merge or automatic copy occurs.
- Manual exports are the first-release portability path. Database backup and
  Markdown import can be planned independently later.

## Delivery Sequence

The work is split into independently reviewable subprojects. Each has a
working deliverable and can be released without waiting for later phases.

1. **Feature host foundation:** extract the shell/registry contract, add a
   static `Notes` navigation entry, wrap the existing Inbox as an adapter, and
   prove Inbox regression parity.
2. **SQLite Notes foundation:** add the separate native database, migrations,
   typed command adapter, domain types, and tests for tree transactions.
3. **Outliner MVP:** build the Notes library, outline rendering, selection,
   editing, nesting, ordering, collapse, zoom, completion, trash, and
   keyboard behavior.
4. **Discovery:** add FTS search, tags, starred/recent views, and resilient
   write/error handling.
5. **Exports:** add semantic export snapshots, Markdown files, PDF files, and
   native save/overwrite behavior.
6. **Advanced parity:** mirrors/backlinks, board/table modes, and date views,
   each as a separately approved specification and implementation plan.

## Verification and Acceptance Criteria

### Existing application preservation

- All existing TypeScript tests and Rust tests pass unchanged after the
  feature-host foundation.
- Existing Sidebar tests prove the original Inbox filters, notifications,
  repository selection, and Settings activation still work.
- Existing vaultStore and outbox tests prove neither code path invokes a
  Notes command or opens `notes.sqlite`.
- An unauthenticated Inbox selection still presents the existing sign-in
  workflow; Notes remains selectable and usable locally.
- Reset clears the existing index/cache data but leaves a Notes database and
  its content intact.

### Notes correctness

- Creating, moving, indenting, outdenting, duplicating, deleting, restoring,
  and emptying trash preserve all listed tree invariants under transactions.
- A search result opens the correct node in context and a zoomed view never
  hides a live descendant accidentally.
- Relaunching with the same vault restores all Notes content and ordering.
- Markdown export is deterministic for a fixed tree and has valid YAML
  frontmatter.
- PDF export represents the same visible node order and completion state as
  Markdown export.
- Notes works with the application network state set to offline and without a
  GitHub token.

### Test layers

- Rust unit tests: migrations, SQL transactions, ordering rebalance,
  cycle prevention, soft deletion, FTS synchronization, and export snapshots.
- TypeScript service tests: Tauri command payload mapping, native/fallback
  error handling, and serialized writes.
- React tests: registry/sidebar selection, authentication separation, outline
  keyboard commands, focus management, zoom, and error recovery.
- Integration tests: feature switching preserves Inbox state, a Notes data
  round trip across remount, reset isolation, and end-to-end export fixtures.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Refactoring the app shell changes Inbox behavior | Wrap Inbox first, retain existing tests, and ship the feature host as its own reviewed subproject. |
| Tree moves corrupt order or create cycles | Route every structural move through one Rust transaction with invariant tests. |
| Large outline edits feel slow | Use normalized tree state, virtualize long sibling lists after measurement, and serialize writes. |
| PDF differs from the outline | Generate Markdown and PDF from one immutable export-tree snapshot. |
| Cache reset deletes user notes | Keep a separate database filename and test reset at the native boundary. |
| Plugin abstraction becomes a generic framework | Keep the registry static, small, and compile-time only. |

## Deferred Decisions

- Markdown import, attachment storage, and database backup will receive their
  own specifications after core export behavior is stable.
- Mirrors, boards, tables, and date views require separate design approval
  before their schema migrations are added.
