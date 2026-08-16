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

- `parse_node` (`crates/notes-sqlite/src/row_mapping.rs:34-61`) builds the image
  from the row regardless of kind. Which gate then refuses the node depends on
  the row's shape, and `validate_image_ownership` is not any of them:
  - The shape a merge actually writes fails inside `parse_node` itself.
    `NoteImage::try_new` demands `relative_path == "{content_hash}.{extension}"`
    (`crates/notes-core/src/image.rs:48`) while `write_image` stores the
    document's link (`assets/….png`), so the read is a
    `FromSqlConversionFailure` — a separate pre-existing defect, fixed on
    `fix/image-relative-path-normalization`, not here.
  - Given a row in the app's own spelling, `parse_node` succeeds and the node
    reads back as `Bullet` + `Some(image)`. `NotesTree::validate` then refuses
    it at load: the `(Bullet, Some(parent_id))` arm requires
    `node.image().is_none()` (`crates/notes-core/src/tree.rs:388`), so the node
    falls through to `ParentNotFound(parent_id)`
    (`crates/notes-core/src/tree.rs:405`) — an error naming the *page*, not the
    node. That is the stuck node, and it is stuck one gate earlier than
    `validate_image_ownership` ever runs.

  `collect_command_context` hydrates siblings as well as ancestors
  (`crates/notes-sqlite/src/repository.rs:431-458`), so one orphan row also
  refuses commands on *neighbouring* lines — creating a bullet at the end of the
  same parent, say — not only on the node that owns it.
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

**Also rejected: a trigger on `notes_nodes`.** The schema states half the
invariant already, so stating the other half there —
`AFTER UPDATE OF kind ... WHEN NEW.kind <> 'image'`, four lines — is the obvious
third option, and it would retire the writer census above that every future
writer of `kind` re-opens. It loses on one specific ground: `write_row` already
has to fight the triggers on this table. It writes the merged stamp in a
separate statement precisely to slip past the update trigger
(`crates/notes-sync/src/merger.rs:1245-1252`), so every trigger added here is
another rule the merge has to reason around, invisible at the call site. A
second implicit deleter of `notes_images` — beside the FK cascade — also makes
the ownership of those rows harder to state than the census is to keep. The
explicit DELETE says what it does where it happens.

## Contract

**Goal** — a merge that writes a non-image line over a picture leaves a plain
bullet the user can edit, trash and restore, and leaves no image row behind.

| # | Acceptance (observable) |
| --- | --- |
| A1 | After a merge writes a text line over an image node, `notes_images` holds no row for that node. Today the row survives (`merger.rs:1232` has no else). |
| A2 | That node still takes app commands: an edit and a trash both commit. Today the edit does not even load: `load_command_tree` fails with `ParentNotFound(<page id>)`, the domain's way of refusing a bullet that owns image metadata. |

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
  path). It makes the flip common but is not what strands the node. Worth its
  own change; not this one — but it is the **top follow-up**, because item 1
  changes how it fails on the receiving device, and not only for the better:

  | On the device that only saw the trash file | Before | After |
  | --- | --- | --- |
  | Restoring the trashed picture | refused at load (`tree.rs:405`) | succeeds, as a plain bullet titled with the file name |
  | Deleting its bytes from the attachment list | refused — the orphan row still counted (`attachment_list.rs:170`) | allowed, and the vault file goes (`attachment_list.rs:198`) |

  So this path failed closed before and fails open now. The blast radius is
  bounded — the device that trashed the picture keeps its own row and its store
  copy, and re-places the bytes on restore there — and the cause is the export
  defect, not this item: the merge is correctly following the file's word, and
  the file wrongly says "text". Fixing `load_trash` closes it at the source.
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
`an_image_node_keeps_its_metadata_and_settles`:
`a_line_that_stops_being_a_picture_takes_its_image_row_with_it`. Merge an image
file, then merge
`page(vec![node(NODE_ID, &stamp(9, DEVICE), "just words")], &stamp(9, DEVICE))`
through the same `input()` — a newer stamp, so the file wins outright at
`merger.rs:964` with no conflict logged. Assert `kind` is `bullet` (proving the
flip is what the test exercises) and
`SELECT count(*) FROM notes_images WHERE node_id = ?1` is 0. The image line is
built by a local `picture(id, hlc)` helper both image tests share, rather than
the same ten-line literal twice.

Red: the count assertion fails with `left: 1 / right: 0`.

Selector: `cargo test -p notes-sync a_line_that_stops_being_a_picture`

**Failing test (A2)** — `crates/notes-sqlite/tests/sync_merge_seam.rs`, beside
`an_arriving_attachment_resolves_the_rows_waiting_for_it`:
`a_picture_a_file_turned_back_into_text_is_not_stranded`. Merge
`page_with_image("holiday-9f2c1b7a4e6d.png")` (`:70`), let the bytes arrive
through `resolve_asset`, then merge a page whose one line is
`node(IMAGE_NODE_ID, &stamp(9), "just words")` at `stamp(9)`. Assert the kind
flipped to `Bullet` first — without that precondition the test would pass on a
merge that never flipped anything, because an image node takes both commands
too. Then run them through the real seam the file's other tests use
(`load_command_tree` → `plan` → `commit`): `UpdateText` on `IMAGE_NODE_ID`, then
`DeleteSubtree` on it. Both must return `Ok`.

Two departures from what this doc first specified, both forced:

- The row needs the app's own `relative_path` spelling, written directly, or
  `parse_node` fails on the merge-written link before any gate is reached — the
  separate `image.rs:48` defect named in the root cause. The test says so in a
  comment; only `relative_path` is written by hand, the hash arrives the
  ordinary way through `resolve_asset`.
- The page is built by destructuring `page(...)` and replacing `nodes`, the
  idiom already at `a_text_edit_leaves_the_place_claim_where_it_was`, rather
  than by giving `page()` an id parameter — which would have touched about
  fifteen call sites for one test.

Red: `load_command_tree` fails before any commit —
`load: Domain(ParentNotFound(NodeId("4f1c8e20-a3b7-4c91-8d02-11c8da70b5e1")))`.

Selector: `cargo test -p notes-sqlite a_picture_a_file_turned_back_into_text`

No test for the blob gates: both are literally
`content_hash NOT IN (SELECT content_hash FROM notes_images)`, so the row being
gone is the whole of it.

## Gates (after the diff freezes)

Rust and persistence only, no frontend boundary:
`cargo test -p notes-sync -p notes-sqlite`, `cargo fmt --check` for the touched
crate, `git diff --check`, plus the manual proof above. Frontend gates are
skipped: no React, IPC payload, or native configuration changes.
