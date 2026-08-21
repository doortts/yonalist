# Journal days hang from a real Journals node

Design doc. Written 2026-08-21.

> Process note: `fable-opus-loop` puts design and adversarial review on Fable 5.
> Fable was over its limit for this session, so Opus wrote this doc and the code
> both. The independent review the skill asks for has not run. Re-run the Fable
> review against the commits before treating this as reviewed work.

## Contract

**Goal.** A journal day is a child of a real `Journals` node instead of a
top-level page, so the Home outline draws every day nested under one `Journals`
bullet, while Today, the calendar, the feed and carry-over keep working
unchanged.

**Acceptance.**

| # | Row |
| --- | --- |
| A1 | A day written when no Journals node exists creates it — a real bullet under root titled `Journals` — and hangs the day from it. |
| A2 | A day written when the Journals node exists hangs from that one. No second node, whatever the title says. |
| A3 | The page list still holds journal days, so `findJournalPage`, the calendar, the feed and carry-over read them as they do today. |
| A4 | Export keeps each day as a document of its own: its own folder at the vault root, `parent:` naming the Journals node. The retirement pass leaves it alone. |
| A5 | A day written for the first time gets its own file rather than being written into the Journals document. |
| A6 | The sidebar's Pages list does not name the Journals node, and `⌘1`–`⌘9` number the same pages they numbered before. |

**Non-goals.**

- Moving day folders inside a `Journals-<yid>/` folder. Every document folder
  this app writes sits at the vault root, and a day keeps the flat folder it
  already has.
- A user-facing "give this node its own document" action.
- Renaming or translating the `Journals` title, or defending the node against a
  rename. The id is the identity; the title is the user's.
- Any schema version, compatibility reader, or migration. Pre-release: the days
  already sitting at root are moved by hand (see **Existing data**).
- Moving the days already in the user's vault as part of the code change.

**Boundaries.** React (`notesStore`, `App.tsx`, `optimisticOutline`), IPC (no new
command — the existing `createNode`), Rust SQLite (`queries.rs`), Rust sync
(`export.rs`), the dev preview API.

**Manual proof.** In a fresh Tauri app: `⌘⇧J` writes today, Home shows `Journals`
with today nested under it, the sidebar calendar and Today still open the day,
and the vault holds `Journals-Sm91cm5hbHMA/README.md` naming the day while the
day keeps its own `YYYY-MM-DD-<yid>/README.md` with `parent: Sm91cm5hbHMA`.

## The node

A fixed id, `Sm91cm5hbHMA` — `Journals\0` in base64url, which is what makes it a
valid `yid` (`notes-core/src/id.rs`: a block id is `root` or twelve base64url
characters, so a readable name like `yonalist-trash` cannot be a node id at all;
a file stating one as its `parent:` is quarantined).

Fixed rather than derived per vault, unlike the recovery page's
`Uuid::new_v5(vault_uuid, b"yonalist-recovery-page")`: the id has to be a literal
in the storage layer's SQL and a constant in the frontend, and a per-vault
derivation would have to be plumbed to both. Every device of a vault lands on the
same id either way, which is the property that matters — a day arriving from
another device names a parent this device already agrees on. The cost is that the
same id names the Journals node in every vault, which nothing reads across
vaults.

## The rule that changes

Today one predicate does two jobs: `parent_id = 'root'` means both *is a page*
and *owns a document of its own*. This change separates them.

- **Owns a document**: parent is `root` **or** the Journals node. Three places
  encode it — `pending_documents` (twice: where the climb stops, and which of
  the climbed nodes are documents) and the retirement pass (both halves).
- **Is a page** (`sync_documents.is_page`): unchanged, still `parent_id =
  'root'`. A day under Journals is a *split document* — the shape the format
  already has, stated by `parent:` in its frontmatter and recorded as
  `is_page = 0` by both the exporter and the merger. Widening `is_page` instead
  would put the exporter and the merger on opposite answers for the same file,
  since the merger reads it from the file (`page.parent.is_none()`).
- **Is in the page list** (`queries.rs::pages`): parent is `root` or the Journals
  node, so `state.pages` keeps carrying the days.

The retirement pass has to widen even though a day's recorded `is_page` becomes
`0` on its first export after the move: until that export it still reads `1`, and
a pass that ran in between would retire the day, delete its folder, and inline
its rows into the Journals document.

## Items

Each item is one commit, with its test written first.

**Item 1 — the storage rule.** `crates/notes-sqlite/src/queries.rs::pages` and
`crates/notes-sync/src/export.rs` (`pending_documents`, `begin_retirement`).
Tests:

- `crates/notes-sqlite/tests/` — a child of the Journals node is in the page
  list, and a grandchild is not (A3).
- `crates/notes-sync/tests/export_core.rs` — a day under the Journals node keeps
  its own file rather than being written into the Journals document (A5), and
  `begin_retirement` returns 0 for it (A4).

**Item 2 — the creation path.** `apps/desktop/src/notesStore.ts`,
`apps/desktop/src/optimisticOutline.ts`, `apps/desktop/src/store/storeSupport.ts`
(the `JOURNALS_ID` constant). A provisional journal page carries the Journals node
as its parent; `materializePage` writes that parent rather than a hardcoded root,
and creates the Journals node first when the page list does not have it. Test:
`apps/desktop/src/journalStore.test.ts` — writing into today sends the Journals
node's `createNode` and then the day's, with the day's `parent_id` naming it
(A1); with the node already in the page list only the day's command goes out
(A2).

**Item 3 — the sidebar.** `apps/desktop/src/App.tsx`: `pageRows` skips the
Journals node the way it already skips dates. Test:
`apps/desktop/src/journalSidebar.test.tsx` — the Pages list has no `Journals`
row, and `⌘2` still opens the second named page (A6).

**Item 4 — dev preview parity.** `apps/desktop/src/preview/previewApi.ts` lists
pages the way the storage layer does, so the browser preview draws the same tree.
Covered by the item 2 and 3 tests running against the preview API where they
already do; no new test of its own.

## Existing data

The two days already in the user's vault stay where they are: they are pages in
the database and link lines in the root `README.md`, and this change does not
reach back for them. Two ways forward, neither of them code:

1. Drag them under the `Journals` bullet in Home once it exists. This is an
   ordinary move — stamped, undoable, exported like any other.
2. With the app closed, one statement per day:
   `UPDATE notes_nodes SET parent_id = 'Sm91cm5hbHMA' WHERE id = '<day>';`
   The update trigger stamps the row and marks it dirty, so the next export
   moves the link line into the Journals document by itself.

## Undo

Both writes are ordinary commands, so writing the first day of a fresh vault
leaves two undo steps: the day, then the Journals node. Undoing only the first
leaves an empty `Journals` bullet in Home — untidy, not wrong, and the next day
written fills it again. Folding the two into one step would mean a new command
shape at the IPC boundary, which is more than this buys.

## Risks

1. **The sync layer is the blast radius.** The predicate that decides which node
   owns a file is load-bearing for the whole vault layout, and a wrong answer
   either inlines a day into the Journals file or leaves two files claiming the
   same rows. Item 1's tests are the guard, and the manual proof reads the vault
   rather than the screen.
2. **A day arriving before the Journals node.** A device reading the vault fresh
   can meet a day file whose `parent:` names a node it has not read yet.
   `place_missing_parent` already stands one in, empty-stamped so the real one
   wins, and the fixed id is what lets the two be the same node.
3. **`owningPageId` climbs to `root`.** A zoom inside a day now answers
   `Journals` rather than the day, so the sidebar's current-page mark can land on
   a row the Pages list does not draw. Cosmetic, and left alone here.
