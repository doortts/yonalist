# Workflowy Notes Interaction Expansion Design

**Status:** Approved by the user on 2026-07-11.

**Scope:** The Yonalist Notes feature only. Inbox, Notifications, authentication,
existing Markdown items, network clients, caches, and host navigation behavior must
remain unchanged.

## Goal

Complete the local-first Workflowy-style editing loop around the existing Notes
outline: children can always be created, actions live beside the bullet, root pages
can be archived or moved to Trash, tags and dates are useful navigation primitives,
images can be stored and resized offline, and both text and structural changes can
be undone.

## Product Authority

The user-supplied signed-in Workflowy screenshots are the visual authority. Current
official Workflowy help is the behavioral reference for bullets, tags, dates,
images, and keyboard shortcuts.

## Isolation Boundary

- New React code lives under `src/features/notes/`.
- New frontend domain contracts live in `src/domain/notes.ts` or focused Notes-only
  modules under `src/domain/`.
- New persistence code lives under `src-tauri/src/notes/`.
- The host may register new Notes commands, but non-Notes reducers, services, and
  network code may not import Notes implementation modules.
- Notes remains offline-only and uses `<vault>/.yonalist/notes.sqlite` plus
  `<vault>/.yonalist/notes-assets/`.

## Current Delivery Scope

### Outline creation and action rail

- A zoomed page always has a child creation affordance below its title.
- Empty pages show a visible `+`; non-empty pages show the same trailing affordance
  on hover and focus.
- Creating a child uses the existing serialized `createChild(parentId)` path and
  focuses the new empty row.
- Ordinary rows use a stable grid ordered as action menu, collapse arrow, bullet,
  and text. Hiding the menu must not move the other columns.
- The page-title menu moves from the far right into a matching left action rail.
- The ellipsis is visible while the row is hovered, contains focus, is selected, or
  owns an open menu. Touch users can reveal it by selecting the row.
- Arrow click only expands or collapses. Bullet click only zooms. Bullet drag only
  reorders after the movement threshold. Ellipsis click only opens the menu.

### Collapsed-parent emphasis

- A node with children that is collapsed shows a 26-28px low-contrast circular
  halo around the existing 7px bullet dot.
- Expanded parents and leaves use the ordinary bullet.
- Hover and focus strengthen the halo without changing geometry.
- Completed rows retain enough contrast to reveal the collapsed state.
- Light and dark themes use semantic tokens instead of hard-coded palette values.

### Root-page lifecycle

- Each root page in the Notes library has a separate page-selection target and
  action menu.
- Root actions include Open, Star/Unstar, Archive, Move to Trash, Duplicate, and
  Export.
- Archive is distinct from Trash. Archiving marks the entire root subtree in one
  transaction and removes it from All, Starred, Recent, Tags, and normal search.
- The Archive library view is read-only except for Unarchive and Move to Trash.
- Unarchive restores the original parent and sibling order where possible and uses
  the existing sparse-key rebalance behavior when the original slot is occupied.
- Moving a root page to Trash requires confirmation that descendants are included.
- Permanent removal remains limited to Empty Trash.
- Archiving or trashing the open page selects the next visible root, then the
  previous root, then the empty detail state. Undo restores navigation and focus.

### Supporting note

- `Shift+Enter` from a title reveals and focuses the supporting note.
- Supporting notes remain plain text owned by the node, render below the title,
  grow with content, and use the existing draft/write queue.
- Tags and dates are recognized in both title and supporting note.

### Tags

- Typing `#` or `@` followed by Unicode letters or numbers, `_`, or `-` creates a
  tag without a separate metadata editor.
- Stored title and note text remain byte-for-byte user content. Derived tag rows are
  rebuilt transactionally after every content mutation.
- Matching is case-insensitive while display preserves the first encountered
  spelling.
- In resting display mode tags are underlined interactive tokens. Focus switches to
  the unchanged textarea so caret, selection, split behavior, and Korean IME remain
  reliable.
- Clicking a tag toggles it as a global Notes filter. Multiple clicked tags combine
  with AND. Clicking an active tag removes it and restores the previous unfiltered
  zoom location when the last filter is removed.
- The search box accepts exact tag clauses, excluded clauses such as `-#later`, and
  OR between tag clauses. Plain text and tag clauses can be combined.
- Tag results show matching nodes with ancestor context and permit navigation to the
  original location.
- The Tags library shows normalized tags and live item counts.
- Active search excludes archived and trashed nodes.

### Dates

- `!!`, the Add date menu item, and clicking a date pill open one shared picker.
- The picker supports an input, Today, Tomorrow, Next week, month navigation, a
  calendar grid, range mode, format selection, and Remove date.
- Supported numeric and natural-language inputs follow the approved Workflowy
  reference. Natural language resolves to concrete local calendar dates.
- Canonical start/end dates are indexed for search. Raw title/note content remains
  portable and Markdown export remains readable.
- Date presentation changes do not rewrite unrelated text.
- Date insertion, update, removal, range selection, and format changes participate
  in Notes Undo/Redo.

### Images

- PNG, JPEG, WebP, and GIF images can be chosen from the bullet menu or dropped onto
  a node. SVG is excluded from this delivery because active content requires a
  separate security design.
- Imported files are copied into the Notes-owned asset directory. UI state never
  depends on the original absolute path.
- The backend validates the file signature, MIME type, byte limit, and decoded pixel
  dimensions before publishing the attachment record.
- Default display width is the smaller of intrinsic width, the Notes content width,
  and the current viewport. Small images are not enlarged.
- Hover and focus reveal a resize handle. Pointer resizing changes width only; height
  follows intrinsic aspect ratio. Keyboard resize actions provide an accessible
  alternative.
- Display width is persisted. Resize commits once at pointer release and is one undo
  step.
- Deleting a node keeps attachment bytes while Undo or Trash restore remains
  possible. Empty Trash and startup reconciliation remove unreferenced owned files.
- Markdown export writes a sibling asset directory with relative links. PDF export
  embeds scaled images while preserving aspect ratio.

### Undo and redo

- `Cmd/Ctrl+Z` undoes the latest Notes content or structural command.
- `Cmd/Ctrl+Shift+Z` redoes on both platforms; `Ctrl+Y` also redoes on Windows.
- Text bursts are coalesced per field and node. Blur, structural commands, picker
  commits, and idle timeout close the burst.
- Create, split, remove-empty, move, indent, outdent, reorder, collapse, complete,
  star, duplicate, Archive, Trash, restore, date mutation, image mutation, and image
  resize are undoable.
- Undo and redo are enqueued through the same per-vault coordinator as ordinary
  writes, so an inverse never overtakes an in-flight save.
- History is session-only, scoped to one vault, and cleared on vault change, Notes
  database deletion, or app restart.
- The history is bounded to 100 entries and a 50 MiB estimated payload ceiling.
- A new forward command after Undo clears Redo.
- UI navigation and focus are stored with each command and restored when valid.

## Persistence Model

The migration after schema version 2 adds:

- `archived_at TEXT` and `archive_root_id TEXT` to `notes_nodes`.
- `notes_attachments(id, node_id, sort_key, relative_path, content_hash,
  original_name, mime_type, byte_size, intrinsic_width, intrinsic_height,
  display_width, created_at, updated_at)`.
- `notes_dates(node_id, field, normalized_start, normalized_end, token_text)` as a
  derived index.
- A tag-kind column so `#topic` and `@person` do not collide.
- `notes_history_entries` and `notes_history_changes` hold the current app session's
  bounded row-level before/after journal. Initialization removes entries owned by
  expired sessions; closing or resetting Notes removes the current session entries.

The schema does not add node types or alternative layouts in this delivery.
Migrations are transactional and include upgrades from versions 1 and 2.

## Menu Scope

The current menu includes Complete, Star, Add/Edit note, Add date, Move To, Upload
image, Duplicate, Export subtree, Delete/Move to Trash, Expand all, Collapse all,
Sort A-Z, Sort Z-A, Retry save when needed, and creation/change timestamps.

Collaboration-only or unimplemented commands are omitted rather than displayed as
disabled placeholders.

## Deferred Scope

- Turn Into and all node types: headings, paragraph, to-do type, numbering, quote,
  code block, and divider.
- Board and Table layouts.
- Comments, sharing, permissions, and synchronization.
- Mirrors, templates, internal links, and backlinks.
- General file and PDF attachment handling.
- Calendar pages and Move to Today/Tomorrow/Next week.
- Native mobile gestures.

## Accessibility

- Menus follow Base UI keyboard behavior and restore focus to their trigger.
- Tags are buttons or links with names that include the tag and filter state.
- The calendar uses an accessible grid, named month navigation, and announced range
  selection.
- Image resize handles have pointer and keyboard operation with current width
  announced.
- Focus-visible styling meets contrast requirements in both themes.
- Reduced motion disables non-essential menu, halo, and resize transitions.

## Stage Gate

Every implementation stage must provide:

1. A test observed failing for the missing behavior.
2. Focused frontend and/or Rust tests passing after implementation.
3. Full relevant regression suites passing.
4. Independent specification and code-quality review.
5. Corrections for every Critical or Important finding, followed by re-review.
6. Desktop and narrow visual evidence for user-facing stages.

## Final Verification

- Full frontend tests and production build.
- Full Rust test suite.
- SQLite migration tests from version 1 and version 2.
- Desktop and narrow Playwright workflows for create, menu, Archive, tags, dates,
  images, Undo, and Trash restore.
- 1,000- and 10,000-node native and frontend performance probes.
- High-resolution image import and resize stress test.
- Bundle-size comparison against commit `7899b4b`.
- A broad adversarial review, an independent review of those findings, corrections
  for validated issues, and a final focused regression run.
