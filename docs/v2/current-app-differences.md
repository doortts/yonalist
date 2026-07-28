# Current Yonalist and v2 differences

The comparison baseline is `main@502af65`. Visual appearance is intentionally not a
difference: v2 owns exact copies of the current `styles.css`, `notes.css`, class names,
pane dimensions, color tokens, typography, and outline DOM geometry.

| Area | Current application | v2 implementation |
|---|---|---|
| Initial load | Active nodes, fields, and attachment metadata can enter one workspace load | `BootSnapshot` contains navigation and at most 80 current-page nodes |
| Frontend state | Coordinator/runtime/commands/history types are widely coupled | `NotesStore` separates confirmed state, draft overlay, session revision, and pane state |
| Text input | Draft and persistence logic crosses the legacy workspace runtime | Immediate overlay; 300ms, blur, and close flush through one command queue |
| Mutation result | Some paths refresh the workspace | Patch-only `MutationReceipt` with revision and changed/deleted IDs |
| Undo/Redo | Frontend coordination plus Rust temporary history | Rust owns mutation patches and exposes history depth; a bounded frontend timeline interleaves pane-only navigation |
| Rust boundaries | IPC, SQL, domain, and platform concerns concentrate in large modules | `notes-sqlite → notes-application → notes-core`, with Tauri as an outer adapter |
| SQLite ownership | Vault-scoped shared connection mutex | One dedicated worker owns the connection |
| IPC types | Large DTOs are maintained on both sides | Rust DTOs generate 23 TypeScript contract files |
| Search | Search participates in the legacy workspace runtime | FTS5 text search plus indexed `is:starred`, `is:trash`, `tag:`, and `date:` filters |
| Startup | DB work and UI preparation are mostly sequential | WebView and DB/schema/bounded-snapshot preparation run concurrently |
| Bundle | Notes entry measured around 198KB gzip at the baseline | Initial editable JS graph is 276.1KB raw / 85.1KB gzip; Search and slash menus are lazy |
| Data compatibility | Migration, repair, and legacy-schema defense paths | New schema v1 only; no v1 data compatibility |
| Scope | Attachments, image handling, export, Markdown sync, and external sources share runtime | Text Notes core is complete first; remaining approved parity features are added behind isolated application ports while Vault sync and GitHub Notifications stay excluded |

## Behavior currently ported

- Page creation and last-page restart restoration.
- Immediate page/bullet editing with Korean IME Enter protection.
- The existing `Add child` composer creates the first bullet on an empty page.
- Enter creation, Tab indent, Shift+Tab outdent, move command support.
- Complete, star, full-subtree duplicate, soft delete, and ancestor-safe restore.
- Session Undo/Redo with grouped text edits.
- Bounded viewport paging and revisioned cursors.
- Zoom and split pane sessions with keyboard/pointer resize and independent scrolling.
- FTS text search and indexed Starred/Trash/tag/date filters.
- Stable title presentation for headings, quotes, dividers, strong/strike text,
  safe HTTP(S) links, Unicode tags, and valid ISO dates without replacing the
  authoritative textarea.
- Unicode/NFC tag derivation from both titles and supporting notes; clicking a
  visible tag opens the bounded indexed tag query.
- Shift/modifier/keyboard selection and native cross-row text-drag promotion,
  including single-row contextual selection. Selecting a parent materializes its
  visible descendants immediately and then revision-checks the complete SQLite forest.
- Atomic multi-row complete, delete, reorder, indent, outdent, and full-subtree
  duplicate commands. Every batch is one SQLite commit and one Undo entry.
- Structural `text/plain`/`text/markdown` copy and lossless cut, plus bounded
  Markdown or indented-text paste as one imported forest. Browser preview uses
  the same batch command shapes as Tauri. Cut is unavailable if the authoritative
  2,000-node forest bound is exceeded or its revision is stale.
- Pointer drag for one row or a selected forest uses the existing bullet
  handle, pointer-following card/stack, count badge, and depth-preview styling,
  then commits through one `MoveNodes` command.
- The same drag projection supports Space/Enter keyboard pickup, arrow movement,
  Escape cancellation, and pointer drops across split panes. The insertion line
  is portalled into the destination pane without changing its CSS.
- Zoom and split navigation are interleaved with Rust mutation history. Undo/Redo
  restores pane selection, editing field, focus, and caret; a navigation fence
  prevents later typing from coalescing into an older history group.
- Batch Import/Move/Duplicate loads the complete target sibling set before any
  rebalance, preventing sparse sort-key collisions while keeping one transaction
  and one Undo entry.
- Close-time draft flush, real Windows close-path verification, and close-only
  `PRAGMA optimize`.

## Remaining parity work

Attachments, image editing, export, settings, Recent/Archive, full tag-count
and multi-filter navigation, the date picker, and remote Markdown image sizing
remain pending. Direct tag/date queries already use derived indexes. Vault
synchronization, GitHub Notifications, migration, repair, and v1 compatibility
readers remain the explicit exclusions.
