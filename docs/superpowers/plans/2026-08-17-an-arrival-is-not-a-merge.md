# A picture's bytes turning up is not another device's edit

## Why this exists

The merge barrier takes a history entry out of reach once another device's edit
lands on a node the entry touches. Replaying the entry then would discard what
the merge brought in, silently, so the app refuses instead.

`fix/resolve-asset-changed-ids` made an arriving attachment name the rows it
settled, for a good reason: the window redraws those lines rather than re-reading
the page, which would move the caret out from under the user. But those ids go
into `MergeOutcome::changed_ids`, and `lib.rs` feeds `changed_ids` to
`absorb_external` — the same door another device's edit comes through.

An arrival is not an edit. `resolve_asset` only fills in the hash a row was
already waiting for, and the disk name's own hash prefix guards even that. There
is nothing to discard and nothing to put out of reach. The barrier goes up
anyway, and the user loses an undo or a redo because a download finished:

- Star a picture whose bytes have not landed. The bytes land. The star can no
  longer be undone.
- Duplicate one, undo, let the bytes land. The redo is gone. (This closed row 4
  of `2026-08-17-duplicate-a-waiting-picture.md`, which is where the over-block
  was first written down.)

## Contract

| Field | Content |
| --- | --- |
| Goal | A picture's bytes arriving leaves this session's undo and redo exactly where they were, while the window still learns which lines to redraw. |
| Acceptance | A1 below. |
| Non-goals | What `absorb_external` does with the ids it is given — unchanged. The barrier's behaviour for a real document merge — unchanged. The `notes://sync-changed` payload shape — unchanged, so no TS contract moves. |
| Boundaries | `notes-sync` (`MergeOutcome`), desktop Tauri (`vault_watch.rs`, `lib.rs`). No schema change, no IPC payload change. |
| Manual proof | N/A — the seam is the announcement itself, and both halves of it are unit-testable where they are made. |

### Acceptance row

| Row | Statement |
| --- | --- |
| A1 | When an attachment arrives, the window is told which rows settled, and nothing about the session's history changes. |

## The decision

`changed_ids` is doing two jobs at once: naming what the window must redraw, and
naming what the barrier must put out of reach. For a document merge those are
the same set. For an arrival they are not, and nothing in the type says so.

So the outcome says which it is. `MergeOutcome` gains `settled_ids` beside
`changed_ids`, and the arrival fills that one instead:

| Field | Filled by | Window redraws | Barrier counts |
| --- | --- | --- | --- |
| `changed_ids` | a document merge | yes | yes |
| `deleted_ids` | a document merge | yes | yes |
| `settled_ids` | an arriving attachment | yes | **no** |

No new service method and no flag. The distinction lives in the field name,
where a reader meets it before they can get it wrong — which is how this bug got
in.

### Rejected: a second entry point on `NotesService`

An `absorb_arrival(revision)` beside `absorb_external(revision, affected)` would
work, but it puts the decision at the far end of the wire, one call site away
from the outcome that knows the answer. The caller would still have to ask which
kind of outcome it is holding, and nothing in the outcome would answer.

### Rejected: leave it and let the caller filter

`lib.rs` could drop the ids when `outcome` looks like an attachment. There is
nothing to look at: an arrival and a merge produce the same shape today. That is
the defect, not the workaround.

## Items

### Item 1 — an arrival settles rows rather than changing them (A1)

Touches:

- `crates/notes-sync/src/merger.rs` — `MergeOutcome` gains `settled_ids`.
- `apps/desktop/src-tauri/src/vault_watch.rs` — the attachment branch of the
  sweep fills `settled_ids`, not `changed_ids`.
- `apps/desktop/src-tauri/src/lib.rs` — the window's redraw list is
  `changed_ids` + `settled_ids`; what goes to `absorb_external` stays
  `changed_ids` + `deleted_ids`, which now excludes an arrival by construction.

Tests, both red first:

- `apps/desktop/src-tauri/src/vault_watch.rs::an_arriving_picture_wakes_the_window`
  — the existing test, tightened: the settled node is named in `settled_ids`,
  and `changed_ids` is empty. Red says the ids are still in `changed_ids`.
- `apps/desktop/src-tauri/src/lib.rs::an_arriving_picture_puts_no_history_out_of_reach`
  — the split itself: an outcome that only settled rows hands the barrier
  nothing, while one that changed rows hands it those. Red says the settled row
  reaches the barrier.

### Item 2 — the earlier design doc says the opposite (no code)

`docs/superpowers/plans/2026-08-17-duplicate-a-waiting-picture.md` records the
over-block under "Known limits" and marks row 4 closed. Both are now wrong.
The comment in
`crates/notes-sqlite/tests/two_devices.rs::bytes_that_land_before_the_redo_still_reach_the_copy`
says the same thing and becomes true instead of aspirational: `absorb_external`
with nobody named is what production does for an arrival now.

No test: nothing here is code.
