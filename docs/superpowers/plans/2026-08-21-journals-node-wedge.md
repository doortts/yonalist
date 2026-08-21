# The Journals node wedge: creation of the fixed id becomes idempotent

Design doc. Written 2026-08-21. Fixes the `node already exists: Sm91cm5hbHMA`
banner from `docs/superpowers/plans/2026-08-21-journals-real-parent-node.md`'s
commit series (ff038fb1..8a3899b1).

## The defect

`materializeParent` (apps/desktop/src/notesStore.ts:447-459) decides whether
the Journals node exists by looking for its id in `state.pages`, then sends an
unconditional `createNode`. The page list holds only live children of root and
of the Journals node (crates/notes-sqlite/src/queries.rs:57-77), while the
backend's collision check spans the whole node table. So any state where the
fixed id is in the table but not in the page list wedges journaling
permanently: every day write fails, forever.

Two such states exist, and both are reachable by ordinary gestures:

1. **Live elsewhere.** The Journals node is a bullet, not a page-kind node, so
   dragging it off Home into any other row is legal. It leaves the page list;
   the next day write sends `createNode`, and `ensure_new_id`
   (crates/notes-core/src/tree.rs:416-422) answers `DuplicateNode`. The sync
   repair path (`park`, crates/notes-sync/src/merger.rs:633-658) can produce
   the same state without a drag, which is what the reported database shows —
   the node parked under the `복구됨` recovery page — but a single drag is a
   sufficient cause. No sync bug is required.
2. **Trashed.** Deleting the Journals bullet leaves a `deleted = 1` row (it
   has been exported, so `remove_node` trashes rather than hard-deletes,
   crates/notes-sqlite/src/mutations.rs:266-289). The briefing's assumption
   that this row would be revived is wrong: commands are planned before they
   reach SQLite (`execute_checked`,
   crates/notes-application/src/service.rs:355-382), the planning slice loads
   the row with no deleted filter (`collect_command_context` →
   `notes_node_records`, crates/notes-sqlite/src/repository.rs:21-30, 76-79),
   and `ensure_new_id` trips on a trashed row exactly as on a live one. The
   revive branch in `insert_node` (mutations.rs:303-307) only serves undo,
   which commits inverse patches without planning. The reported database is in
   this state right now, so it is still wedged.

A second defect landed in the same series. The receipt merge
(apps/desktop/src/store/storeState.ts:121-134) still defines a page as
`parentId === ROOT_ID` and deletes anything else from the page list, while
`queries.rs::pages` and the previous design's row A3 say journal days (children
of `JOURNALS_ID`) are pages. Consequences, all confirmed by reading the
consumers: a day never enters `state.pages` from its own creation receipt, so
within one session `findJournalPage` (apps/desktop/src/journal.ts:61-66)
misses it and a second Today press creates a duplicate day; and any receipt
touching an existing day node (rename, star, move) drops it from the list —
sidebar journal section, calendar, feed, and carry-over all read `state.pages`
(App.tsx:275-304) — until a restart re-reads SQLite.

## Decisions

**Where the guarantee lives: the backend, not the frontend.** The frontend
cannot know whether the fixed id exists — any oracle it consults duplicates
state the backend owns, and the page list is *deliberately* filtered. The one
place that sees the whole table atomically is command execution. So creation
of `JOURNALS_ID` becomes idempotent in `notes-core`'s `create_node`
(crates/notes-core/src/tree/command_execution.rs:178-192), the choke point
every caller and every batch routes through; `notes_core::JOURNALS_ID` already
lives there (crates/notes-core/src/id.rs:31). `materializeParent` keeps its
page-list check purely as a fast path that skips a redundant IPC round-trip —
it is no longer load-bearing. Only the fixed system id gets this treatment: a
collision on a random `yid` is a bug that must stay loud.

**Adopt in place; do not repair.** When the node is live anywhere, the create
is satisfied by existence: no error, no move, no retitle. At least one causal
chain to the wedge is an ordinary user drag, and silently snapping the bullet
back to root would fight the user; dragging it home is an ordinary, undoable
move. What the user sees on Home, per case:

- *Live under root* — unchanged: the day nests under the Journals bullet.
- *Live under another page (or `복구됨`)* — the day nests under Journals
  wherever it sits. Today, the calendar, the feed and carry-over keep working,
  because `queries.rs::pages` selects children of `JOURNALS_ID` regardless of
  where the node itself sits. The Pages sidebar does not list Journals (not a
  root child), which it never did anyway. Export also keeps working: a day
  owns its file because its parent is the Journals id, a predicate that does
  not care where the node sits, and the Journals document itself folding into
  its new parent's file is the split-document format behaving as designed.
- *Trashed* — the create revives the row: live, under the command's parent
  (root), with the command's text (`Journals`), placed by the command's
  position. Previously trashed days under it stay trashed. A rename the user
  gave the node before trashing it is not preserved — this is a re-creation,
  and predictability beats sentiment. Undo of the revive re-trashes it (the
  inverse patch carries the old row).

**The receipt page-list rule is fixed here, and the predicate gets one home
per language.** The frontend gains one exported predicate in
`storeSupport.ts` — `parentId === ROOT_ID || parentId === JOURNALS_ID` — used
by both the receipt merge (storeState.ts:125) and `previewPages`
(apps/desktop/src/preview/previewApi.ts:610-622), which currently inlines the
same disjunction. The Rust side already has its one home,
`queries.rs::pages`. Cross-language drift is locked by tests, not shared code:
the storeState test asserting a day's receipt lands it in the page list
mirrors the existing Rust test for `pages()`. Comments on both point at each
other.

**The sync layer is out of scope.** `park` moving the fixed-id node is
harmless once creation is idempotent — the day lands under it wherever it is,
and determinism of the repair matters more than reverence for a system id.
`place_missing_parent`'s unguarded tail (merger.rs:763-770: `UPDATE ... SET
hlc = '' WHERE id = ?1 AND text = ''` and the dirty-mark delete run even when
its `ON CONFLICT DO NOTHING` insert inserted nothing, unlike its plural
sibling `place_missing_parents` which guards with `if inserted == 0`) is a
real defect — it can blank the stamp of a pre-existing empty-text node and
drop a write it is owed — but it is not this bug and is flagged as a separate
task.

## Contract

**Goal.** Writing a journal day always lands the day — wherever the Journals
node currently sits: under root, dragged into a page, parked under `복구됨`,
or trashed — and the day appears in the page list the moment its receipt
arrives.

**Acceptance.**

| # | Row | Item |
| --- | --- | --- |
| A1 | A `createNode` for `JOURNALS_ID` while the node is live anywhere (root, another page, the recovery page) raises no error, creates no second row, and moves nothing: the resulting patch is empty. | 1 |
| A2 | A `createNode` for `JOURNALS_ID` while the row is trashed revives it — live, under the command's parent, with the command's text — and leaves previously trashed children trashed. | 2 |
| A3 | Against real SQLite storage, the journal write sequence (`createNode` Journals, then `createNode` day under it) succeeds with the node parked under an ordinary page, and with the node trashed; afterwards exactly one row holds the id and `pages()` carries the day. | 3 |
| A4 | A command whose planned patch changes nothing records no history entry: undo depth unchanged, redo stack kept. | 4 |
| A5 | A journal day enters `state.pages` from its own creation receipt, so a second Today press in the same session reuses it, and a later receipt touching the day keeps it in the list. | 5 |

**Non-goals.**

- Repairing the Journals node's position when it is live somewhere other than
  root. The place is the user's; the fix is a drag.
- Any sync-layer change (see Decisions; the `place_missing_parent` tail is a
  separate task).
- Generalizing idempotent creation beyond the one fixed id.
- Migration or reach-back repair of existing databases. Pre-release rules
  apply, and none is needed: the reported database has the row trashed, so the
  first journal write after this fix revives it under root by A2.
- The `departed` rule in storeState.ts:72-95, which can hide rows from Home's
  outline when a receipt moves them into another page's visible subtree
  (carry-over run while Home is open). Pre-existing, orthogonal, noted under
  Risks.

**Boundaries.** Rust core (`notes-core` command execution), Rust application
(`notes-application` history recording), Rust SQLite (integration test only —
no query or mutation change), React (`storeState`, `storeSupport`,
`previewApi`). No IPC change: the wire command is still `createNode`. No new
Tauri command, no schema change.

**Manual proof.** In a real Tauri app on a scratch profile: (1) drag the
Journals bullet on Home under any page, press ⌘⇧J, type — no banner, the day
nests under Journals inside that page, the calendar marks today, and pressing
Today again reopens the same page rather than creating a second one. (2) Trash
the Journals bullet, open another day from the calendar, type — Journals
returns under root with the day beneath it. On the user's real profile, ⌘⇧J
alone is the proof: their row is trashed, so scenario 2 is exactly their
state.

## Items

One commit per item, test first, red output recorded verbatim.

**Item 1 — live-anywhere create is a no-op (A1).**
`crates/notes-core/src/tree/command_execution.rs::create_node`: when the id is
`JOURNALS_ID` and the tree holds the node live, return `Ok(())` before
`ensure_new_id`, touching nothing — `plan` then diffs identical trees into an
empty patch. Failing test in `crates/notes-core/tests/tree_commands.rs`: build
a tree with the Journals node under an ordinary page, plan
`CreateNode { id: JOURNALS_ID, parent_id: root, .. }`, assert `Ok` with an
empty `forward`/`inverse` and the node's parent unchanged — today this answers
`Err(DuplicateNode)`. Focused run: `cargo test -p notes-core --test
tree_commands`.

**Item 2 — trashed create revives (A2).** Same function: when the tree holds
the node deleted, replace it with `NoteNode::child(id, parent_id,
SORT_KEY_STEP, text)` and `place_child` per the command — the same fields a
fresh create would have written. Children are not touched (trashed days stay
trashed; a live child of a trashed row cannot exist). The diff yields a
forward `Upsert` whose inverse is the old trashed row, so undo re-trashes.
Failing test in `crates/notes-core/tests/tree_commands.rs`: tree with a
trashed Journals node (plus one trashed child day), plan the create, assert
the node is live under root with the command's text, the child still trashed —
today this answers `Err(DuplicateNode)`. Focused run: `cargo test -p
notes-core --test tree_commands`.

**Item 3 — the wedge end to end over real storage (A3).**
No production code: an integration test in
`crates/notes-sqlite/tests/vertical_slice.rs` locking the cross-layer path the
bug lived in (`collect_command_context` loading the colliding row, the empty
or revive patch committing, `pages()` carrying the day). Scenario one: create
Journals under root, move it under an ordinary page, then send the journal
sequence — `createNode` for `JOURNALS_ID` under root, `createNode` for a day
under `JOURNALS_ID`; assert both succeed, `pages()` lists the day and exactly
one Journals entry appears nowhere in the page list (it is not a root child),
and the day's parent is the fixed id. Scenario two: trash Journals via
`deleteSubtree`, send the same sequence, assert the node is back under root
and the day landed. Both scenarios fail today with `DuplicateNode`. Item order
matters: this test goes red before items 1–2 and green only after both.
Focused run: `cargo test -p notes-sqlite --test vertical_slice`.

**Item 4 — an empty patch records no history (A4).**
`crates/notes-application/src/service.rs::execute_checked`: skip
`record_history` when `patch.forward` and `patch.inverse` are both empty — an
entry that undoes nothing is not history, and recording it both spends a ⌘Z
press on nothing and clears the redo stack. `record_completed` and the receipt
still run. Without this, every day written while Journals sits parked leaves a
phantom undo step (item 1 makes such empty patches routine). Failing test in
`crates/notes-application/tests/session_service.rs`: no `JOURNALS_ID` needed —
plan any no-op command (`setCollapsed` to the value the node already has),
assert undo depth unchanged and a populated redo stack survives — today the
depth grows and redo clears. Focused run: `cargo test -p notes-application
--test session_service`.

**Item 5 — the receipt page-list rule (A5).** Export the page predicate from
`apps/desktop/src/store/storeSupport.ts` (`parentId === ROOT_ID || parentId
=== JOURNALS_ID`), use it in `receiptState`
(apps/desktop/src/store/storeState.ts:125) and in `previewPages`
(apps/desktop/src/preview/previewApi.ts:613) where the disjunction is
currently inlined; point the Rust twin (`queries.rs::pages`) and the
predicate at each other in comments, and retire the stale "the vault has never
had one" claim in `materializeParent`'s comment (the check is a fast path
now). Failing test in `apps/desktop/src/store/storeState.test.ts`: a receipt
whose changed node has `parentId: JOURNALS_ID, deleted: false` puts the day
into `patch.pages`, and a receipt touching a day already in `state.pages`
keeps it there — both fail today because the merge deletes non-root children
from the list. One companion row in `apps/desktop/src/journalStore.test.ts`
locks the symptom: after the day's creation receipt, `findJournalPage` finds
it, so the second Today press reuses the page. Focused run: `npm test --
src/store/storeState.test.ts src/journalStore.test.ts`.

## Gates

Boundaries touched are frontend plus Rust core/application (no new or renamed
Tauri command, so `test:architecture` is not owed). After the diff freezes,
once:

- `npm test`
- `npm run lint`
- `npm run test:bundle`
- `git diff --check`
- `cargo test --workspace --no-fail-fast` (the workspace stops at the first
  failing binary without the flag)
- `cargo fmt --all -- --check`

## Existing data

The reported database needs no hand repair: its `Sm91cm5hbHMA` row is trashed,
and the first journal write after this fix revives it under root (A2).

## Risks

1. **Item 2 changes what `CreateNode` means for one id.** The blast radius is
   bounded by the id check, but the revive path writes through `update_node`
   over a row the planning slice loaded as deleted — item 3's integration test
   exists precisely to prove that cross-layer path, not just the core plan.
2. **A no-op create still bumps the revision** (empty patch commits through
   `mutations::commit`). Harmless — receipts carry the new revision and
   nothing is marked dirty — and not worth a special case.
3. **The `departed` rule** (storeState.ts:72-95) treats "new parent is in the
   page list" as "left this page". With days in the page list, a receipt that
   moves rows between two days while Home is open hides those rows from Home's
   outline until reload. The rule is pre-existing on main -- days are in
   `state.pages` from bootstrap -- but item 5 widens who it reaches: a day
   created *this session* now enters the list from its own receipt, so a
   receipt moving rows into that day while Home is open is newly exposed. The
   ordinary carry-over is safe, because the day is the active page while
   `carryRowsInto` runs. Worth its own investigation; excluding days would
   break A5, so the rule itself is what needs the look.
4. **`place_missing_parent`'s unguarded tail** (merger.rs:763-770) can blank a
   pre-existing empty-text node's stamp. Separate defect, flagged as its own
   task, not touched here.
