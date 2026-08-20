# refreshPages keeps the page list to root's own children

Design phase ran on Opus, not Fable 5: the Fable agent stopped on
`You've reached your Fable 5 limit`.

## Contract

| Field | Content |
| --- | --- |
| Goal | After a vault change wide enough to force the re-read, the sidebar Pages list holds only live direct children of the root. |
| Acceptance | A root viewport answer that carries a grandchild (`parentId !== ROOT_ID`) leaves that grandchild out of `pages`; the real pages in the same answer stay. |
| Non-goals | Ordering of `pages`; `queryViewport`'s own contract in Rust; the row-by-row patch path (`storeState.applyReceipt` already filters); bootstrap (`queries::bootstrap` already selects `WHERE parent_id = ROOT_ID`); the truncation and `active_page_id` ceilings below, both of which need a Rust-side command this item does not add. |
| Boundaries | React store only (`apps/desktop/src/notesStore.ts`). No IPC payload, Rust, SQLite or filesystem change. |
| Manual proof | N/A — the trigger is another device's sync change; the store test drives the same path. |

## Defect

`refreshPages` (apps/desktop/src/notesStore.ts:281) maps every non-deleted node
of `queryViewport({ pageId: ROOT_ID })` into `pages`. That query returns the
page's whole subtree in path order — `PAGE_RANGE` /`window_sql()`,
crates/notes-sqlite/src/queries.rs:22-34 — so nested bullets under a page land
in the sidebar as if they were pages. Every other definition of a page is a
live direct child of the root: crates/notes-sqlite/src/queries.rs:56-74 and
apps/desktop/src/store/storeState.ts:87-99.

Reached from `absorbVaultChange` (apps/desktop/src/notesStore.ts:209) whenever
`patchFromVault` declines — no change named, more than `VIEWPORT_LIMIT` ids
named, or an incomplete forest answer.

## Ordering

Not part of this item. `queryViewport` orders by stored path, and a root child's
path segment is its sort key zero-padded behind a sign digit
(crates/notes-sqlite/src/node_paths.rs:20-38), so path order over root's children
agrees with the `sort_key, id` order `bootstrap` produces. It agrees with
`applyReceipt` only up to a tie: `storeState.ts:100-101` breaks equal sort keys
with `localeCompare`, which is ICU order, while both SQL paths break them in
BINARY order.

## Ceilings this item leaves standing

Both are older than this item and both need a Rust-side `notes_pages` command —
`queries::bootstrap`'s SELECT lifted into a shared `fn pages` — to remove:

- The root window is cut to `VIEWPORT_LIMIT` (80) rows of the whole subtree
  before the filter runs, so pages past that cut vanish from a re-read list
  rather than merely being wrong. `state.pages` is more than the sidebar:
  apps/desktop/src/App.tsx:349 reads it as the ⌘N jump-target list, and
  apps/desktop/src/App.tsx:372-376 treats an open page missing from it as dead
  and leaves Settings for the all-pages view, so a dropped page can throw the
  user off the page they were on. Marked `ponytail:` at
  apps/desktop/src/notesStore.ts:293.
- `queries::viewport` writes `active_page_id` when the requested page is not
  the stored one (crates/notes-sqlite/src/queries.rs:157-166), and
  `absorbVaultChange` runs `refreshPages` beside `viewport.reload()` in one
  `Promise.all` (apps/desktop/src/notesStore.ts:226-230). Whichever the single
  DB worker serializes last wins, so a wide sync change can leave the restart
  page at Home.

## Items

1. **`refreshPages` filters to root's own children.**
   Test: `apps/desktop/src/notesStore.test.ts`, in
   `describe("다른 기기의 변경 흡수")`, reusing the file's `api`/`page`/`bullet`
   helpers — `bullet` already carries `parentId: "page-1"`, which is the
   grandchild shape. The root viewport answers with a page, a grandchild, and a
   second page; the store absorbs a change wide enough to decline the patch
   (200 `changedNodeIds`); `pages` must be `["page-1", "page-2"]` — the second
   page is what keeps the assertion from passing on the boot state alone.
