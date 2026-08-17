# A row the trash holds is still named in the redraw list

## Why this exists

`announce` (`apps/desktop/src-tauri/src/lib.rs:899`) answers two different
questions out of the same set:

```rust
outcome.changed_ids.iter().chain(outcome.deleted_ids.iter())   // :905 -- out_of_reach
changed_node_ids: outcome.changed_ids.iter().chain(outcome.settled_ids.iter())  // :913
```

The first list is the merge barrier's — "another device's change landed on this
row, so a history entry that touches it cannot be replayed"
(`crates/notes-application/src/service.rs:448`). The second is the window's —
"redraw this row". The window's copy is also read as an existence claim:
`listenForVaultChanges` prunes an id from `deleted` when a later event in the
same 500 ms run names it as changed (`apps/desktop/src/syncChanged.ts:86`), so
a row restored on another device keeps the caret's in-flight typing. That prune
infers liveness from `changedNodeIds`, and two producer sites name a row the
local database holds as `deleted = 1`:

1. `crates/notes-sqlite/src/sync_merge.rs:266-287` — `resolve_asset`'s
   `UPDATE notes_images … WHERE content_hash = '' … RETURNING node_id` never
   consults `notes_nodes.deleted`, so a trashed image row whose bytes arrive
   later settles and lands in `settled_ids` (`apps/desktop/src-tauri/src/vault_watch.rs:243`).
2. `crates/notes-sync/src/merger.rs:363` — a place adoption inserts into
   `outcome.changed_ids` outside the trash branch (the `deleted_ids` insert is
   at `:398`, under `Verdict::Write` + `trash`), so a row the database holds as
   deleted is named changed with no matching deletion.

The reachable sequence, as reported: another device trashes a row whose image
bytes land a moment later. `trash.md` merges first (`changed={X}, deleted={X}`
→ the coalescer keeps `deleted={X}`, `syncChanged.ts:93`), then the bytes
settle and emit `settled_ids={X}` → `changed=[X], deleted=[]`. The prune wins,
`absorbVaultChange` (`apps/desktop/src/notesStore.ts:183`) sees no deleted ids,
drops no draft, and the pending `updateText`/`updateNote` for X goes out for a
row the database holds as deleted.

This is the follow-up written up as the accepted residual of
`docs/superpowers/plans/2026-08-17-stale-draft-on-vault-reload.md` (consumer
side shipped in `411f760c` and `0fdd52aa`). It fixes the producer, where row
state is in hand.

## Confirmed while reading

- **`changed_ids` has two consumers, not one.** `lib.rs:905` puts it in
  `out_of_reach`, which goes to `service.absorb_external` (`lib.rs:720`) and
  raises `undo_floor` / clears `redo` for every entry touching one of those ids
  (`service.rs:448-468`). `lib.rs:913` puts it in the payload. So a
  producer-side *deletion* from `changed_ids` narrows the undo barrier as well
  as the redraw list — which is what decides ruling 4. `deleted_ids` feeds both
  the same way (`:907`, `:918`). `settled_ids` feeds only the payload (`:915`);
  keeping it out of `out_of_reach` is deliberate and already locked by
  `an_arriving_picture_puts_no_history_out_of_reach` (`lib.rs:932`).
- **Every production read of the three sets.** `changed_ids`: `lib.rs:905`,
  `:913`. `deleted_ids`: `lib.rs:907`, `:918`. `settled_ids`: `lib.rs:915`.
  Nothing else in the workspace reads any of them; the remaining hits are the
  producers (`merger.rs:363`, `:396`, `:398`, `:546`, `vault_watch.rs:243`) and
  tests (`vault_watch.rs:736`, `:744`, `lib.rs:940-942`).
- **`notes_application`'s `deleted_ids` is a different field.**
  `storage.rs:10`, `contracts.rs:422`, `service.rs:505`, `mutations.rs:115` —
  that is the command receipt's list of rows a patch removed, not the merge's.
  Neither item touches it.
- **Every `changed_ids.insert`, ruled in or out.** `:363` (the place adoption —
  site 2, defective), `:396` (the `Verdict::Write` arm — correct, see the next
  point), `:546` (`park`) — correct, because both finders that feed `park`
  select only live rows (`:446` `WHERE n.deleted = 0 …`, `:473`
  `WHERE deleted = 0 AND parent_id IS NOT NULL`). There is no
  `settled_ids.insert` anywhere: the only producer is `vault_watch.rs:243`,
  built straight from `resolve_asset`'s answer. `deleted_ids.insert` exists once
  (`:398`).
- **The Write arm's liveness is exactly `!trash`.** `write_row` writes
  `let deleted = trash;` (`merger.rs:1159`), so after `:396` the row is live
  when the file was a page and deleted when it was the trash — and `:398`
  names it in `deleted_ids` in exactly that second case. A page file that wins
  over a trashed row is a restore and *should* be named as changed.
- **In the non-Write branch `row` is always `Some`.** Every `row: None` path in
  `decide` returns `Verdict::Write` (`merger.rs:929-945`), so the `is_none_or`
  at `:360` is defence, not a reachable case. The predicate can read the row.
- **The place branch's work is independent of its announcement.**
  `order.claim` runs before the branch (`:335`) and `order.flush` respaces the
  parent's siblings afterwards (`:421`) whatever the branch decides;
  `write_place` (`:1280`) only records `sync_prev`/`sync_prev_hlc`, which is the
  very guard at `:360` that stops the same adoption from being re-decided on
  every merge of that file. Skipping either would leave the ordering column
  disagreeing with the claim for ever.
- **`resolve_asset` reaches a trashed row from both directions.** A `trash.md`
  merge upserts the image row with `content_hash` read out of `sync_assets`
  (`merger.rs:1471-1484` — empty until the bytes land) and a `relative_path`
  that still ends in the same disk name, which is what the WHERE matches
  (`sync_merge.rs:282-284`). A local `DeleteSubtree` leaves the image row
  untouched — probed: `DeleteSubtree` on a row still waiting for its bytes
  plans and commits, and the row keeps `content_hash = ''`.
- **The revision bump is paired with the announcement today.** `resolve_asset`
  bumps iff its answer is non-empty (`sync_merge.rs:311`), `vault_watch` calls
  `changed` iff the answer is non-empty (`vault_watch.rs:240`), and `changed`
  is what runs `absorb_external` (`lib.rs:720`) — the only thing that moves
  `session.revision` (`service.rs:449-450`). A bump the session never absorbs
  makes the next user command fail at `mutations.rs:26` with
  `RevisionConflict`. So filtering the answer has to move the bump onto the
  filtered set.
- **An empty announcement is not free on the consumer side.** `named === 0`
  takes the re-read path (`notesStore.ts:205`), the one that does not promise
  the caret stays where it was. That is why ruling 4 moves site 2's id rather
  than dropping it.
- **`announce` has no database handle.** Its signature is
  `(&MergeOutcome, u64)` (`lib.rs:899-902`). The closure around it does hold
  one (`lib.rs:695` `let storage = Arc::clone(&self.storage);`, used at `:711`
  for `storage.revision()`), so a filter *there* is possible — ruled out for
  other reasons in ruling 1.
- **Baseline, `cargo test --workspace`: all green.** notes-application 49 + 3 +
  8 + 9 + 6; notes-core 1 + 6 + 46 + 4 + 5; notes-export 6 + 3 + 4 + 4;
  notes-sqlite 26 + 6 + 1 + 3 + 3 + 8 + 3 + 1 + 4 + 2 + 0 + 2 + 1 + 2 + 8 +
  **39 (`sync_merge_seam`)** + 17 + 3 + 28 + 11 + 14 + 2; notes-sync 18 + 15 +
  10 + 25 + 6 + 6 + 3 + **53 (`merge_ingest`)** + 45 + 8 + 7 + 8 + 7;
  desktop lib 51. Zero warnings on a fresh recompile of `merger.rs`,
  `sync_merge.rs` and `lib.rs`; `cargo fmt --all --check` clean.
- **The Rust gate command the skill names does not exist here.** Root
  `src-tauri` is *excluded* from the workspace (`Cargo.toml:9`) and is v1; the
  v2 crates are the members (`Cargo.toml:2-8`), and `npm run test:v2` uses
  `cargo test --workspace` (`package.json:29`). That is the command this change
  is gated on.

## Contract

| Field | Content |
| --- | --- |
| Goal | A row the local database holds as `deleted = 1` is never named in the payload's redraw list, so the consumer's liveness prune (`syncChanged.ts:86`) can only be triggered by a row that is actually there. |
| Acceptance | A1, A2, A3 below. |
| Non-goals | See below. |
| Boundaries | Rust only, two crates: `crates/notes-sqlite/src/sync_merge.rs` (`resolve_asset`) and `crates/notes-sync/src/merger.rs` (`apply`'s place branch). No IPC payload *shape* change — `SyncChanged` keeps its three fields, so nothing under `packages/contracts/generated` moves; only which ids go in which field. No SQLite schema change. No frontend change. No filesystem or macOS change. |
| Manual proof | N/A as a gate. Neither observable is a rendered surface: one is a `BTreeSet` a library function answers with, the other a field of an event payload naming a row that is already off screen, and seeing either by hand means reading `notes://sync-changed` in the Web Inspector. Both are observed directly at their own seam by the item tests, over the real database and the real merge. A single-machine path exists if a runtime look is wanted, and it needs no second device — the vault is a folder, so a hand edit is another device as far as the watcher is concerned. Site 2: copy a page's `README.md` aside, trash one of its rows in the app, copy the stale file back with two of the remaining lines swapped; the event that follows must not name the trashed row in `changedNodeIds`. Site 1: write a page file whose line points at `assets/holiday-<first 12 hex of a hash>.png` before those bytes exist, trash that row in the app, then drop the file in; the event must not name it either. Offered, not required. |

### Acceptance rows

| # | Observable pass/fail | Item | Test |
| --- | --- | --- | --- |
| A1 | An attachment arriving for a note the trash holds names nothing — the answer is empty — while the picture row still learns which picture it is, and the revision does not move. | 1 | `an_arriving_attachment_leaves_a_row_the_trash_holds_unnamed` |
| A2 | One picture waited on by a live row and a trashed row names only the live row, and the revision moves. | 1 | `an_arriving_attachment_names_the_live_row_and_not_its_trashed_twin` |
| A3 | A place claim adopted on a row the database holds as deleted is named in `deleted_ids` and not in `changed_ids`, the claim is still recorded on the row, and a live sibling adopting a claim in the same merge is still named in `changed_ids`. | 2 | `a_place_claim_on_a_row_the_trash_holds_is_not_named_as_changed` |

All three fail against today's code; the verbatim red output is under each item.

### Non-goals

- **Changing what the undo barrier reaches.** Both items leave
  `out_of_reach` (`lib.rs:905-907`) byte-identical for every input: item 1
  touches `settled_ids`, which was never in it, and item 2 moves an id between
  two sets that are both in it. Whether a stale remote file should be able to
  block the user's undo of their own deletion is a real question and not this
  one.
- **`announce` growing a database handle, or `MergeOutcome` growing a fourth
  set.** Rejected below.
- **The live siblings `order.flush` respaces without naming.** `:421` rewrites
  every sibling key under a parent something moved in, and only the moved row
  is announced — so a window patching by name keeps stale absolute keys for the
  siblings. Real, observed, older than this change, and about ordering rather
  than existence.
- **Rows nothing ever names.** `place_missing_parents` inserts a `deleted = 1`
  placeholder (`merger.rs:681`) and `recovery_page` inserts a page
  (`:587`), neither of which reaches any outcome set. Under-reporting, not the
  over-reporting this contract is about.
- **Any schema or persisted-format change.** Schema v1 is fixed until release.
  Both items are read-side predicates over columns that already exist.
- **Frontend changes.** The consumer is already correct once the producer stops
  lying to it; that half shipped in `411f760c` and `0fdd52aa`.

## The rulings

### 1. Where each fix goes: the producer, both times — but a different half of it per site

**Site 1 — in `resolve_asset`, on the *answer*, not on the UPDATE.** The
UPDATE is a durable fact about the row: this picture row now knows which
picture it is. That is true whether or not anything can see the row, and
leaving it out has costs the fix does not need to pay (ruled out under
"Rejected alternatives"). The *answer* is the announcement, and that is what
gets filtered. `settled_ids` has exactly one consumer — the payload's redraw
list (`lib.rs:915`) — so nothing else changes meaning.

**Site 2 — in `apply`'s place branch, by redirecting the insert rather than
dropping it.** `changed_ids` has two consumers, so dropping is not a neutral
act; see ruling 4.

**`announce` is not ruled out by the missing handle, but by ownership and
timing.** Its signature carries no connection (`lib.rs:899`), yet the closure
that calls it does (`lib.rs:695`, `:711`), so a filter there could ask. It
still loses: the ask would run on the watcher thread *after* the merge
transaction committed, one worker round trip per id, answering a question the
merge already had in hand inside its own transaction — and the answer could
have moved by then. It would also have to filter `settled_ids` and
`changed_ids` while leaving `out_of_reach` alone, which means `announce` would
stop being the pure function its tests treat it as (`lib.rs:932`). The row
state belongs to whoever is looking at the row.

### 2. Site 2's predicate is the local row's `deleted` column

Load-bearing: `Row.deleted` (`merger.rs:92`), the row as the database holds it
*after* this merge. Not the incoming file's `trash` flag. In the non-Write
branch no content write happened, so the row's `deleted` is unchanged by this
merge and the column is the post-merge truth.

| Incoming file | Local row | Verdict | Should announce | Why |
| --- | --- | --- | --- | --- |
| page (`trash = false`) | `deleted = 1` | not `Write` (the deletion stands) | deleted, not changed | The row is not on a page. Named as changed it reads as a row that came back. |
| trash (`trash = true`) | `deleted = 0` | not `Write` (a newer local edit kept it alive) | changed | The row is there and its position moved; the window has a line to redraw. |
| page | `deleted = 0` | not `Write` | changed | Today's behaviour, unchanged. |
| either | either | `Write` | `:396`/`:398`, untouched | `let deleted = trash` (`:1159`) already makes those two lists match the post-write state. |

So the file's `trash` flag is exactly the wrong predicate: it would silence
every page-file reorder (the common case) and announce trash-file claims that
landed on rows still alive.

**`write_place` still runs, and `applied += 1` stays.** `order.claim` has
already been made unconditionally at `:335`, so `order.flush` (`:421`) rewrites
that parent's sibling keys whether or not this branch does anything — the rows
really did change, `sync_merge.rs:35-45` keys `rebuild_all` and the revision
bump off `applied`, and the revision has to move or `absorb_external` never
hears about a write that happened. Skipping `write_place` would leave
`sync_prev`/`sync_prev_hlc` disagreeing with the keys that were just written,
so the guard at `:360` would re-decide the same adoption on every later merge
of that file, each time marking the file for write-back. And a deleted row's
recorded place is not dead weight: restoring is "clear the flag" and nothing
else (`restoring_from_trash_puts_the_node_back_where_it_was`,
`crates/notes-sync/tests/merge_ingest.rs:1095`), so the place it comes back to
is the one this branch recorded.

### 3. No third site

| Insert | Verdict | Why |
| --- | --- | --- |
| `merger.rs:363` | **defective** | Site 2. The row can be `deleted = 1`. |
| `merger.rs:396` | correct | Reached only under `Verdict::Write`, after `write_row` set `deleted = trash` (`:1159`). Live when the file was a page, and when it was the trash `:398` names it in `deleted_ids` too. |
| `merger.rs:398` | correct | The only `deleted_ids` producer today, and its row is deleted by definition. |
| `merger.rs:546` (`park`) | correct | Both finders that reach `park` select live rows only (`:446`, `:473`), so a parked row is never deleted. `repair_structure` needs no change. |
| `vault_watch.rs:243` | correct once item 1 lands | It copies `resolve_asset`'s answer verbatim; filtering at the source fixes it without touching this line. |
| no `settled_ids.insert` | — | The set has no other producer. |

### 4. Site 2's id has to reach `deleted_ids` — dropping it is not enough

Two reasons, and the second is the decisive one.

**The barrier.** `out_of_reach` is `changed_ids ∪ deleted_ids`
(`lib.rs:905-907`). A place adoption *is* another device's claim landing on the
row, and replaying a history entry that touches it — the local user's undo of
their own deletion, restoring the row at the parent and key the snapshot
recorded — would put it back somewhere else than the vault now says, with
nothing said. Whether that barrier should be that wide is a separate question
(non-goal); what this change must not do is answer it silently. Moving the id
between two sets that are both in `out_of_reach` keeps the barrier identical
for every input, so the item's blast radius is exactly the payload.

**An empty announcement costs a page re-read.** `announce` runs whenever
`outcome.applied > 0` (`lib.rs:712`), and `applied` has to stay (ruling 2). A
merge whose only work was a place adoption on a trashed row would then emit
`SyncChanged { changed: [], deleted: [] }`; the consumer computes
`named === 0` and takes the re-read path (`notesStore.ts:205`) — the expensive
one that does not promise the caret stays. Naming the row as deleted keeps the
event answerable by name: `changedNodeIds.length === 0` short-circuits
`queryForest` (`notesStore.ts:207-209`) and `applyReceipt` prunes an id that is
already gone, which is a no-op.

Nothing else asserts "row exists" for that id, so those two are the whole
argument. Note that this is not a new claim in the payload either: today a
trashed row already arrives in both lists at once (`:396` + `:398`) and
`syncChanged.ts:88-93` is written so that gone wins inside one event.

The field's meaning widens from "this merge deleted it" to "this merge touched
it and the database holds it as deleted". Both consumers want the second
reading, and the item pays for it with a doc comment on
`MergeOutcome.deleted_ids` (`merger.rs:46`), which has none today.

### 5. Test placement and shape

Both suites are the ones that already own these seams, and both name tests as
English snake_case sentences under a `///` doc comment saying what breaks if
the test is wrong — no Korean test names in either file.

- **A1, A2 → `crates/notes-sqlite/tests/sync_merge_seam.rs`**, which owns
  `resolve_asset` (eight call sites) and already has every helper: `storage()`
  (`:28`), `page_with_image(disk_name)` (`:71`), `input()` (`:98`), `run()`
  (`:607`) for a real planned-and-committed command, `image_path()` (`:1479`)
  and `storage.image_hash()`. A2 reuses the twin construction from
  `every_row_waiting_for_the_same_picture_is_named` (`:828`). Placed
  immediately after `an_arriving_attachment_resolves_the_rows_waiting_for_it`
  (`:739`) so the trash case sits beside the live case.
- **A3 → `crates/notes-sync/tests/merge_ingest.rs`**, which owns `apply`'s
  place decisions: `database()` (`:20`), `page()` (`:71`), `node()` (`:54`),
  `trash()` (`:994`), `trash_input()` (`:1001`), `deleted_flag()` (`:1007`),
  the explicit `place` claim idiom (`:2255`, `:2305`), and one transaction
  reused across several `merge_document` calls
  (`a_reorder_touches_only_the_moved_sibling`, `:589`). Placed after the trash
  block that ends at `merging_the_same_trash_twice_changes_nothing`
  (`:1179`).

All three lock the contract rather than the implementation: each asserts what
the outcome *names*, plus that the work the branch exists to do still happened
(the hash is learnt, the claim is recorded), so an implementation that bought
the empty announcement by skipping the write fails them.

## Rejected alternatives

**Add `AND notes_nodes.deleted = 0` to `resolve_asset`'s UPDATE.** The task's
first suggestion, and a one-line diff, but it leaves the trashed row with
`content_hash = ''` for ever: the arrival also records the bytes in
`sync_assets` unconditionally (`sync_merge.rs:296-306`), `asset_known` then
gates the file out of every later sweep (`vault_watch.rs:368`), and nothing
re-offers it. A row restored *locally* after that draws a placeholder over a
picture the store already holds, because the restore upserts the image row from
its own snapshot. And it hides the reference: the attachment list counts references by
`content_hash` across `notes_images`
(`crates/notes-sqlite/src/attachment_list.rs:18-24`) and its second branch
lists bytes whose hash appears in no image row as an orphan the user is offered
to delete (`:25-35`) — which is what a trashed row still holding `''` would
make of the only picture pointing at those bytes. Keeping the UPDATE unconditional makes
the row self-heal on any later merge that writes it, because `write_row` reads
the hash back out of `sync_assets` (`merger.rs:1471-1484`).

**Insert into *both* `changed_ids` and `deleted_ids` at site 2.** Three lines,
no barrier change, and functionally quiet today, because `syncChanged.ts:88-93`
makes the deleted loop win inside one event. It loses because the contract
being restored is a property of the *payload* — "the redraw list never names a
row the database holds as deleted" — and this leaves the payload saying exactly
that, relying on the consumer's per-event ordering to cancel it. A test could
only assert the cancellation, not the contract.

**Drop site 2's insert entirely.** Smallest diff. It narrows the undo barrier
as a side effect and turns an adoption-only merge into an empty announcement
that costs a full page re-read (ruling 4).

**A fourth `MergeOutcome` set — "barrier only, no redraw".** The honest
modelling of two claims, and unnecessary: `deleted_ids` already means both
things for the trash case, and `announce` already routes it to both consumers.
A new field would be a new name for a set with one producer and one member.

**Filter in `announce`, or in `vault_watch`'s `take_asset`.** Ruling 1: the
row state is known inside the merge transaction and stale everywhere after it,
and `take_asset` would have to ask the worker once per id from the watcher
thread.

## Chosen

Two independent producer-side diffs, one per item.

**Site 1 — `crates/notes-sqlite/src/sync_merge.rs`**, between the
`sync_assets` upsert and the bump (`:307`), with `BTreeSet` already imported at
`:16`:

```rust
    // The rows a window can act on. A note the trash holds is on no page to
    // redraw, and named there it reads as a note that came back -- so the
    // window keeps the caret's typing and sends it to a row this database
    // holds as deleted. Its picture row still learnt which picture it is
    // above: restored later, it draws the picture rather than a placeholder.
    let mut live = BTreeSet::new();
    {
        let mut statement = transaction
            .prepare_cached("SELECT 1 FROM notes_nodes WHERE id = ?1 AND deleted = 0")
            .map_err(internal)?;
        for node_id in resolved {
            if statement.exists([&node_id]).map_err(internal)? {
                live.insert(node_id);
            }
        }
    }
    // Rows changed, so the revision moves — the same rule the merge follows.
    // Nothing in the outline moved, but a note that was drawing a placeholder
    // is drawing a picture now, and the window learns that no other way.
    if !live.is_empty() {
        bump_revision(&transaction)?;
    }
    transaction.commit().map_err(internal)?;
    Ok(live)
```

Points the implementer must not lose:

- The block around the statement is load-bearing: `transaction.commit()` takes
  the transaction by value, so the cached statement has to be dropped first.
- The bump moves onto `live`, not `resolved` — a bump the session never absorbs
  makes the next command fail at `mutations.rs:26` (ruling 1's pairing).
- One statement per settled row is affordable: the set is one row, or two when
  the same picture sits on two notes.
- `resolve_asset`'s doc comment (`:243-249`) gains a sentence saying the answer
  is the rows a window can draw, so the next reader does not "fix" the missing
  trashed ids.

**Site 2 — `crates/notes-sync/src/merger.rs:358-364`**:

```rust
            write_place(transaction, &entry.id, prev, claim_stamp)?;
            // A place adoption rewrites sibling keys, so the caller has rows to
            // rebuild and a revision to move: reporting nothing would leave the
            // ordering column stale and every open session none the wiser.
            outcome.applied += 1;
            // Which list, though, is what the database holds it as. A row in
            // the trash has no line to redraw, and naming it as changed is
            // what has the window read it as a row that came back.
            if row.is_some_and(|row| row.deleted) {
                outcome.deleted_ids.insert(entry.id.clone());
            } else {
                outcome.changed_ids.insert(entry.id.clone());
            }
```

Plus a doc comment on `MergeOutcome.deleted_ids` (`:46`), which has none:
rows the database holds as deleted after this merge, whether this merge is what
deleted them or merely landed a claim on one.

Both shapes were compiled and run against the item tests while writing this
doc, then reverted; the results are the red and green evidence below.

## Items

One item per site. They touch different crates and different test files, so
either can be reverted alone.

### Item 1 — `resolve_asset` answers with the rows a window can draw (A1, A2)

Touches:

- `crates/notes-sqlite/src/sync_merge.rs` — the filter above, the bump moved
  onto it, and one sentence in the function's doc comment.
- `crates/notes-sqlite/tests/sync_merge_seam.rs` — two new tests after
  `an_arriving_attachment_resolves_the_rows_waiting_for_it` (`:739`).

The hash and location both suites already use:
`9f2c1b7a4e6d8c0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081` and
`Projects-4f1c8e20a3b7/assets/holiday-9f2c1b7a4e6d.png`, matching
`page_with_image("holiday-9f2c1b7a4e6d.png")`.

**A1 — `an_arriving_attachment_leaves_a_row_the_trash_holds_unnamed`.** Merge
the page whose one line is a picture, trash that line the way the app does
(`run(&storage, NotesCommand::DeleteSubtree { … })` — probed: a row still
waiting for its bytes plans and commits), read the revision, then resolve.
Three assertions, one per half of the contract:

```rust
    assert!(resolved.is_empty(), "a row the trash holds has no line to redraw");
    assert_eq!(
        image_path(&directory, IMAGE_NODE_ID),
        format!("{HASH}.png"),
        "the row still learns which picture it is"
    );
    assert_eq!(
        storage.revision().expect("revision"),
        before,
        "nothing a window can see changed"
    );
```

Red today (line number depends on where the test lands):

```
---- an_arriving_attachment_leaves_a_row_the_trash_holds_unnamed stdout ----
This database was made by an older build; making it again. Development does not migrate — the notes are in the vault.

thread 'an_arriving_attachment_leaves_a_row_the_trash_holds_unnamed' (36534273) panicked at crates/notes-sqlite/tests/sync_merge_seam.rs:1546:5:
a row the trash holds has no line to redraw
```

(The first line is this suite's ordinary startup notice on a fresh temporary
database, not part of the failure.)

**A2 — `an_arriving_attachment_names_the_live_row_and_not_its_trashed_twin`.**
The twin construction from `every_row_waiting_for_the_same_picture_is_named`
(`:828`) — the same picture on two lines — then trash only `IMAGE_NODE_ID`:

```rust
    assert_eq!(
        resolved,
        std::collections::BTreeSet::from([TWIN_NODE_ID.to_owned()]),
        "the note still on the page is named and the one in the trash is not"
    );
    assert!(
        storage.revision().expect("revision") > before,
        "a row a window can see changed, so the revision has to move"
    );
```

This row exists so that "return nothing whenever any waiting row is trashed"
does not pass: the filter is per row, and a live row settling still moves the
revision. Red today:

```
---- an_arriving_attachment_names_the_live_row_and_not_its_trashed_twin stdout ----
thread 'an_arriving_attachment_names_the_live_row_and_not_its_trashed_twin' (36534274) panicked at crates/notes-sqlite/tests/sync_merge_seam.rs:1588:5:
assertion `left == right` failed: the note still on the page is named and the one in the trash is not
  left: {"8a201f33-0000-4c91-8d02-00000000000e", "8a201f33-0000-4c91-8d02-00000000000f"}
 right: {"8a201f33-0000-4c91-8d02-00000000000e"}
```

(`…000f` is `IMAGE_NODE_ID`, `…000e` the twin; the ids are printed in full by
the assertion.)

Green: `cargo test -p notes-sqlite --test sync_merge_seam` → 41 passed, and the
whole `-p notes-sqlite` suite stayed green with the prescribed filter in place,
including `resolving_an_attachment_normalizes_the_row_and_bumps_the_revision`
(`:1431`) and `an_attachment_no_row_wanted_leaves_the_revision_alone`
(`:1460`).

### Item 2 — a place claim on a trashed row is announced as deleted (A3)

Touches:

- `crates/notes-sync/src/merger.rs` — the branch above, plus the
  `deleted_ids` doc comment.
- `crates/notes-sync/tests/merge_ingest.rs` — one new test after
  `merging_the_same_trash_twice_changes_nothing` (`:1179`).

**A3 — `a_place_claim_on_a_row_the_trash_holds_is_not_named_as_changed`.** The
reported sequence, built from the file idioms this suite already uses:

1. Seed one page with two siblings at `stamp(5, "a3f2")` — `NODE_ID` first,
   then a second id — so both rows carry a recorded claim.
2. Another device trashes the first: `trash(vec![gone], &stamp(20, "a3f2"))`
   with `gone.from = Some((PAGE_ID.to_owned(), 4_294_967_296))`. The row is now
   `deleted = 1` with a stamp no page file in this test can beat.
3. An older page file states a new order for both rows — an explicit
   `place` claim at `stamp(9, "a3f2")` on each, node stamps left at
   `stamp(5, …)`, and `reordered.root.hlc = base` so the page's own title row
   Skips and stays out of the assertion (the idiom at `:622`). The trashed row
   takes `Verdict::LocalWins` (its row stamp is newer) and the live row
   `Verdict::Skip` (same stamp, same content); both claims are adopted, so both
   go through the branch under test.

```rust
    assert_eq!(
        outcome.changed_ids,
        std::collections::BTreeSet::from([live.to_owned()]),
        "the row still on the page is redrawn; the one in the trash is not there to redraw"
    );
    assert_eq!(
        outcome.deleted_ids,
        std::collections::BTreeSet::from([NODE_ID.to_owned()]),
        "and what the database holds it as is what the window is told"
    );
    assert_eq!(deleted_flag(&transaction, NODE_ID), 1, "still in the trash");
    let claimed: String = transaction
        .query_row(
            "SELECT sync_prev FROM notes_nodes WHERE id = ?1",
            [NODE_ID],
            |row| row.get(0),
        )
        .expect("claim");
    assert_eq!(
        claimed, live,
        "the claim is recorded either way — the ordering column is not the announcement"
    );
```

One test, both directions, because the live sibling in the same outcome is what
stops the wrong predicate (the file's `trash` flag, or "any adoption is
silent") from passing. Red today:

```
---- a_place_claim_on_a_row_the_trash_holds_is_not_named_as_changed stdout ----
thread 'a_place_claim_on_a_row_the_trash_holds_is_not_named_as_changed' (36542897) panicked at crates/notes-sync/tests/merge_ingest.rs:2626:5:
assertion `left == right` failed: the row still on the page is redrawn; the one in the trash is not there to redraw
  left: {"8a201f33-0000-4c91-8d02-000000000001", "8a201f33-0000-4c91-8d02-000000000002"}
 right: {"8a201f33-0000-4c91-8d02-000000000002"}
```

If step 3's `root.hlc` is left at `stamp(9, …)` the left-hand set also holds
`PAGE_ID` — the page title row genuinely changed then, and the test would be
asserting something else.

Green: `cargo test -p notes-sync` → `merge_ingest` 54 passed and every other
suite in the crate unchanged; `cargo test --workspace` reported no failures
with the prescribed branch in place.

## Gates (once, after the diff freezes)

Rust-only change, so the gate table's Rust row applies — with the workspace
command, not the manifest path the skill names (see "Confirmed while reading"):

```
cargo test -p notes-sqlite --test sync_merge_seam    # item 1, in the loop
cargo test -p notes-sync --test merge_ingest         # item 2, in the loop
cargo test --workspace
cargo fmt --all --check
npm run test:v2:contracts
git diff --check
```

`npm run test:v2:contracts` because the payload's *field* meanings move even
though its shape does not; it proves nothing under
`packages/contracts/generated` drifted. The remaining frontend gates
(`test:v2:frontend`, `lint:v2`, `v2:build`) are explicitly skipped: no file
under `apps/desktop/src` changes, and the consumer this fix serves already
shipped with its own tests. Clippy is not run: no new construct that the
touched boundary's baseline would have anything to say about, and there is no
recorded Clippy baseline to compare against.

Baseline to carry into the report: `cargo test --workspace` all green at the
counts listed above (`sync_merge_seam` 39, `merge_ingest` 53), zero compiler
warnings, `cargo fmt --all --check` clean.

## Risks

1. **The self-heal that keeps the trashed row's picture depends on the UPDATE
   staying unconditional.** Anyone later "tidying" the filter into the WHERE
   clause reintroduces the permanent placeholder described under Rejected
   alternatives. A1's second assertion (`image_path` equals `<hash>.png`) is
   what fails if they do.
2. **A trashed-only settle now writes a row without moving the revision.**
   Deliberate — the bump has to stay paired with the announcement or the next
   user command is rejected (`mutations.rs:26`) — and safe because nothing a
   session can read renders a deleted row's picture, while a later restore
   reads the row fresh. It does mean `resolve_asset` no longer holds the
   invariant "a write moved the revision"; the doc comment says why.
3. **A trashed-only settle no longer pokes the exporter** (`vault_watch.rs:240`
   gates `changed`, whose first act is `exporting.poke()`, `lib.rs:708`).
   `resolve_asset` marks nothing dirty, so the poked export would have written
   nothing.
4. **`deleted_ids` now means slightly more than it did.** "Rows this merge
   touched that the database holds as deleted", not "rows this merge deleted".
   Both consumers want the wider reading, and it is the reading the trash case
   already produced; the doc comment and A3 are the guard.
5. **A place adoption on a trashed row now cancels any draft on that id**, via
   `deleted_node_ids` → `absorbVaultChange` (`notesStore.ts:190-197`). That is
   the direction this pair of changes exists to enforce, and a row in the trash
   is off screen on this device, so a live draft on it means the user was
   typing into a row that had already gone.
6. **The composition of the two items is not covered end to end.** Each is
   tested at its own seam and `announce` itself is locked by `lib.rs:932`; the
   two-device-plus-late-attachment path stays a manual, optional check. What
   the change guarantees is that neither producer can put a `deleted = 1` row
   into `changed_node_ids`, which is the assumption `syncChanged.ts:86` needs.
