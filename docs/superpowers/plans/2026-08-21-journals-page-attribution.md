# Page attribution catches up with the Journals node

Design doc. Written 2026-08-21. Journal days hang from the fixed Journals
node (`notes_core::JOURNALS_ID` / `storeSupport.ts::JOURNALS_ID`,
ff038fb1..8a3899b1), and the page rule everywhere else already reads: a page
is a live child of the root **or** of the Journals node
(crates/notes-sqlite/src/queries.rs:51-61 `pages`,
apps/desktop/src/store/storeSupport.ts:85-87 `isPageParent`). Three
page-attribution sites were never widened for that. All three are confirmed
broken by reading the code; none of the brief's claims fell apart, though two
needed sharpening (see "Where the findings diverge from the brief").

Out of scope of `2026-08-21-journals-node-wedge.md`, which names this work
explicitly.

## The defects

1. **`crates/notes-sqlite/src/queries.rs` — twice, not once.** The scalar
   subquery that resolves a hit's `page_id` climbs the ancestor chain and
   answers with the ancestor whose `parent_id = ROOT_ID`. It is written in
   `search` (static SQL, lines 275-291, binds `?4` = `ROOT_ID`) and again in
   `filtered_search` (`format!`-built, lines 353-373, binds `?3` = `ROOT_ID`).
   A hit inside a journal day therefore resolves to the Journals node itself —
   or, when sync `park` or a drag has moved the Journals node under a real
   page, to that unrelated page. Consumers make it user-visible:
   `SearchPanel.tsx:44` opens `hit.pageId`, and `JournalReferences.tsx:48`
   filters `hit.pageId !== pageId` to build the "elsewhere" list, then opens
   that page (line 68) and reads its title out of `shell.pages` (line 71) —
   so a reference from another journal day is titled "Journals" and opens the
   wrong place.
2. **`apps/desktop/src/preview/previewApi.ts:703`** answers the same question
   with `node.parentId === ROOT_ID ? node.id : activePageId` — a third,
   different wrong answer. A hit on a journal day's own row, or on anything
   nested inside one, reports whatever page happens to be active, so the dev
   preview and the storage layer disagree with each other. On a journal day
   page this hides the Linked references feature entirely: the preview stamps
   the active day's id on every nested hit, and the `elsewhere` filter throws
   them all away.
3. **`apps/desktop/src/appNavigation.ts:120-134` `owningPageId`** stops its
   walk at `current.parentId !== ROOT_ID`, so zooming inside a journal day
   (from Home, where the rows are loaded) names the Journals node as the
   owning page — and when the Journals node sits under a real page, names
   that unrelated page.

## Contract

| Field | Content |
| --- | --- |
| Goal | Everywhere the question "which page is this row in?" is asked, a row inside a journal day answers with the day — the same rule `pages` and `isPageParent` already encode. |
| Acceptance | Rows A1-A5 below. |
| Non-goals | No new sidebar behavior: the Journals section and calendar do not start highlighting the current day (see item 2's scope statement). No `node.id <> JOURNALS_ID` exclusion from search results (argued below). No change to the `SearchHit` contract shape — `page_id` stays a non-null `String` (crates/notes-application/src/contracts.rs:529-531, packages/contracts/generated/SearchHit.ts). No touch of `storeState.ts:82`'s departed rule — that predicate asks whether a *destination* is a page and is already journal-aware through `pageIds`. |
| Boundaries | Rust/SQLite (`queries.rs`) and frontend (`appNavigation.ts`, `previewApi.ts`). No IPC payload shape change, no schema change, no new Tauri command. |
| Manual proof | Item 1 carries the real user path; items 2 and 3 are unit-level (reasons per item). |

Acceptance rows, one item each:

| Row | Observable pass/fail | Item |
| --- | --- | --- |
| A1 | An FTS search hit on a row nested inside a journal day carries `page_id` = the day's id. | 1 |
| A2 | A filtered search hit (`is:starred` path through `filtered_search`) inside a journal day carries `page_id` = the day's id. | 1 |
| A3 | With the Journals node parented under a real page, a hit inside a day still names the day — deterministically, not by luck of CTE row order. | 1 |
| A4 | `owningPageId` answers a row nested inside a journal day with the day's id; in the parked case it no longer answers with the enclosing real page. | 2 |
| A5 | Preview `search` stamps `pageId` by the storage rule: the day for the day's own row and for rows nested inside it. | 3 |

## Where the findings diverge from the brief

- **`parent_id IN (ROOT, JOURNALS)` alone is not a correct widening.** For a
  hit under a journal day, *two* ancestors qualify: the day (child of
  Journals) and the Journals node (child of root) — and in the parked case,
  the day and the enclosing real page. The existing `LIMIT 1` has no
  `ORDER BY`, and a recursive CTE's emission order without one is not
  something SQL guarantees. The fragment therefore gains a `depth` column and
  `ORDER BY depth LIMIT 1`: the *nearest* qualifying ancestor is the page the
  row is inside, and the answer is unique under every placement of the
  Journals node. A3 exists to lock exactly this.
- **The preview ternary is wrong more deeply than the brief's framing.** Even
  widened to `isPageParent`, the ternary only answers hits *on* page rows;
  every nested hit still falls to `activePageId`, which on a journal day page
  erases the whole Linked references list. The fix has to walk ancestors, and
  the widened `owningPageId` (item 2) is that walk — the preview holds every
  node in memory, so the walk always terminates. This is still the requested
  outcome ("the preview and the real storage layer agree"), not extra scope.
- **The rest checked out.** Exactly two copies of the CTE exist, both in
  `queries.rs` (repo-wide grep for `WITH RECURSIVE ancestors`). The
  `filtered_search` param-numbering trap is real: its binds are
  `[?1 limit, ?2 offset, ?3 ROOT, ...filter values]` and the filter clause
  strings (queries.rs:217-260) hard-code `?4`/`?5`. `owningPageId` has one
  production consumer (App.tsx:264). The preview fixture *does* seed a
  Journals node and one day, `preview-day` titled "2026-08-20", with no
  children (previewOutline.ts:74-98) — the test creates the nested row
  itself. Rust search tests today assert hit counts only
  (crates/notes-sqlite/tests/vertical_slice.rs:615-630); `queries.rs` has an
  inline test module with fixture helpers but no search coverage — the new
  test lives there.
- **Useful mechanics confirmed for the tests:** `notes_fts` is trigger-fed
  from plain `INSERT`/`UPDATE` on `notes_nodes` (schema.sql:243-253), so the
  `insert_child` helper in `queries.rs::tests` feeds FTS for free.
  `notes_tags`/`notes_dates` are *not* trigger-fed, so the filtered-path probe
  is `is:starred` (one `UPDATE notes_nodes SET starred = 1`), not `tag:` or
  `date:`.

## The SQL shape (item 1 decision)

Chosen: **(b) — one shared fragment with both ids inlined as SQL literals**,
plus the depth ordering:

```rust
/// The page a hit sits in: the nearest ancestor (the hit itself included)
/// that the page rule names -- a live child of the root or of the Journals
/// node. Same rule as `pages` above and `storeSupport.ts::isPageParent`.
/// The ids are inlined so the fragment carries no positional parameter for
/// its two callers to renumber around.
fn page_id_sql() -> String {
    format!(
        "(
            WITH RECURSIVE ancestors(id, parent_id, depth) AS (
                SELECT node.id, node.parent_id, 0
                UNION ALL
                SELECT parent.id, parent.parent_id, child.depth + 1
                FROM notes_nodes parent
                JOIN ancestors child ON child.parent_id = parent.id
            )
            SELECT id FROM ancestors
            WHERE parent_id IN ('{ROOT_ID}', '{journals}')
            ORDER BY depth LIMIT 1
        )",
        journals = notes_core::JOURNALS_ID
    )
}
```

Why inline rather than renumber (option a): a shared fragment cannot carry a
numbered parameter that is legal in both statements — in `search` the root id
is `?4`, in `filtered_search` `?4`/`?5` belong to the filter values. Binding
the ids positionally forces either two divergent copies (the defect class the
`pages` doc comment warns about — a third and fourth copy of the rule) or a
dummy bind. Both ids are compile-time constants (`ROOT_ID = "root"`,
schema.rs:5; `JOURNALS_ID = "Sm91cm5hbHMA"`, notes-core/src/id.rs:31), so
inlining has no injection surface, and the house already builds SQL this way
(`PAGE_RANGE` + `window_sql()`/`anchor_sql()`, queries.rs:23-49).

Fallout inside item 1, all in `queries.rs`:

- `search`'s statement becomes a `format!` string; its binds shrink to
  `[?1 expression, ?2 limit, ?3 offset]` (the `?4` root bind disappears; the
  `node.id <> ?4` exclusion becomes an inlined `node.id <> '{ROOT_ID}'`).
- `filtered_search`'s binds shrink to `[?1 limit, ?2 offset, ...values]`, its
  `node.id <> ?3` inlines the same way, and the five filter clause strings
  renumber mechanically: `?4` → `?3`, `?5` → `?4` (starred, trash, tagged,
  tag:, date-range, single-date — queries.rs:217-260). Statements are
  prepared per call, not cached, so switching static SQL to `format!` changes
  no caching behavior.
- The `pages` doc comment's "written twice" warning (queries.rs:58-61) is
  updated to name the fragment as the SQL-side home of the rule.

**Why the Journals node does NOT get the root's exclusion.** `node.id <>
ROOT_ID` is load-bearing, not cosmetic: the root row has no qualifying
ancestor, so a hit on it would make the scalar subquery yield NULL and
`row.get::<_, String>(20)` fail the whole search. The Journals node has no
such problem — its own hit resolves to itself when it sits under root, and to
the enclosing page when parked — and its title is user-visible text that
`pages()` lists and the viewport can legally open. Excluding it from results
would be a behavior change beyond this request. It stays a hit.

## Items, in order, one commit each

Item 3 consumes item 2's widened helper, so the preview lands last.

### Item 1 — SQLite search attributes journal content to the day (A1, A2, A3)

- **Change**: `crates/notes-sqlite/src/queries.rs` — add `page_id_sql()`,
  rebuild `search` and `filtered_search` on it as above. The sibling caller
  (`filtered_search`) is resolved here, in this commit, not deferred.
- **Failing test**: `search_names_the_journal_day_as_the_hits_page` in the
  existing `#[cfg(test)] mod tests` of
  `crates/notes-sqlite/src/queries.rs`. Fixture via the existing
  `insert_child` helper (text = id, FTS trigger-fed):
  - Healthy shape: Journals under root, day `"2026-08-20"` under Journals,
    bullet `"standup"` under the day. Assert `search("standup")` hit carries
    `page_id == "2026-08-20"` (A1), and the day's own row via
    `search("2026-08-20")` answers itself. Then
    `UPDATE notes_nodes SET starred = 1 WHERE id = 'standup'` and assert
    `search("is:starred")` answers the day too (A2 — the `filtered_search`
    path).
  - Parked shape, second in-memory connection: page `"office"` under root,
    Journals under `"office"`, day and bullet as before. Assert the hit still
    names the day (A3).
- **Red output**: assertion failures of the form
  `left: "Sm91cm5hbHMA", right: "2026-08-20"` (A1/A2) and
  `left: "office", right: "2026-08-20"` (A3).
- **Regression risk**:
  - *Hit on the Journals node itself*: unchanged — resolves to itself under
    root (its own anchor row qualifies at depth 0), to the enclosing page
    when parked; never NULL, matching today.
  - *Hit on a journal day's own row*: the anchor row (depth 0) qualifies, so
    the day answers itself — today it wrongly answers Journals.
  - *Ancestor chain that dead-ends* (orphaned parent id): the subquery yields
    NULL and the search errors — exactly today's behavior; the widened
    predicate can only qualify *more* ancestors, so no chain that resolves
    today stops resolving.
  - *Column positions*: the select list adds nothing; `page_id` stays index
    20, snippet 21, so `parse_node` and both row mappers are untouched.
  - *Filter clause renumbering*: mechanical but easy to fumble — the test's
    `is:starred` leg exists to catch a bad renumber loudly
    (`Invalid parameter count` or a wrong-value bind).
- **Focused run**: `cargo test -p notes-sqlite`.

### Item 2 — `owningPageId` stops at any page parent (A4)

- **Change**: `apps/desktop/src/appNavigation.ts:128` — loop guard
  `current.parentId !== ROOT_ID` becomes `!isPageParent(current.parentId)`
  (import from `./store/storeSupport`); the function's doc comment (lines
  113-119) widens the same way.
- **Failing test**: in the existing `describe("owning page")` of
  `apps/desktop/src/appNavigation.test.ts` (current tests at 150-176):
  `"stops at a journal day rather than the Journals node"` — Journals under
  `ROOT_ID`, day under `JOURNALS_ID`, bullet under the day → expect the day's
  id; and the parked variant (Journals under `page-1`, itself a root child) →
  still the day's id.
- **Red output**: `expected "day-1", received "Sm91cm5hbHMA"` and, for the
  parked variant, `received "page-1"`.
- **Scope statement (deliberate, per the brief)**: this is a unit-level
  contract fix whose visible outcome is unchanged in a healthy vault.
  `owningPageId`'s one production consumer is `App.tsx:264` (`zoomedPageId`),
  and `currentPageId` feeds only the `pageRows` highlight (App.tsx:1110) and
  `atAllPages` (286) — `pageRows` (275-277) draws neither the Journals node
  nor any journal day, so both the wrong id (Journals) and the right id (the
  day) mark nothing on screen. The one case the fix visibly changes: with the
  Journals node parked under a real page, zooming inside a day from Home
  today highlights that unrelated page as current; after the fix it
  highlights nothing. Making the Journals section highlight the day would be
  new behavior beyond this request and is a non-goal.
- **Regression risk**: root's own row and rows whose walk leaves the loaded
  set still answer null (the guard change cannot make `isPageParent(null)`
  true); the cycle guard is untouched.
- **Focused run**: `npm test -- appNavigation`.

### Item 3 — preview search answers with the storage rule (A5)

- **Change**: `apps/desktop/src/preview/previewApi.ts:703` —
  `pageId: node.parentId === ROOT_ID ? node.id : activePageId` becomes
  `pageId: owningPageId(node.id, nodes) ?? activePageId`, importing
  `owningPageId` from `"../appNavigation"`. The preview holds the whole
  fixture in `nodes`, so the walk terminates at a page for every live row;
  the `?? activePageId` keeps today's fallback for a hypothetically broken
  chain. `appNavigation` touches the DOM only inside functions, so the import
  is side-effect free at module load. (If review prefers not to point the
  preview at an app-navigation module, the fallback is a five-line local walk
  over `isPageParent` — noted, not chosen: the helper already exists and item
  2 just made it correct.)
- **Failing test**: in `apps/desktop/src/preview/previewApi.test.ts`,
  `"attributes a hit inside a journal day to the day"` — the fixture seeds
  `preview-day` ("2026-08-20") under `JOURNALS_ID` with no children
  (previewOutline.ts:86-97), so the test creates one:
  `execute` `createNode` `preview-day-entry` under `"preview-day"` with text
  `"Standup ritual"`, then `search("Standup")` → expect
  `hits[0].pageId === "preview-day"`; also `search("2026-08-20")` → the day's
  own row answers itself. Ids are unique to the test because the preview
  module keeps mutable state across the file's tests.
- **Red output**: `expected "preview-day", received "preview-page"`
  (`activePageId` is `"preview-page"` throughout — nothing in the preview
  reassigns it).
- **Regression risk**: hits on regular page rows keep answering themselves
  (`owningPageId` returns a page row's own id); hits nested under regular
  pages *change* from `activePageId` to the owning page — which is the Rust
  answer, i.e. the divergence this item exists to close; the Journals node's
  own hit answers `JOURNALS_ID`, matching Rust.
- **Focused run**: `npm test -- previewApi`.

## Final gates

Rust and frontend are both touched, so the second gate row of
`delivering-yonalist-changes` §5 applies. Exact commands, run once after the
diff is frozen:

- `npm test`
- `npm run lint`
- `npm run test:bundle`
- `git diff --check`
- `cargo test --workspace --no-fail-fast` — the skill's
  `--manifest-path src-tauri/Cargo.toml` names a path that does not exist at
  the repo root (the crate lives at `apps/desktop/src-tauri`, and the changed
  crate is `crates/notes-sqlite`); the workspace run covers both, and
  `--no-fail-fast` is required because a workspace run stops at the first
  failing binary.
- `cargo fmt --all -- --check`

No new or renamed Tauri command, so `npm run test:architecture` is not
required by the gate table. `SearchHit`'s shape is untouched, so no contract
regeneration.

## Manual proof

- **Item 1 (the real user path, shortest)**: in the desktop app, open Today
  and type a distinctive word into a bullet under the day; open search from
  another page, search that word, open the hit → the journal day page opens
  (titled by its date), not Journals and not the wrong page. Second angle,
  same fix: on day A write a bullet containing day B's date, open day B →
  Linked references lists the reference titled by day A's date, and clicking
  it opens day A.
- **Item 2**: N/A as a required step — no visible change in a healthy vault
  (scope statement above). The parked case is stageable if wanted (drag the
  Journals bullet under another page on Home, zoom into a row inside a day
  from Home, confirm the sidebar no longer highlights that page), but the
  unit test is the contract.
- **Item 3**: N/A — dev-only browser surface; the unit test locks the
  agreement with the storage rule, and item 1's manual path covers the
  user-facing behavior.
