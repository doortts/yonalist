# The trash keeps stating deletions that were undone

## Why this exists

`pending_documents` (`crates/notes-sync/src/export.rs:153`) is the one place
that answers "which document does this dirty row owe a write to." Every other
document kind is resolved by climbing the tree to the nearest ancestor that
owns one. The trash is different: it is not owned by any node, so it is
queued by a side condition instead —

```sql
UNION
SELECT 'yonalist-trash' FROM climb WHERE deleted = 1
```

— a dirty row currently marked `deleted = 1` puts the trash in the queue.
That is the only door. Two real transitions do not go through it:

- **`RestoreSubtree`** (`crates/notes-core/src/tree/command_execution.rs:167`)
  marks the restored node dirty with `deleted = 0`. The row that used to say
  `deleted = 1` says `deleted = 0` now, so the condition above is false, and
  `export_trash` (`export.rs:439`) does not run this pass. `.yonalist/trash.md`
  keeps its old line. It only gets corrected if some *other* node happens to
  be deleted in the same pass, because `load_trash` (`export.rs:552`) always
  rebuilds the whole file from every row currently `deleted = 1` — it never
  edits the file in place.
- **A hard delete of a node that was in the trash.** `notes_nodes_hlc_ad`
  (`crates/notes-sqlite/src/schema.sql:229`) fires on an actual
  `DELETE FROM notes_nodes` — undo taking back a create, or a cascade
  following one. It removes the deleted row's own dirty mark and marks its
  *parent* instead, and the parent is alive (`deleted = 0`). Same gap, same
  reason: nothing dirty this pass carries `deleted = 1`.

Consequence is bounded — the stale line carries an older stamp than the row
it is about, so `decide` (`crates/notes-sync/src/merger.rs:912`) makes it
lose any later merge on either side. But the vault holds a file asserting
something untrue until that happens, and a device that reads it fresh does
conflict work over nothing.

### Confirmed while reading

- `sync_documents` (`schema.sql:264`) is keyed by `root_id` only. There is no
  per-node record of which ids a document currently states; `trash.md`'s
  content is derived fresh from `notes_nodes` every time `load_trash` runs.
- `retire_missing_documents` (`export.rs:304`) excludes `'yonalist-trash'`
  explicitly, and nothing else deletes its `sync_documents` row. Once a
  deletion has ever been exported, that row exists for the life of the vault.
- `export_trash`'s empty branch (`export.rs:446`) removes the file when
  `load_trash` returns nothing, but does not touch `sync_documents`. The row's
  `exported_hash` still holds the hash of the last non-empty file it wrote —
  this is the fact that decides which fix below is safe to take.
- `export_pending` (`crates/notes-sqlite/src/sync_merge.rs:186`) computes the
  pending list once per pass, then exports each entry independently.
  `export_trash` does not read dirty marks — it rebuilds from `deleted = 1`
  rows directly — so ordering against page exports does not matter.
- Existing coverage exercises `export_trash` directly, not the queueing:
  `a_trash_that_empties_takes_its_file_with_it`
  (`crates/notes-sync/tests/export_core.rs:371`) deletes, exports, restores,
  and calls `export_trash` again *by hand* — it never asks whether
  `pending_documents` would have queued that second call on its own, which is
  exactly the question this bug turns on.

## Contract

| Field | Content |
| --- | --- |
| Goal | `.yonalist/trash.md` stops stating a deletion that has already been undone — by a restore or by a hard delete of a trashed node — as soon as the very next export pass runs, not only when some other node happens to be deleted in the same pass. |
| Acceptance | A1, A2 below. |
| Non-goals | See below. |
| Boundaries | Rust only: `crates/notes-sync/src/export.rs` (`pending_documents`, `export_trash`). No schema change — `sync_documents.exported_hash` already exists and already means "empty = nothing currently recorded" (`recorded_hash`, `export.rs:649`). No IPC, no React. |
| Manual proof | N/A. Nothing here is a runtime or UI boundary — the trash file is background sync bookkeeping, and the failure is "a background file states something false," not a rendered surface. The item's test drives the real domain commands and the real export through `SqliteStorage`, the same standard `duplicate-a-waiting-picture.md` used for a background-state bug. |

### Acceptance rows

| # | Observable pass/fail | Item |
| --- | --- | --- |
| A1 | Restoring the only node the trash currently states makes `.yonalist/trash.md` disappear on the next export pass, with no other deletion needed in that pass. | 1 |
| A2 | Hard-deleting a node that was currently stated by the trash makes the next export pass rewrite `.yonalist/trash.md` without it. | 1 |
| A3 | A `trash.md` this device did not write is never removed by the emptying branch. It is left where it is, and the pass says `needs_merge`. | 1 |
| A4 | A restore that arrives from another device — as a page whose node is live again, not as anything naming the trash — takes `.yonalist/trash.md` with it too. | 1 |

A3 and A4 were added in the review round, and the reasons are in "After review"
below.

### Non-goals

- Changing `trash.md`'s on-disk shape, its node selection, or its sort order
  (`docs/v2/sync-spec.md` §4.6) — untouched. This is a scheduling bug, not a
  format bug.
- ~~Clearing `sync_documents.file_mtime_ms` / `file_size` for
  `'yonalist-trash'` alongside `exported_hash`.~~ Withdrawn in the review
  round: a removed `trash.md` does come back — a device that has not caught up
  re-pushes it, mtime preserved (`crates/notes-sync/src/intake.rs:5`) — and a
  scan gate (`intake.rs:50`) matching the stale stat would call that arrival
  our own and never read it. Both columns are cleared with the hash.
- Reducing the per-pass cost of re-checking a *currently non-empty* trash
  below one `load_trash` scan and one hash compare. That cost is already
  priced as acceptable (see Risks) and this item does not try to shrink it
  further.
- A foreign hand edit to `trash.md` hitting `write_checked`'s `needs_merge`
  path more often than before. Ruled a no-op below, not a regression this
  item needs to prevent.

## The decision

The request's own candidate was one clause:

```sql
UNION
SELECT 'yonalist-trash' FROM climb
WHERE deleted = 1
   OR EXISTS (SELECT 1 FROM sync_documents WHERE root_id = 'yonalist-trash')
```

This does not survive the "confirmed while reading" facts above. Once a
single deletion has ever been exported, `sync_documents` keeps a
`'yonalist-trash'` row forever — nothing deletes it, and `export_trash`'s
empty branch does not clear it either. So `EXISTS (...)` becomes permanently
true the first time the vault ever sees one deletion, and stays true even
after the trash goes back to empty. From that point on, `climb` only needs
*one* dirty row of any kind — a keystroke on an unrelated page, forever —
to re-queue `'yonalist-trash'` on every single export pass for the rest of
the vault's life. That is not "dirty-gated, so an idle app still costs
nothing" (true) — it is "any non-idle pass costs one extra `load_trash` scan
forever," which is a materially bigger tax than the one-off cost this task's
own investigation priced as acceptable. The flaw is exactly the third
question the task asked me to rule on: the emptied-trash `exported_hash`
staleness is not a separable non-goal here — leaving it unfixed is what
breaks the naive version of this fix.

### Rejected: the literal one-clause `EXISTS` widening

Loses for the reason above: it trades a real bug (rare, self-correcting in
most real sessions) for a standing tax (permanent, after the first deletion
ever). Same file, same size diff either way, so there is no laziness argument
for keeping the flaw.

### Rejected: a trigger marking a `'yonalist-trash'` sentinel in `sync_dirty_nodes`

Two problems, not one. First, it needs two separate trigger touches, not
one: a restore is an `UPDATE` on `notes_nodes.deleted`, a hard-delete-in-trash
is a `DELETE`, and no single trigger sees both. Second, `pending_documents`'s
`climb` CTE starts with
`SELECT d.node_id, n.id, n.deleted FROM sync_dirty_nodes d JOIN notes_nodes n
ON n.id = d.node_id` — an inner join. A sentinel row with `node_id =
'yonalist-trash'` has no matching `notes_nodes` row, so that join silently
drops it; `pending_documents` itself would still need a second, separate
`UNION` arm just to notice the sentinel, at which point the trigger bought
nothing the query alone could not do. And nothing would ever clear that
sentinel mark — `export_trash`'s own cleanup (`export.rs:511-522`) only
deletes dirty marks for the node ids it just wrote into the file, never a
literal `'yonalist-trash'` id. It also requires a schema edit, which under
this repo's pre-release rule means a dev-DB reset, for a fix that turns out
to need just as much query-side work as the option below, plus new cleanup
machinery. Heavier on every axis, for no extra correctness.

### Rejected: queue the trash from the restore command path

`RestoreSubtree` is not the only way a node's `deleted` flag goes 1 → 0, and
hard-deleting a trashed node is not a command at all — it is a trigger side
effect of undo-of-create or a cascade. A remote device's restore arrives
through `merger.rs`'s row-write path, not through `RestoreSubtree`, and would
need its own explicit trash-queueing call too. `pending_documents` is already
the single place every other document kind answers this question through;
teaching two or three separate call sites to also queue the trash duplicates
that responsibility and is exactly one missed call site away from
reintroducing this bug for the merge-driven case. The lazy fix is the one
guard in the shared function, not a guard in every caller.

### Chosen: gate on "the trash currently claims something," and make that claim clearable

```sql
UNION
-- A restore flips `deleted` back to 0 on the node itself; a hard delete of a
-- trashed node removes the row and marks its parent instead
-- (`notes_nodes_hlc_ad`). Neither ever leaves a `deleted = 1` row in `climb`,
-- so the trash also needs queuing whenever it currently claims something at
-- all -- any dirty pass might be the one that proves that claim wrong.
SELECT 'yonalist-trash' FROM climb
WHERE deleted = 1
   OR EXISTS (SELECT 1 FROM sync_documents
              WHERE root_id = 'yonalist-trash' AND exported_hash <> '')
```

paired with clearing that same claim the moment it stops being true:

```rust
// crates/notes-sync/src/export.rs, export_trash's empty branch
if nodes.is_empty() {
    // Whatever is standing in that path has to be this app's own writing
    // before this branch may take it away. Bytes that differ, and bytes that
    // cannot be read at all, are somebody else's: leave them, answer
    // needs_merge, and keep the claim so the queue comes back.
    if path.symlink_metadata().is_ok() {
        let ours = /* read it back, compare with recorded_hash */;
        if !ours {
            return Ok(ExportOutcome { written: false, needs_merge: true, path: relative });
        }
        std::fs::remove_file(&path)
            .map_err(|error| format!("Could not clear the trash file: {error}"))?;
    }
    // Nothing is stated any more, so the claim the WHERE EXISTS clause in
    // pending_documents checks for has to go too -- otherwise the first
    // deletion this vault ever sees leaves that clause permanently true. The
    // stat goes with it, or a scan calls the file's return our own write.
    transaction
        .prepare_cached(
            "UPDATE sync_documents
                SET exported_hash = '', file_mtime_ms = NULL, file_size = NULL
              WHERE root_id = 'yonalist-trash'")
        .and_then(|mut statement| statement.execute([]))
        .map_err(|error| error.to_string())?;
    return Ok(ExportOutcome {
        written: false,
        needs_merge: false,
        path: relative,
    });
}
```

The ownership check and the stat columns arrived in the review round; the
first draft of this section had a bare `remove_file` and cleared the hash
alone. "After review" below is where that is worked through.

This is not reusing `record_document` for the clear: that helper also sets
`folder_path` and recomputes `is_page`, and would `INSERT` a fresh
`sync_documents` row for `'yonalist-trash'` the first time it is ever called
on an empty trash with no prior deletion — exactly the row this fix wants to
avoid manufacturing. A bare `UPDATE` only touches a row that already exists
and is a no-op (0 rows affected) otherwise.

Same size as the naive candidate — one widened `WHERE` and one `UPDATE` — but
it fixes the root cause without adding the permanent tax, and it folds the
emptied-trash `exported_hash` staleness in as a required part of the same
change rather than leaving it as a non-goal that quietly breaks the fix.

**On the three explicit rulings the task asked for:**

- **Emptied-trash `exported_hash` staleness is in scope**, as part of item 1,
  for the reason above — it is not separable from the widened query without
  reintroducing a worse version of this bug.
- **The `deleted = 1` branch stays.** The very first deletion a vault ever
  makes has no `sync_documents` row for `'yonalist-trash'` yet — `EXISTS`
  is false — so without this branch the first-ever deletion would never
  create `trash.md` at all.
- **A foreign hand-edited `trash.md` hitting `needs_merge` more often is a
  no-op, not a regression.** That collision (`write_checked`,
  `export.rs:120-127`) can already happen today, just only on passes an
  actual deletion triggers. After this change it can also happen on any
  dirty pass while the trash currently holds something. Neither case costs
  more than one `load_trash` scan, one render, one hash compare, and one
  file read — the same bounded cost this task's own investigation already
  priced as acceptable per debounced pass. `needs_merge` does not retry
  faster, does not lose the deleted rows' own dirty marks (those are only
  cleared when `!needs_merge`, same as today), and does not block anything
  else in the pass. The actual resolution of a foreign edit happens through
  the merge/watch path, not through `pending_documents` — this change does
  not touch that path at all.

## Item

One item. The query clause and the clearing statement are two lines in the
same function family and do not work correctly apart: shipping the widened
query without the clear reintroduces the permanent tax the naive candidate
had; shipping the clear without the widened query fixes nothing. They land
in one commit.

### Item 1 — the trash re-checks itself whenever it currently claims something (A1, A2, A3, A4)

Touches:

- `crates/notes-sync/src/export.rs` — `pending_documents`'s trash `UNION` arm
  gains the `EXISTS` clause above.
- `crates/notes-sync/src/export.rs` — `export_trash`'s `nodes.is_empty()`
  branch gains the `UPDATE sync_documents SET exported_hash = ''` statement
  above.

Tests, both red first:

**`a_restored_node_takes_the_trash_file_with_it`** —
`crates/notes-sqlite/tests/sync_merge_seam.rs`, alongside the file's other
`export_pending` round trips (e.g. `a_placeholder_row_does_not_stop_the_export`
at line 619). Seed a page with one node through `merge_document(&page(...),
&input())`, then drive the real domain commands through `SqliteStorage`
exactly like `one_document_that_cannot_be_written_does_not_stop_the_others`
does: `NotesCommand::DeleteSubtree` → `load_command_tree` → `tree.plan` →
`storage.commit(storage.revision(), &patch)` → `storage.export_pending(vault,
&store())`. Assert `.yonalist/trash.md` exists (it has to, for restoring it
to mean anything). Then the same sequence with `NotesCommand::RestoreSubtree`
on the same node, followed by another `export_pending`. Assert
`.yonalist/trash.md` no longer exists — that is the row that must go red
first: today it stays on disk after the restore's `export_pending`, because
`pending_documents` never queued `'yonalist-trash'` for that pass.

Revised during implementation. The plan was to follow with an unrelated
`NotesCommand::UpdateText` round and assert `.yonalist/trash.md` still does
not exist, as the guard proving the `exported_hash` clear landed. That
assertion cannot fail either way: removing a file that is already gone is
what an implementation missing the clear does on that pass too, so it holds
for the broken version as well. Dropped, and replaced by a guard that can be
driven red — `an_emptied_trash_stops_putting_itself_in_the_queue`
(`crates/notes-sync/tests/export_core.rs`). Delete, `export_trash`, restore,
`export_trash` again, then ask `pending_documents` and assert the trash is
*not* in the list. Against an implementation with the widened query and no
clear it reports `["4f1c8e20-a3b7-4c91-8d02-11c8da70b5e1", "yonalist-trash"]`
— the permanent tax, named. Against the baseline it passes, which is why it
is a guard on this change rather than acceptance evidence for it.

Red evidence to expect: after the restore's `export_pending`,
`.yonalist/trash.md` still exists and still names the restored node.

**`a_hard_deleted_node_still_needs_the_trash_rewritten`** —
`crates/notes-sync/tests/export_core.rs`, beside the other
`pending_documents` tests (`dirty_rows_resolve_to_the_documents_that_hold_them`,
`a_dirty_page_root_resolves_to_its_own_document`, both around line 500).
Reuse `database()` and `seed()`. Soft-delete `NODE_ID`
(`UPDATE notes_nodes SET deleted = 1 WHERE id = ?1`), call the existing
`export_trash` test helper once so the trash's `sync_documents` row exists
with a real `exported_hash`, then hard-delete the same row
(`DELETE FROM notes_nodes WHERE id = ?1`) — this fires
`notes_nodes_hlc_ad` exactly as a real undo-of-create would, clearing
`NODE_ID`'s own dirty mark and marking `PAGE_ID` (its parent) dirty instead.
Call `notes_sync::export::pending_documents` directly and assert the
returned list contains `"yonalist-trash"`.

Red evidence to expect: `pending` is `["4f1c8e20-a3b7-4c91-8d02-11c8da70b5e1"]`
(the parent page only) — no `"yonalist-trash"` entry, because every row left
dirty by the hard delete carries `deleted = 0`.

Extended in the review round to a second deleted node that stays deleted, so
the pass after the hard delete lands on the *rewrite* branch rather than the
removal branch — which is what A2 actually says, and the branch where
`write_checked`'s guards apply.

## After review

The review round found one defect and one wrong reason, and settled one
question by measurement.

**The emptying branch removed a file it had not proved was its own.**
`export_trash` removes `.yonalist/trash.md` when nothing is deleted, and that
removal never went through `write_checked` — the one place this module obeys
its own second rule (`export.rs:10`), that a file changed since this app last
wrote it is never overwritten. Before this change that branch was near
unreachable: it needed a dirty `deleted = 1` row while `load_trash` came back
empty. The widened queue makes it reachable on any dirty pass, and a newer
`trash.md` from another device, landed by the transport but not yet read by
the watcher, is exactly the file that would be sitting there. Removing it
would undo that device's deletions everywhere. The branch now hashes what is
on disk and compares it with `recorded_hash`; bytes that are not ours are left
alone and the pass answers `needs_merge`, keeping the claim so the queue comes
back. Test: `an_unread_trash_from_elsewhere_is_not_removed`
(`crates/notes-sync/tests/export_core.rs`), A3.

The second review round found the same hole one step along: a file that could
not be read *at all* — over `MAX_FILE_BYTES`, a symlink, bytes a cloud folder
has not brought down — fell through the read and had its claim cleared, so
the file stayed and nothing ever looked at it again. Unreadable is not gone.
Presence is now `symlink_metadata` — `exists` follows a link and answers no
for one pointing nowhere, which is the case that abandons a file — and only
bytes that read back as this app's own are removed. Test:
`a_trash_that_cannot_be_read_is_not_removed_either`.

One thing "left alone" does not mean for an unreadable file: the merge will
not come for it. Both `documents_on_disk` and `reindex_vault` skip symlinks,
so a link parked at that path draws a `needs_merge` on every dirty pass and
nothing ever reads it. That is the safe direction — a failed `open` and one
`load_trash` per debounced pass — and the next deletion writes over it.
Readable bytes are the ordinary case: the merge records them, and the pass
after that finds this app's own writing and clears it.

That round also found that the stat clear and the kept claim were both
invisible to mutation — dropping either left every suite green. Each now has
an assertion: the stat in `an_emptied_trash_stops_putting_itself_in_the_queue`,
the kept claim in both A3 tests.

**The stat non-goal was withdrawn** — see Non-goals above for the reason.

**A restore arriving through the merge is covered, and now says so.** The
argument for putting the fix in `pending_documents` rather than in the restore
command turns on the merge path reaching the same queue. Measured rather than
argued: a page arriving with the node live again leaves one dirty row, and the
trash file goes on the next pass. Locked by
`a_restore_from_another_device_takes_the_trash_file_too`
(`crates/notes-sqlite/tests/sync_merge_seam.rs`), A4, which fails on the
baseline with `the node is alive again everywhere, and the file says otherwise`.

## Gates (once, after the diff is frozen)

```
cargo test -p notes-sync
cargo test -p notes-sqlite
cargo fmt --all -- --check
git diff --check
```

Rust-only change, no schema DDL, no IPC payload, no frontend. `npm test`-class
gates are explicitly skipped per `delivering-yonalist-changes`'s table for a
Rust/native change that is not also an IPC or persistence *contract* change —
the SQLite content changes but the schema shape does not.

## Risks

1. **The steady-state cost while the trash is non-empty.** Every dirty pass
   now re-runs `load_trash` plus a hash compare for as long as the trash
   currently holds at least one entry, not only on passes that touch a
   deleted row. This is the same cost the task's own investigation already
   priced as acceptable for the debounced (3s idle / 30s ceiling) export
   path, and it turns off the moment the trash empties out and its
   `exported_hash` clears. Measured in the review round on a 5,300-node vault
   with 300 in the trash: 0.4 ms for the queue, 2.3 ms for the re-check.
   Nothing purges deleted rows, though, so "the moment the trash empties out"
   describes a state a real vault rarely reaches. Read it as a standing cost
   of that size.
2. **`export_trash`'s empty-branch `UPDATE` runs even when no
   `'yonalist-trash'` row exists yet** (a vault that has never seen a
   deletion). It affects zero rows and does not create one — `record_document`
   was rejected above specifically to avoid that outcome.
3. **A vault upgraded from before this fix** may already carry a
   `'yonalist-trash'` row with a stale non-empty `exported_hash` from a trash
   that emptied out under the old code. The very next pass with any dirty
   node will queue and run `export_trash` once, find the trash still empty,
   and clear the hash — a one-time extra check per existing vault, not a
   standing cost.
