# An orphaned image row strands the node it belongs to

2026-08-17 · Opus 5 xHigh design (standing in for Fable 5, over its limit) ·
fable-opus-loop phase 1

## Problem

When a merge writes a plain text line over a node that was a picture, the row's
`kind` becomes `bullet` and its `notes_images` row stays behind. Nothing can
happen to that node afterwards: every app command that upserts it is refused by
`validate_image_ownership` (`crates/notes-sqlite/src/mutations.rs:103`), and
`DeleteSubtree` is an upsert too (`set_subtree_deleted`,
`crates/notes-core/src/tree/command_execution.rs:153`), so the node cannot even
be thrown away. The bytes it used to point at are pinned in the vault for good.

## Root cause

The invariant is `notes_images` row exists ⟺ `notes_nodes.kind = 'image'`. The
schema states half of it (`kind` CHECK at `crates/notes-sqlite/src/schema.sql:12`,
the FK cascade at `:80`) and leaves the other half to whoever writes `kind`.

**Every production writer of `notes_nodes.kind`:**

| Writer | Keeps the invariant? |
| --- | --- |
| `insert_node` / `update_node` (`mutations.rs:187`, `:211`) | Yes — `commit` calls `sync_image` right after (`mutations.rs:53`), and `sync_image` deletes the row when the node has no image (`mutations.rs:119-127`). |
| `write_row` (`crates/notes-sync/src/merger.rs:1192`, `kind = excluded.kind`) | **No.** `merger.rs:1232` writes the image row on `NodeBody::Image` and has no else branch. |
| Three placeholder inserts (`merger.rs:581`, `:621`, `:675`) | Yes, vacuously — all `ON CONFLICT(id) DO NOTHING`, so no existing row's `kind` moves. |
| Root adoption, page → bullet (`crates/notes-sqlite/src/schema.rs:68`) | Yes, vacuously — a page can never hold an image row: `sync_image` is blocked for `Page` by `validate_image_ownership`, and `write_image` is only reached from the arm that writes `kind = 'image'`. |

`seed.rs`, `fixtures.rs`, `queries.rs:444` and the `#[cfg(test)]` inserts in
`schema.rs` only create fresh rows.

**Every writer of `notes_images`:** `sync_image` (`mutations.rs:115`, the only
DELETE), `write_image` (`merger.rs:1461`, insert/update only), `resolve_asset`
(`crates/notes-sqlite/src/sync_merge.rs:252`, fills `content_hash` on rows that
already exist), and the FK cascade on a hard node delete. So no merge-side
delete exists anywhere.

`write_row` is therefore the single production site that can produce the broken
state, and it is the root cause.

**Two ways in, not one.** The hand edit in the report is the obvious one. The
common one is the trash: `load_trash` states every deleted node as
`NodeBody::Text` (`crates/notes-sync/src/export.rs:515`, no kind gate), so a
trashed picture reaches `trash.md` as a text line, and the *other* device merges
it through the same `write_row` (`merger.rs:201` → `apply(.., trash = true)`).
Trashing a picture on device A strands it on device B. See Non-goals for why
that export defect is not fixed here.

**What the orphan row misleads.** Four readers gate on nothing:

- `parse_node` (`crates/notes-sqlite/src/row_mapping.rs:34-61`) attaches the
  image regardless of kind, so the node reads back as `Bullet` + `Some(image)`
  and `validate_image_ownership` refuses every command — the stuck node.
- `content_of_row` (`merger.rs:1569-1583`) builds the compare string from
  `row.image` regardless of kind, so the row can never again compare equal to
  the text line the file holds. The node re-decides on every merge of that file.
- `attachments.rs:216` and `attachment_list.rs:35` both gate reachability on
  `content_hash NOT IN (SELECT content_hash FROM notes_images)`. The orphan keeps
  `unreferenced_at` NULL for ever, so `place_attachments` keeps carrying the
  bytes into the vault (`attachments.rs:163-207`) and `delete_attachment` refuses
  to remove them (`attachment_list.rs:168-177`) — the user is shown an
  attachment on a bullet that draws no picture, and cannot delete it.

The export render is the one reader that already gates
(`export.rs:912`, `Some(image) if row.kind == "image"`), which is why the
flipped node exports as text and the vault agrees with itself. Its sibling
`readings` (`export.rs:671-699`) does not gate, so the fingerprint describes a
picture the exported line does not contain — stable, self-consistent, and
therefore not a live defect.

## The layer decision

**Chosen: (A) merge-side.** `write_row` gets the else branch `sync_image`
already has: the file's word about the line decides `kind`, and the picture row
is part of that word.

**Rejected: (B) a kind gate in `parse_node`.** It is a fix at one of four
readers of a state that one writer creates. It unsticks the node — and the next
successful command's `sync_image` would incidentally clear the row — but only
once the user happens to edit that node. Until then the row still pins the blob,
still shows a phantom attachment the user cannot delete, and still makes the
merge compare mis-read. Fixing the reader leaves the writer free to break the
invariant again for the other three.

**Not both.** With (A) in place no writer can produce `kind ≠ 'image'` beside an
image row, so the three remaining ungated readers have no input to mis-read. A
gate in `parse_node` or `content_of_row` would guard a state nothing can create.

## Contract

**Goal** — a merge that writes a non-image line over a picture leaves a plain
bullet the user can edit, trash and restore, and leaves no image row behind.

| # | Acceptance (observable) |
| --- | --- |
| A1 | After a merge writes a text line over an image node, `notes_images` holds no row for that node. Today the row survives (`merger.rs:1232` has no else). |
| A2 | That node still takes app commands: an edit and a trash both commit. Today both fail with `non-image node <id> cannot own image metadata`. |

Both rows are carried by one production change and are listed as one item; each
names its own failing test.

**Non-goals**

- No kind gate in `parse_node` — the rejected alternative above.
- No kind gate in `content_of_row` (`merger.rs:1569`). It is a live defect only
  because the broken state is live; item 1 removes its only producer.
- No fix for `load_trash` writing a picture as a text line
  (`export.rs:492-515`). It is a lossy-export defect with its own contract ("a
  trashed picture keeps its picture") and its own questions (how `.yonalist/`
  links resolve, what the compare then does with the two spellings of the same
  path). It makes the flip common but is not what strands the node, and item 1
  neither helps nor hurts it: on either side of this change, a restore from the
  device that still holds the picture repairs the receiving row through the
  ordinary page merge, because the page document does state the image. Worth its
  own change; not this one.
- No repair of databases already holding an orphan. Pre-release policy
  (`delivering-yonalist-changes` §1): the schema is fixed and development data
  is reset, not migrated. Nothing to migrate here anyway — the schema does not
  change, and the vault is the truth: delete the development database (or
  Settings → delete all Yonalist data) and the reindex writes the node back as
  the text line its file states.
- No change to `sync_image`, `validate_image_ownership`, the attachment list, or
  either blob gate. They are already the honest half.

**Boundaries**

| Boundary | Touch |
| --- | --- |
| Rust | `crates/notes-sync/src/merger.rs` — `write_row` only |
| SQLite | One DELETE on `notes_images` inside the merge transaction. No schema change, no migration |
| React / IPC / macOS | Untouched |

**Manual proof (shortest real path)**

1. With sync on, put a picture in a note and let the vault settle.
2. In an external editor, replace that `![...]` line in the page's `README.md`
   with plain text, keeping the line's id comment.
3. Back in the app: the line is a bullet. Typing in it sticks (today the edit
   does not take), and it can be trashed and restored.
4. Settings → attachments: the picture is listed as unreferenced and can be
   deleted (today it is listed as referenced by that bullet and the delete is
   refused).

## Items

### Item 1 — the merge drops the image row when it writes a non-image kind (A1, A2)

In `write_row` (`crates/notes-sync/src/merger.rs:1232`), give the image write
the else branch `sync_image` already has (`mutations.rs:119-127`):

```rust
if let NodeBody::Image(image) = &entry.node.body {
    write_image(transaction, &entry.id, image)?;
} else {
    // The kind written above is the file's word about this line. A picture
    // row outliving it is a row nothing can reach: the node reads back as a
    // bullet that owns image metadata, which every command refuses.
    transaction
        .prepare_cached("DELETE FROM notes_images WHERE node_id = ?1")
        .and_then(|mut statement| statement.execute([&entry.id]))
        .map_err(|error| error.to_string())?;
}
```

The `else` covers `NodeBody::Split` as well, which is right: `merger.rs:1127`
writes `kind = "bullet"` for a split line whatever the row held, so the picture
row has to go with it.

**Failing test (A1)** — `crates/notes-sync/tests/merge_ingest.rs`, beside
`an_image_node_keeps_its_metadata_and_settles:710`:
`a_line_that_stops_being_a_picture_takes_its_image_row_with_it`. Build the image
file exactly as lines 713-723 and merge it, then merge
`page(vec![node(NODE_ID, &stamp(9, DEVICE), "just words")], &stamp(9, DEVICE))`
through the same `input()` — a newer stamp, so the file wins outright at
`merger.rs:964` with no conflict logged. Assert `kind` is `bullet` (proving the
flip is what the test exercises) and
`SELECT count(*) FROM notes_images WHERE node_id = ?1` is 0.

Red today: the count assertion fails with `1`.

Selector: `cargo test -p notes-sync a_line_that_stops_being_a_picture`

**Failing test (A2)** — `crates/notes-sqlite/tests/sync_merge_seam.rs`, beside
`an_arriving_attachment_resolves_the_rows_waiting_for_it`:
`a_picture_a_file_turned_back_into_text_is_not_stranded`. Merge
`page_with_image("holiday-9f2c1b7a4e6d.png")` (`:70`), then merge a page whose
one line is `node(IMAGE_NODE_ID, &stamp(9), "just words")` at `stamp(9)` — give
the existing `page()` helper (`:52`) an id parameter rather than copying it.
Then run two commands through the real seam the file's other tests use
(`load_command_tree` → `plan` → `commit`): `UpdateText` on `IMAGE_NODE_ID`, then
`DeleteSubtree` on it. Both must return `Ok`.

Red today: the first `commit` returns
`Err(StorageError::Domain(Invariant("non-image node 8a201f33-0000-4c91-8d02-00000000000f cannot own image metadata")))`,
so the test panics on that message.

Selector: `cargo test -p notes-sqlite a_picture_a_file_turned_back_into_text`

No test for the blob gates: both are literally
`content_hash NOT IN (SELECT content_hash FROM notes_images)`, so the row being
gone is the whole of it.

## Gates (after the diff freezes)

Rust and persistence only, no frontend boundary:
`cargo test -p notes-sync -p notes-sqlite`, `cargo fmt --check` for the touched
crate, `git diff --check`, plus the manual proof above. Frontend gates are
skipped: no React, IPC payload, or native configuration changes.
