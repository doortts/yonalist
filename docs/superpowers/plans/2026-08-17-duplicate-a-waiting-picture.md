# Duplicating a picture that is still waiting for its bytes

## Why this exists

`duplicate_node` copies a node with `image: None` while keeping `kind: Image`.
For a picture whose bytes have not landed yet that is every picture in that
state, because a waiting row deliberately reads back as a node without a
picture (`row_mapping.rs`, and the test
`a_row_still_waiting_for_its_bytes_reads_without_a_picture` that pins it).

The copy therefore lands with no `notes_images` row at all:

- `sync_image` (`crates/notes-sqlite/src/mutations.rs`) sees `image: None` on an
  image-kind node and deliberately leaves the row alone — but there is no row
  to leave alone, and it creates none.
- `resolve_asset` (`crates/notes-sqlite/src/sync_merge.rs`) matches waiting rows
  by `content_hash = '' AND relative_path LIKE …`. The copy has no row, so the
  arriving bytes can never reach it.
- `build` (`crates/notes-sync/src/export.rs`) renders `NodeBody::Text` for an
  image-kind row with no picture, so the export writes the copy out as a
  bullet and the next merge round trip makes that permanent.

The original is unharmed. The copy is dead the moment it is made.

This gesture was not reachable before `fix/image-relative-path-normalization`:
a page holding a picture whose bytes had not arrived could not be read at all,
so nobody could duplicate anything on it. That branch makes such pages
readable, which is what exposes this.

## Contract

| Field | Content |
| --- | --- |
| Goal | Duplicating a picture that is still waiting for its bytes gives the copy a picture too, once the bytes land. |
| Acceptance | A1, A2 below. |
| Non-goals | Clipboard copy/paste of a waiting picture (a paste already lands as a text bullet by a different route). Changing what a waiting row reads as — `image: None` stays. Refusing any gesture. Schema shape. |
| Boundaries | Rust domain (`notes-core`), application (`notes-application` history), SQLite (`notes-sqlite`). No IPC payload change: the frontend mirrors `NoteView` receipts, never `TreeMutation`. No schema change. |
| Manual proof | N/A — the user-visible boundary here is "the bytes arrive and the picture appears", which the two-device test drives end to end with the real merge, export and `resolve_asset`. No new desktop surface. |

### Acceptance rows

| Row | Statement |
| --- | --- |
| A1 | A duplicate of a waiting picture — the picture itself, or one sitting under a duplicated bullet — carries the wait with it, so when the bytes arrive both the original and the copy show the picture. |
| A2 | Redoing such a duplicate puts the copy's picture record back, so the redone copy meets the bytes too. |

## The decision

### Rejected: refuse the duplicate the way `ReplaceImage` refuses

`ReplaceImage` refuses because there is nothing coherent to do: replacing a
picture that is not there is not a gesture with a meaning. Duplicating one is.
Worse, the refusal cannot be kept local — `duplicate_node` copies the whole
visible subtree, so a waiting picture nested three levels down would refuse the
duplication of the entire section around it. A user who duplicates a chapter
gets a flat error because one screenshot in it has not finished downloading.
That trades a dead copy for a blocked page.

### Rejected: let the domain carry a "waiting" picture

If `parse_node` returned `Some(image)` for a waiting row, `duplicate_node`
would clone it, `sync_image` would write it, and redo would replay it — no new
plumbing anywhere. But `NoteImage`'s invariant is a real 64-hex hash, and every
consumer trusts it: asset reads, `live_image_hashes`, the paste validation in
`execute_with_assets`, the viewport's picture rendering. Inverting that
invariant would also invert the contract this branch just designed and pinned
in two tests. The blast radius is the whole image surface, for a duplication
bug.

### Chosen: the copy is told which picture record to take, and storage takes it

`duplicate_node` already builds `copied_ids: BTreeMap<source, copy>` for the
whole subtree and throws it away. The pairs whose source is an image-kind node
with no picture are exactly the ones that need help. They travel out of `plan`
on the patch, and `commit` copies the row.

Storage copies from the **source's current row**, not from a snapshot. That is
what makes the redo case fall out correctly rather than needing its own rule:

| Sequence | Result |
| --- | --- |
| duplicate, then bytes arrive | Copy holds a waiting row with the same link, so `resolve_asset`'s `UPDATE … WHERE content_hash = '' AND relative_path …` settles both rows at once. |
| duplicate, undo | The copy's node is deleted; `notes_images` has `ON DELETE CASCADE`, so its row goes with it. |
| duplicate, undo, redo, bytes arrive | Redo re-inserts the copy and re-copies the row, still waiting. Same as the first case. |
| duplicate, undo, bytes arrive, redo | Storage does the right thing — the source's row is resolved by then, so the copy is given a resolved row. The redo never gets that far today: the watcher announces an arriving picture the same way it announces a merge, so the barrier refuses it. See "Known limits". |
| duplicate, undo, another device edits the source, redo | Refused, and so is undoing back past that entry. Reading the source's current row makes the source a thing the entry depends on, and the merge barrier has to count it — see below. |

#### The source is a dependency the mutations do not name

`entry_touches` decides what a merge puts out of reach by scanning an entry's
mutations. A duplication leaves the source exactly as it found it, so the
source appears in neither list — and yet the redo reads its row. Without
counting it, a merge that rewrites the source's image line leaves the redo
reachable, and replaying it hands the copy a picture the user never duplicated,
with nothing on screen saying so. So the barrier counts the carried pair too.

#### Why the patch, and not the command or a second call

`commit` only ever sees a `DomainPatch` — `execute_checked` consumes the
command into `tree.plan`. And `undo`/`redo` rebuild a `DomainPatch` purely from
the stored mutation lists and re-`commit` it, so anything redo needs has to
survive in what the history entry keeps. A mapping threaded through the command,
or applied by a second storage call after `commit`, would work once and then
leave every redo dead — and would not be in the same transaction.

#### Why not a new `TreeMutation` variant

Fewer call sites to touch, but it would put an instruction in the tree's own
mutation vocabulary that the tree cannot perform: `NotesTree::apply` would need
a silent no-op arm. A picture record is not tree state — that is the whole
reason this bug exists. It belongs beside the mutations, not among them.

## Items

One item per acceptance row, one commit each.

### Item 1 — the copy is given the source's picture record (A1)

Touches:

- `crates/notes-core/src/command.rs` — `DomainPatch` gains
  `carried_pictures: Vec<(NodeId, NodeId)>`, source first then copy.
- `crates/notes-core/src/tree.rs` — `plan` collects the pairs and puts them on
  the patch; `execute` and `duplicate_node` take `&mut Vec<(NodeId, NodeId)>`
  and record a pair whenever the source is `kind == Image` with no picture, for
  the root copy and for every copied descendant.
- `crates/notes-core/src/tree/command_execution.rs` — `execute`'s signature and
  the `Batch`, `DuplicateNode`, `DuplicateNodes` arms thread the vector through.
- `crates/notes-sqlite/src/mutations.rs` — `commit` copies each named row after
  the forward loop, so the copy's own node row already exists for the foreign
  key.
- Existing `DomainPatch { forward, inverse }` literals across tests name the new
  field. An exhaustive literal is what makes the next field added a decision at
  each of those sites rather than a silent default.

Tests, both in `crates/notes-sqlite/tests/two_devices.rs`, both red first:

- `duplicating_a_waiting_picture_lets_the_copy_meet_its_bytes` — hold the png
  back, duplicate the picture, let the bytes arrive, assert the copy's node
  reads with an image.
- `a_waiting_picture_under_a_duplicated_bullet_meets_its_bytes_too` — same, but
  duplicating the bullet the picture hangs under, proving the subtree walk
  records the pair too.
- `a_duplicated_waiting_picture_survives_the_trip_through_the_folder` — the
  third failure mode, the one no undo reaches: export the copy while it is
  still waiting, carry the folder to the other device, and assert it arrives as
  a picture rather than as its own file name. Driven through `DuplicateNodes`,
  the other command the row menu sends.

Red evidence to expect: the copy's node has `image: None` after the bytes
arrive — or, if read through `stored_waiting_image`, the row is missing
outright.

### Item 2 — redo puts the copy's picture record back (A2)

Touches:

- `crates/notes-application/src/service.rs` — `NotesServiceHistoryEntry` gains
  `carried_pictures`, filled from the patch in `execute_checked`, extended on
  coalescing in `record_history`, replayed by `redo` and deliberately **not**
  by `undo` (undo deletes the copy; handing it a row would be writing to a node
  that is going away). `entry_touches` counts the carried pair, so the merge
  barrier sees the source the redo depends on.

Tests, red after item 1:

- `crates/notes-sqlite/tests/two_devices.rs::redoing_a_duplicated_waiting_picture_lets_it_meet_its_bytes`
  — duplicate, undo, redo, then let the bytes arrive; assert the redone copy
  reads with an image.
- `crates/notes-application/tests/merge_barrier.rs::the_barrier_counts_the_picture_a_duplicate_had_to_borrow`
  — duplicate, undo, another device edits the source, redo; assert the redo is
  refused.
- `crates/notes-sqlite/tests/two_devices.rs::bytes_that_land_before_the_redo_still_reach_the_copy`
  — the decision that the storage layer reads the source's record at commit
  time rather than remembering it. Bytes land while the duplicate is undone;
  assert the redone copy is settled. Red evidence came from simulating the
  snapshot bug (`AND content_hash = ''` on the carried `SELECT`), since the
  fix was already in by then.

Red evidence to expect: after redo the copy has no picture record, so the
arriving bytes never reach it — the same failure as item 1, one step later. And
the barrier lets a redo through that would take the merge's picture.

## Known limits

**A redo's receipt is one read behind the row it just settled.** `commit`
builds `changed_nodes` from `patch.forward`, and a redo's forward mutations are
the copy exactly as the duplication captured it — with no picture, because the
source had none then. So in the one sequence where the bytes arrive between the
undo and the redo, the row is settled and correct while the window is still
told the copy has no picture; it draws right on the next read of that page, and
nothing schedules one. The stored state is never wrong, and the copy is no
longer dead either way. Fixing it means re-reading the carried copies inside
`commit` and substituting them into `changed_nodes` — worth doing if anyone
meets it, not before.

**A picture landing is announced as if another device had edited it.**
`take_asset` names the rows it settled (`apps/desktop/src-tauri/src/vault_watch.rs`),
those ids become `MergeOutcome::changed_ids`, and `lib.rs` hands them to
`absorb_external` — which treats every named id as another device's change. It
is not one: `resolve_asset` only ever fills in the hash a row was already
waiting for, guarded by the disk name's own hash prefix, so there is nothing to
discard and nothing to put out of reach. The barrier goes up anyway, and the
user loses the undo or redo because a download finished.

This is not new here and not confined to duplicates: an ordinary edit to a
waiting picture — starring it, say — puts that node in the entry's own
mutations, so the same arrival blocks undoing the star. Counting the carried
source extends the same over-block to a duplicate's redo, which is what closes
row 4 above. The fix belongs where the announcement is made: byte arrival needs
to reach the session as "the revision moved, redraw these" without going
through the door a merge goes through. That is a change to the watcher's
seam rather than to anything here, so it is written down rather than made.

**If the source's row is gone by the time a redo replays**, the copy is given
nothing and degrades exactly as it did before this change. Today that needs a
hard `DELETE FROM notes_nodes` on an image node, a path no gesture reaches:
`DeleteSubtree` is a soft flag, `remove_empty_node` refuses image nodes, and
`merge_node_backward` requires two bullets. Not worth a guard until such a
gesture exists.

**Chained pairs inside one `DuplicateNodes` batch** (`A→B` in the same batch as
`B→C`) work because the pairs keep their order from `plan` through to the SQL
loop. Correct today; it would break if anything ever sorted or deduplicated
them.
