# Yonalist v2 Feature Parity Design

## Goal

Reimplement the user-visible behavior of `main@502af65` on the v2 modular
architecture without importing the legacy runtime. Vault file synchronization
and GitHub Notifications are explicitly excluded. The current visual design is
unchanged.

## Sources of truth

Behavior is resolved in this order:

1. Characterization tests that pass at `main@502af65`.
2. User-visible behavior of the current packaged application.
3. Current production components and typed Tauri commands.
4. Approved feature specifications and completed verification reports.

Superseded plans, implementation details that have no observable effect, Vault
compatibility branches, and GitHub Notifications behavior are not parity
requirements.

## Included behavior

### Application shell and settings

- Existing navigation, pane resizing, collapse/maximize controls, status
  feedback, theme selection, and local Notes data controls.
- Settings needed by included Notes features, including appearance, attachment
  handling, export preferences, and explicit Notes-data deletion.
- The current DOM geometry, CSS tokens, colors, typography, focus treatment,
  and responsive layout remain unchanged.

### Library and lifecycle

- Create, open, inline rename, duplicate, star, archive, unarchive, trash, and
  restore pages.
- All, Starred, Recent, Tags, Archive, and Trash views.
- Search over title, supporting note, attachment metadata, tags, and dates.
- Search-result navigation to the matching node and restoration of the
  surrounding outline.
- Explicit Notes-data deletion and repair/error feedback appropriate to the new
  database.

### Text outline editor

- Pages and unbounded nested bullet trees.
- Title and supporting-note editing with stable resting/focused geometry.
- Korean IME safety.
- Workflowy Enter splitting, contextual first-child creation, repeated Enter,
  Tab/Shift+Tab, Backspace removal, row-to-row arrows, boundary Left/Right,
  collapse/expand, Zoom, and split panes.
- Complete, star, duplicate, trash, restore, Todo markers and progress,
  read-only rows, date insertion, tag/date affordances, Markdown presentation,
  slash commands, and native spellcheck behavior.
- Every structural gesture is atomic and creates one coherent session-history
  entry.

### Selection, clipboard, and drag

- Pointer and keyboard range selection.
- Batch complete, delete, indent, outdent, duplicate, and reorder.
- Structural plain-text copy, cut, and indented multiline paste.
- Single-row and selected-block drag, keyboard drag, cross-pane drag, drop
  preview, no-op handling, and one Undo entry per drop.

### Images and attachments

- Native picker, clipboard, and filesystem drop ingestion.
- Multi-image validation and atomic import with the current size, pixel, count,
  and metadata limits.
- Independent image nodes and inline image-atom editing.
- Image resize, lightbox, alt/description editing, copy/cut/paste, upload
  progress, attachment list actions, and recovery feedback.
- Media code is dynamically loaded and is absent from the initial editable
  bundle.

### Export

- Export the current page or selected subtree as deterministic frontmatter
  Markdown or Korean-capable PDF.
- Both formats consume one immutable export snapshot.
- Save cancellation is a no-op; existing destinations require explicit
  overwrite confirmation; writes are atomic.
- Export code and PDF/font dependencies are loaded only when Export is invoked.

### History and resilience

- Rust session history is the sole mutation-history authority.
- Text coalescing, structural atomicity, Undo/Redo, pane navigation history,
  close-time flush, request idempotency, revision conflicts, and retryable
  failure feedback preserve the current observable contract.
- A restart clears session Undo/Redo but restores persisted content and local UI
  state.

## Excluded behavior

- Vault Markdown source-of-truth synchronization, background reconciliation,
  sync outbox, sync liveness, and compatibility with existing Vault content.
- GitHub Notifications projection, viewed-state persistence, plugin controls,
  and GitHub authentication/network behavior.
- v1 database migration or compatibility readers.
- Mirrors/backlinks, board/table layouts, timeline views, collaboration, CRDT,
  and cloud storage.
- Any visual redesign.

## Architecture

### Dependency direction

```text
notes-core
  -> notes-application
    -> notes-sqlite
      -> desktop Tauri adapters

desktop React feature modules
  -> generated IPC contracts
    -> desktop Tauri adapters
```

No inner crate imports Tauri, React, filesystem UI, or SQLite. React never
constructs SQL or owns authoritative mutation history.

### Domain model

`notes-core` grows the node model only when a parity slice needs the field.
The final node contract contains:

- identity, kind (`page`, `text`, `image`), marker (`bullet`, `todo`);
- parent, sparse sibling order, title, supporting note, image caret offset;
- collapsed, starred, completed, archived, deleted, read-only state;
- created and updated timestamps;
- media display metadata that is intrinsic to the node.

Attachments are separate entities keyed by node ID. Tags and dates are derived
indexes, never an independently editable source of truth.

### Commands and queries

User gestures map to semantic commands such as `SplitNode`,
`RemoveEmptyNode`, `MoveForest`, `SetArchiveState`, and `ImportAttachments`.
Each command plans a reversible domain patch and commits through one SQLite
transaction. The receipt contains only the new revision and affected records.

Queries remain bounded:

- bootstrap returns navigation plus an initial viewport;
- outline queries are cursor/anchor based;
- search and library queries are paged;
- export builds a snapshot only after the user invokes Export.

### Frontend state

The desktop keeps four distinct state classes:

- confirmed query model;
- immediate draft and optimistic gesture overlay;
- pane-local navigation, focus, selection, and scroll session;
- lazy feature runtime state for media, export, and settings.

A pure keyboard resolver converts DOM key facts and the visible outline into an
intent. React effects execute the intent through `NotesStore`; focus helpers
apply caret placement only after the corresponding optimistic or confirmed row
exists.

### SQLite

The development database schema is changed in place and remains schema v1
until a release compatibility requirement exists. The DB worker remains the
single connection owner. Tables are limited to nodes, attachments, derived
tags/dates, FTS, metadata, and local UI state. Vault-sync and GitHub projection
tables are not created.

### Lazy boundaries

The initial editable graph contains the shell, library basics, outline
primitives, keyboard resolver, draft runtime, and IPC adapter. Search details,
Archive/Trash tools, settings, media ingestion/editing, export, PDF rendering,
repair tools, and development probes load on first use.

## Delivery slices

1. Text keyboard and atomic tree gestures.
2. Full node fields, supporting notes, collapse, Todo, Markdown/date affordances.
3. Library lifecycle, structured discovery, data controls, and settings.
4. Selection, structural clipboard, and drag/drop.
5. Attachments and image editing.
6. Markdown/PDF export.
7. Cross-feature resilience, performance, Windows/macOS behavior, and visual
   regression.

Every slice begins with a failing characterization test, reaches a real
React-to-SQLite boundary early, and is independently shippable on the v2
branch.

## Acceptance

- Every included row in `docs/v2/feature-parity-matrix.md` reaches `complete`
  with an automated oracle and a manual desktop path.
- Existing visual goldens remain unchanged.
- No production dependency points from a v2 module to legacy `src/features/notes`
  or legacy `src-tauri/src/notes`.
- Vault sync and GitHub Notifications are absent from the v2 production graph.
- Initial editable JavaScript remains at or below 300KB raw / 90KB gzip.
- Core input-to-paint p95 remains at or below 20ms with no task over 50ms in the
  fixed 200-input workload.
- The existing v2 Rust, frontend, contract, architecture, security, bundle, and
  packaged-process gates pass after every completed delivery slice.
