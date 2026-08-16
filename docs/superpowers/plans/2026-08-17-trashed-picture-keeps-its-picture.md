# A trashed picture keeps its picture

2026-08-17 · Opus 5 xHigh design (standing in for Fable 5, over its limit) ·
fable-opus-loop phase 1 · follows `2026-08-17-orphan-image-row-stuck-node.md`

## Problem

`load_trash` (`crates/notes-sync/src/export.rs:496`) has a SELECT of its own
that never joins `notes_images`, and it hardcodes the body:
`NodeBody::Text(row.get(3)?)` (`:519`). So a trashed picture reaches
`.yonalist/trash.md` as a text line — and an empty one, since an image node's
`text` is empty: `UpdateText` refuses an image node outright
(`notes-core/src/tree/command_execution.rs:46-53`), so there is nothing in that
column to carry. The file does not even keep the picture's name.

Every other device merges that line through `write_row`
(`merger.rs:201` → `apply(.., trash = true)`), which takes the file at its word:
`kind` becomes `bullet` and — since the preceding change — the `notes_images`
row is deleted with it. Restoring there yields an empty bullet, the attachment
list counts the bytes as unreferenced, and the user can delete them. Restore
that bullet and its page file states a *text* line at a newer stamp, which the
device that still had the picture then merges: the picture is gone on both.

The page-side loader has the gate this one lacks. `build` (`export.rs:917`)
reads `Some(image) if row.kind == "image"`, which is why a page file states a
picture as a picture. The trash is the one document that does not.

## The shape of the fix

`load_trash` only. Confirmed against the four things it depends on:

| Depends on | State |
| --- | --- |
| The parser | `read_node_line` (`parse.rs:348`) reads a `![`-prefixed body as `NodeBody::Image` for trash and page alike (`:390`); the `trash` flag gates only the `from` token (`:376`). Nothing to change. |
| Where the bytes sit | `plan_placement` (`attachments.rs:131`) forces the vault-root `assets/` when any holder is trashed, and `referenced_assets` reads `deleted` per node (`:252`). A trashed picture's bytes are already reachable from `.yonalist/`. |
| The link | `Placement::link_from` (`attachments.rs:54`) turns a vault-relative location into a document-relative link; for `.yonalist` and `assets/x-<hash12>.png` that is `../assets/x-<hash12>.png`, a spelling `resolve_asset` already matches (`sync_merge.rs:282`). |
| The merge | `write_row` calls `write_image` on `NodeBody::Image` whatever `trash` is (`merger.rs:1235`). Nothing to change. |

So: add the two joins `load_document` already has (`export.rs:786-787`), select
`n.kind` and the image columns, gate on kind exactly as `build` does, and
relativise from `.yonalist`. One departure from `load_document`, below.

**The alt text comes from `i.original_name`, not `n.text`** — the column
`build` uses. The two cannot diverge in the domain: `UpdateText` refuses an
image node outright (`notes-core/src/tree/command_execution.rs:46-53`) and
`set_image` writes both (`notes-core/src/node.rs:213`).

**One helper shared with `load_document`, reading its columns by name.** The
two SELECTs share these six columns and nothing else, and a helper taking a base
index would be as brittle as the indices it replaced — a column inserted in
either query would silently shift it. By name the helper is immune to both
queries' shapes, which is what makes the sharing worth having; the location rule
differs between the two, so each caller works that out and hands the answer in.

## The four open questions

### 1. The restore round trip needs no code

`place_attachments` computes it. On restore the node's `deleted` goes to 0, so
`referenced_assets` reports `trashed: false`, `plan_placement` answers
`{page_folder}/assets/{name}`, and because `current` (the recorded
`sync_assets.location`) still says `assets/{name}` it emits the `Move`
(`attachments.rs:138-145`). `carry_bytes` reads from the old copy in the vault
before falling back to the store (`:323-341`), so a device that never had the
bytes in its own store still moves them.

The round trip is therefore an **acceptance row, not an item** — A2 below. It
has to be a row: the trash write alone is only half the contract, and the half
that is observable to a user is a picture coming back as a picture.

### 2. `readings` does not change

`readings` (`export.rs:664`) is reached only from `settle_readings` and
`record_readings`, both called only from `export_document` (`:55`, `:70`).
`export_trash` calls neither. So the trash's own export records no reading at
all, and this change gives `readings` no new input.

Its ungated `notes_images` join is no longer reachable with a mismatched pair:
the preceding change made `notes_images` row exists ⟺ `kind = 'image'` true at
every writer, so `image_state` is called exactly when the row is a picture. The
gate now lives in the invariant instead of the SQL, which is where that doc put
it.

The fingerprint and the rendered line *can* disagree, and that is deliberate:
`image_identity` (`merger.rs:1536`) collapses a link to the 12 characters of
hash in its name, so moving an attachment between `assets/` and a page folder
changes the line without changing the fingerprint. That is the whole point of
the identity — a re-placement is not an edit (`moving_the_bytes_does_not_restamp_the_note`).
The trash/restore direction is not in that blind spot: `deleted` is a
`LineState` field (`merger.rs:1647`), so the fingerprint moves with it.

One thing this leaves standing, unchanged and pre-existing: a page's export
records readings for its *deleted* children too (`readings`' subtree has no
`deleted = 0` filter, unlike `load_document`'s at `:788`) while its file omits
them. It behaves identically for a trashed text node today. Not this change's
business — Non-goals.

### 3. A picture whose bytes are not in the vault is in scope

A row whose bytes never arrived has `content_hash = ''`, no `sync_assets` row,
and `relative_path` holding *the link the source file wrote* — the schema says
so (`schema.sql:68-74`). That value is relative to another document's folder,
so `load_document`'s `COALESCE(NULLIF(a.location, ''), i.relative_path)` fallback
handed to `link_from(".yonalist")` is a category error: a waiting row that came
from a trash file holds `../assets/x.png`, and reading that as a vault path
yields `../../assets/x.png`. A link out of the vault, written into a synced
file, one `../` deeper each round.

It has to write an image line all the same. Falling back to text here is the
worst instance of the defect, not a safe one: the device that *does* hold the
bytes merges that text line and destroys a healthy picture.

**Decision.** Every answer names the vault's own store — `assets/{name}` — since
that is where `plan_placement` sends a trashed picture's bytes. Which name is
the question, and the rows fall in three:

| The row | The name |
| --- | --- |
| Placed: `sync_assets.location` says where the file is | that location, unchanged — the honest answer, and the rule the page side follows |
| Bytes, but no placement — carrying them failed (`attachments.rs:176`) | the name the placement *would* have given: `asset_disk_name(original_name, hash, mime)` |
| Still waiting, `content_hash = ''` | the tail of the link it holds — the only part of another document's link that means anything here, and what `resolve_asset` matches on (`sync_merge.rs:282`) |

The middle row is the one an earlier draft of this design missed, and it is not
a corner. Its `relative_path` is the app store's own name for the file, a bare
`<hash>.png` (`sync_merge.rs:271-277`). Writing that into the trash gives every
other device a link whose name no `resolve_asset` can ever match — it bails at
`sync_merge.rs:254` because the name has no `-` — so the picture becomes a
placeholder there with no way back. The name has to be a rule, not a lookup.

### 4. The compare settles

A trash document carrying an image line replays as `Verdict::Skip`
(`merger.rs:980`), because `content_of_file` (`:1550`) and `content_of_row`
(`:1599`) build the same string:

- `kind` — `"image"` both sides;
- `text` — `image_state` both sides, and the link collapses to the identity, so
  the trash's `../assets/x-<hash12>.png` and the row's hash agree; a waiting row
  compares its own stored link's tail against the same tail in the trash line,
  which this fix leaves untouched;
- `deleted` — `trash || from.is_some()` against `row.deleted`, both true;
- `extras` — the line carries `sync_extras` and the image's `unknown_tokens`
  stay empty, exactly as `build` does it (`export.rs:824`).

This is the same set of properties the page side already relies on, reached the
same way, so no new test earns its place — but the guard has to be a real one.
`export() == 0` is not: `settle` ends with `absorb`, which ends with an export,
so nothing is pending whatever the compare decided, and the assertion passes
with the fix reverted. The round-trip test reads the trash file again through
`watcher::consider(.., None)` and asserts the merge applied nothing.

## Contract

**Goal** — a picture thrown away on one device is still a picture on every
other one, and comes back as a picture when it is restored.

| # | Acceptance (observable) |
| --- | --- |
| A1 | `.yonalist/trash.md` states a trashed picture as an image line linking `../assets/<disk name>`. Today the line is the file's name as plain text. |
| A2 | A picture trashed on one device and restored on the other is a picture on both afterwards, bytes included. Today the restore yields an empty bullet, and merging it back destroys the picture on the device that still had it. |
| A3 | A trashed picture whose bytes are not in the vault — never arrived, or not yet placed — still states an image line, under a name another device can match to those bytes. Today there is no image line; the obvious fixes write `../../assets/…` or the app store's `<hash>.png`, neither of which any device can resolve. |

All three are carried by one production change and land as one item; each names
its own failing test.

**Non-goals**

- No change to `write_row`, `write_image`, `place_attachments`,
  `referenced_assets`, `resolve_asset` or the parser. Each is already right —
  the table above is why.
- No change to `readings`, and no reading recorded for the trash document.
  Question 2.
- No fix for a page recording readings for its deleted children. Pre-existing,
  identical for text nodes, and a different contract.
- No fix for a restore leaving its line in `trash.md`. `pending_documents`
  queues the trash from `deleted = 1` (`export.rs:179`), so restoring the last
  deleted node never rewrites the file. The stale line is harmless — it loses on
  stamp to the restored row — and it is a separate contract with a separate
  cause. Filed as a follow-up.
- No repair of databases already holding a bullet where a picture was.
  Pre-release policy (`delivering-yonalist-changes` §1): no migration. The vault
  is the truth and the vault is what was wrong; a device that still has the
  picture re-states it, and a development database can be deleted.
- No schema change. The `relative_path` comment already states the two states
  this design reads.

**Boundaries**

| Boundary | Touch |
| --- | --- |
| Rust | `crates/notes-sync/src/export.rs` — `load_trash` and its one caller's argument |
| SQLite | Two LEFT JOINs in one SELECT. No schema change, no migration |
| React / IPC / macOS | Untouched |

**Manual proof (shortest real path)**

1. With sync on, put a picture in a note on device A and let the vault settle.
   Confirm device B draws it.
2. Delete that note on A. `.yonalist/trash.md` now holds an `![…](../assets/…)`
   line, and the bytes have moved to the vault's `assets/`.
3. On B, restore it from the trash. It is a picture, not a bullet named
   `holiday.png`, and the bytes are back in the page's folder.
4. On A, the note is back and still a picture. Settings → attachments still
   lists the file as referenced.

## Items

### Item 1 — the trash states a picture as a picture (A1, A2, A3)

`load_trash` (`crates/notes-sync/src/export.rs:496`) takes the document folder
the way `load_document` does, and `export_trash` passes `folder_of(&relative)`
(`:431`, the idiom at `:56`). Its SELECT gains what `load_document` already
selects (`:782-787`), plus `n.kind`, and splits the placement from the waiting
link rather than coalescing them:

```sql
       n.kind, NULLIF(a.location, ''), i.relative_path, i.original_name,
       i.display_width, i.pixel_width, i.pixel_height, i.byte_length
FROM notes_nodes n
LEFT JOIN notes_nodes p ON p.id = n.parent_id
LEFT JOIN notes_images i ON i.node_id = n.id
LEFT JOIN sync_assets a ON a.content_hash = i.content_hash
```

and the body is chosen the way `build` chooses it (`:917`):

```rust
// Only a row that has its bytes has a placement to read. One still waiting
// holds the link some *other* document wrote — not a place in this vault, and
// read as one it would climb out of it. Its file name is the only part every
// device agrees on, and a picture in the trash belongs in the vault's own
// store: `plan_placement` sends it there for any holder that is deleted.
let location = placed.or_else(|| {
    waiting.map(|link| format!("assets/{}", link.rsplit('/').next().unwrap_or_default()))
});
body: match location {
    Some(location) if kind == "image" => NodeBody::Image(ImageReference {
        path: Placement { location, moves: Vec::new() }.link_from(document_folder),
        original_name: ...,
        ...
    }),
    _ => NodeBody::Text(row.get(3)?),
},
```

**Failing test (A1)** — `crates/notes-sync/tests/attachment_export.rs`, beside
`a_deleted_note_still_counts_as_a_reference` (`:405`), which already seeds a
trashed image node and places its bytes:
`a_trashed_picture_is_stated_as_a_picture`. Same fixture — `page`,
`image_node(.., deleted = true)`, `place` — then export the trash through a
local helper mirroring `export_core.rs:287`, and assert the file contains
``![holiday.png](../assets/holiday-9f2c1b7a4e6d.png)``.

Red: the assertion fails; the line is `-  <!-- yid: … -->` — no `![` in the
file, and no name either.

Selector: `cargo test -p notes-sync a_trashed_picture_is_stated_as_a_picture`

**Failing test (A3)** — same file, beside it:
`a_trashed_picture_waiting_for_its_bytes_links_inside_the_vault`. The fixture a
device that only ever saw a trash file holds: `image_node(.., deleted = true)`,
then `UPDATE notes_images SET content_hash = '',
relative_path = '../assets/holiday-9f2c1b7a4e6d.png'`, and no `place` — with no
hash there is nothing to place (`bytes_that_have_not_arrived_yet_are_not_invented`,
`:437`). Export the trash and assert the line is
``![holiday.png](../assets/holiday-9f2c1b7a4e6d.png)``, and that the file does
not contain `../../`.

Red: no `![` line, same as A1. The second assertion is what separates this from
the obvious fix, which writes `../../assets/holiday-9f2c1b7a4e6d.png`.

Selector: `cargo test -p notes-sync a_trashed_picture_waiting_for_its_bytes`

**Failing test (A3, the middle row of question 3)** — same file:
`a_trashed_picture_with_bytes_but_no_placement_states_the_name_it_will_get`. The
plain `image_node(.., deleted = true)` fixture with no `place`, so the row holds
its hash and the app store's own `<hash>.png`. Assert the link is
`../assets/holiday-9f2c1b7a4e6d.png` and that the hash does not appear in the
file at all.

Red against the tail-of-link rule alone: the line links
`../assets/<64 hex>.png`, a name no device's `resolve_asset` can match.

Selector: `cargo test -p notes-sync a_trashed_picture_with_bytes_but_no_placement`

**Failing test (A2)** — `crates/notes-sqlite/tests/two_devices.rs`, beside
`a_page_arriving_before_its_picture_still_reads` (`:896`):
`a_trashed_picture_comes_back_as_a_picture`. Uses the file's own helpers
throughout — `seeded_pair`, `add_bullet`, `picture` (`:847`), `settle`,
`page_of` (`:878`):

1. `picture(&one, &shot)` on a bullet under `one.first_page()`; `settle`.
2. `one.run(DeleteSubtree { shot })`; `settle` — `two` now holds the deletion
   as `trash.md` stated it.
3. `two.run(RestoreSubtree { shot })`; `settle(&two, &one)`.
4. Assert `page_of` on **both** devices reads the node with `image.is_some()`
   and `original_name == "holiday.png"`, and that the bytes are back beside the
   page — the row alone would say the first part whatever happened to the file,
   since its path is derived from the hash.

Between 2 and 3, question 4's guard: read the trash file again through
`watcher::consider(.., None)` and assert the merge applied nothing. Not
`export() == 0`, which passes with the fix reverted — `settle` ends with an
export, so nothing is ever pending by then.

The restore has to happen on `two`, the device that only ever saw the trash
file. Restoring on `one` proves nothing: `one` never lost its row, and its page
file re-states the picture at a newer stamp, which heals `two` whatever the
trash said.

Red: step 4 fails on `two` — `expect("the picture is still there")` on a node
whose `image` is `None`, because `two` restored a bullet. `one` fails the same
way, since `two`'s page export then states that bullet at the newer stamp.

Selector: `cargo test -p notes-sqlite a_trashed_picture_comes_back_as_a_picture`

## Gates (after the diff freezes)

Rust and persistence only, no frontend boundary:
`cargo test -p notes-sync -p notes-sqlite`, `cargo fmt --check` for the touched
crate, `git diff --check`, plus the manual proof above. Frontend gates are
skipped: no React, IPC payload, or native configuration changes.
