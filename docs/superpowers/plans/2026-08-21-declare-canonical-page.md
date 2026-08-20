# Declare the open page canonical: this device's version, everywhere

## Status: shelved 2026-08-21, unimplemented

Designed in full, then stopped before the first line of code, by the user's
call. The reason is worth keeping, because it is the reason not to start this
again on a hunch: everything the feature does, the app can already do by hand.
A newer edit already wins, a deletion made again already sticks, a device whose
database is wrong already rebuilds from the folder, and an overwritten row is
already restorable from the conflict log. What the declaration adds is doing all
of that at once — a bulk re-touch — and it buys that convenience by writing to
the riskiest subsystem here, with the blast radius on notes the user is not
looking at.

Revive it when the pain is real and measured: rows on this account actually
coming back, or deletions actually resurrecting, across enough rows that
touching them one at a time is not the answer. Find the cause first (clock skew,
a file the folder keeps re-delivering, a long offline stretch) — if the cause is
a fixable defect, this feature is only its workaround. The cheaper thing to
build first, if the complaint is "another device keeps overwriting me", is
making that visible at the row it happens to, with a one-click "keep mine";
`conflict_loser` and `restore_conflict` already exist behind it.

Everything below is the design as it stood, and it is ready to execute as
written.

## Why

The user's ask, verbatim: "현재 내가 보는 전체 블릿들의 상태가 최종 정본으로
선언하는 기억을 만들어줘. 모든 다른 기기들은 현재 나의 상태를 최종 상태로
일치시키도록 강제하는 기능이야." The scenario behind it: HLC last-writer-wins
has left this device's page looking right, and another device — offline edits,
a fast clock, a stale file iCloud keeps re-delivering — keeps dragging rows
back.

**Decision history, for honesty**: the first revision of this doc froze "no
deletions on the other devices — rows that exist only there survive". The
user reversed that on 2026-08-20: "페이지 기준으로는 상대에만 있는 행이라고
할지라도 현재 페이지 기준으로 일치시키라는 전파가 발생하고 단 이건 지금 해당
기능을 실행한 순간의 1회성만이길 원해." So: **inside the declared page,
removals propagate** — a row another device holds live under this page that
this device does not show must go away there too — and the whole act is
**one-shot**: a single assertion at the moment it runs, never a standing rule.
Nothing durable may be left behind that keeps enforcing the claim; a row
created or edited anywhere after the declaration syncs normally and wins as
usual. Scope is unchanged: the open page's subtree, other pages untouched.

## The mechanism

The merge has exactly one lever: `decide` (crates/notes-sync/src/merger.rs:1004)
compares the file's stamp against the row's, and `decide_place`
(merger.rs:1394) does the same for where the row sits. There is no "force"
verdict, and adding one would be a file-format change every device must
already understand before it helps. So the declaration is a **re-stamp**:
every row the page speaks for takes a fresh `clock.now()` reading. The clock
is guaranteed past every stamp this device has ever merged (`reseed` +
`observe`, hlc.rs:259-309), so the fresh reading beats everything this device
has seen and everything another device stamped before this wall-clock moment.
From there the existing machinery does the rest — the exporter rewrites the
files, receiving merges take `Verdict::Write`, stale files arriving here take
`LocalWins` and are written back, and every overwrite worth keeping lands in
a conflict log exactly as today.

What the page speaks for is now **both presences and absences**. Five things
move together, or the win is partial:

1. **`hlc` on every live row** in the subtree — the content stamp: text,
   note, marker, collapsed, completed, starred, extras, image identity (the
   `LineState` digest). Written directly; `hlc` is deliberately outside the
   stamping trigger's column list (schema.sql:170), so nothing fires.
2. **`sync_prev` / `sync_prev_hlc` on every live row** — the place claim, set
   to the row's current live predecessor at the same fresh reading, written
   in (parent, sort_key) walk order so the claims replay identically
   everywhere. Without this, `decide_place` on the other device keeps their
   newer move: the text flips but the row stays where they put it. The
   renderer omits the token when it equals line order at the node's own stamp
   (render.rs:270), which after this write it does.
3. **`hlc` on every deleted row under the page** — the removals. This
   device's trash entries are its record of every absence it has ever
   asserted; a fresh reading on each makes the deletion beat any edit another
   device stamped before this moment, so a row this device deleted stops
   coming back — and a row still live elsewhere is deleted there when the
   rewritten `trash.md` merges (`decide`: `row.deleted != deleted_now` →
   `Reason::Lww`, merger.rs:1060 — the removal lands in that device's trash
   *and* its conflict log). Claims are not touched on deleted rows — a trash
   root's place is its `from` record, not a sibling claim.
4. **`sync_node_exports` emptied** (`content_hash = '', exported_hlc = ''`)
   for every re-stamped row, live and deleted. This is the trap that silently
   kills a naive re-stamp: `settle_readings` (export.rs:876) puts the
   *recorded* reading back onto any row whose content fingerprint has not
   changed since its last export — the fresh stamp would be reverted before
   the file is written and the declaration would die without a trace.
   `write_row` empties the record for the same reason (merger.rs:1365-1372).
5. **`sync_dirty_nodes`** — an explicit mark per re-stamped row, the way
   `park` does it (merger.rs:616): the direct `hlc` write fires no trigger,
   and `pending_documents` (export.rs:219) turns the marks into the right
   documents — the page, its split documents, and `yonalist-trash`.

### How absence is expressed — the fork, and why the trash wins

Two shapes were on the table for naming rows this device does not hold live:

- **Diff the page's vault files at declare time** (parse the page's documents,
  tombstone ids live there but not live here). Under a running watcher this
  collapses: a row that is live in the folder has been merged, so it is live
  *here* and is not a removal; a row live in the folder that this device
  refuses to show is one this device deleted — and its own trash already
  names it, no file open needed. What the diff would add is only the
  seconds-wide window between a file landing and the watcher merging it, plus
  files the watcher could not read — which the diff cannot read either, and
  trying at declare time would block the act on an iCloud download. All cost,
  almost no coverage: dropped.
- **A page-level completeness claim in the file** ("this document is the
  whole subtree as of T", receivers delete their own older absent rows). This
  is the only shape that reaches rows that have *never* been exported — the
  other device's unsynced edits. It was rejected because it buys that reach
  at the price of a file-format addition, a new deletion behavior on every
  device (a receiver destroys content the declaring user has never seen),
  divergence while old builds ignore the key, and a claim that keeps acting
  every time the file replays — hard to honestly call one-shot.

What the user loses without the completeness claim, stated plainly: **a
device that has not synced yet brings its rows back.** A row created there
before the declaration but exported after it has no tombstone here, so it
arrives and lives. The leak self-heals: the row is now visible on this page,
and an ordinary delete (fresh stamp) removes it everywhere — no second
declaration needed. The confirm copy says this out loud.

### What deliberately does not move

- **No revision bump, no session touch, no undo change.** Nothing the window
  can observe changes — the live rows, order, and images are as they were,
  and the re-stamped trash rows were already invisible. Precedent:
  `export_pending`'s own rule, "writing the notes down did not change them"
  (sync_merge.rs:288). The window's revision claim stays valid, the undo
  stack keeps every entry, and an undo after declaring is an ordinary new
  edit that restamps even fresher. The boot-revision bug class is avoided by
  not moving the revision at all.
- **Other pages entirely** — their live rows, their deleted rows, their
  claims. The trash sweep is scoped to deleted rows whose parent chain
  reaches the declared root, never the whole trash table.
- **The page's own position in Home** (its `sync_prev` claim), unless Home
  itself is the declared page: the page view does not show where the page
  sits among its siblings.
- **Nothing durable.** The declaration leaves behind only stamps — no flag,
  no rule, no claim in any file. That is the whole of "1회성": a fresh edit
  or a new row anywhere, stamped after this moment, wins over the declaration
  the way any edit wins, removed rows included.

### Recoverability

A propagated removal is never "gone": on the receiving device the row moves
to the trash (`deleted = 1`, restorable exactly as any deletion) **and** its
text lands in that device's conflict log as the dropped side of an `lww`
entry — visible and restorable in Settings → Overwritten notes. On the
declaring device the removed rows were already its own trash entries; the
confirm step and the report state their count. Rows on both sides that were
already deleted re-stamp without logging a conflict (`decide` reasons only on
a state change), so the log is not spammed. No new table, no new column, no
schema change.

### Order of operations

Copying `notes_rebuild_from_vault`'s shape (lib.rs:425): refuse without a
vault folder first, before anything is stamped; then the declare transaction
on the worker (one `Immediate` transaction, no `bump_revision`, no
`rebuild_all` — parent and sort_key never change); then a synchronous
`runtime.sync.flush()` so "written to the folder" is true when it is said. A
flush failure does not undo the stamps — they are dirty and the exporter
retries — so it is reported as "final on this device, folder not yet written"
plus the existing write-failure badge (`status.set_write`), never as "nothing
happened".

## Contract

| Field | Content |
| --- | --- |
| Goal | One action on the open page makes this device's current version of that page — its rows *and* its absences — the one every synced device converges to, as a single act at that moment. |
| Acceptance | A1: after declaring, a shared row another device had edited with a newer stamp shows this device's text on both devices once files exchange, and the replaced unexported text is in that device's Overwritten notes. A2: a shared row another device had moved sits at this device's declared position on both devices. A3: a row this device deleted from the page but the other device holds live — even edited there after the deletion — is removed there by the declaration, landing in that device's trash and conflict log, and stays removed after a full round trip. A4: declaring page P moves stamps for exactly P's subtree — live rows across P's split documents, P's root content, and deleted rows under P — while sibling pages' live and deleted rows, and P's own position in Home, keep theirs. A5: on the declaring device the revision does not move and an edit made before declaring still undoes cleanly after it. A6: the confirm step states the live row count, the removal count, and the file count read from the database, and asking changes nothing. A7: the action lives in the page's export menu behind a modal confirm naming both counts; success and failure land in the menu's status/alert line; without a sync folder the attempt answers the refusal message and stamps nothing. A8: the declaration is one-shot — a row created and an edit made on the other device after it sync back and stand, and a post-declaration edit to a removed row resurrects it. |
| Non-goals | Not a lock or ownership — later edits anywhere win as usual (A8 is the contract). No per-selection declaration. No completeness claim in the file format and no vault snapshot. No change to merge verdicts, the file format, or the schema (`SCHEMA_VERSION` stays 1, no new tables or columns). No change to the conflict-log cap (1,000 / 180 days). No reach into rows that never entered the folder — a not-yet-synced device brings its rows back, by design. No Windows/Linux. |
| Boundaries | React: `apps/desktop/src/NotesExportMenu.tsx` (+ test), `NotesExportBoundary.tsx`, `NotesOutline.tsx`, `App.tsx`, `api.ts`, `notesExport.css`. IPC: two new commands (`notes_sync_declare_preview`, `notes_sync_declare_page`), one new ts-rs type `PageDeclarationReport { rows, removals, documents }`. Rust: `crates/notes-sync/src/declare.rs` (new), `crates/notes-sqlite/src/sync_merge.rs` + `worker.rs`, `crates/notes-application/src/contracts.rs`, `apps/desktop/src-tauri/src/lib.rs`. SQLite: existing tables only (`notes_nodes.hlc/sync_prev/sync_prev_hlc`, `sync_node_exports`, `sync_dirty_nodes`). Filesystem: vault files rewritten by the existing exporter, `trash.md` included. macOS: manual proof only. |
| Manual proof | Below — two data directories over one vault, `YONALIST_V2_DATA_DIR` selecting each side, staged file delivery via `cp`/`mv` of the vault. GUI scripting cannot drive this app; the proof is written for a human. |

## Items

Items 1–4 share `declare.rs`/`sync_merge.rs`; run them sequentially in one
agent. Item 7 depends on Item 5's api surface.

### Item 1 — the declared live state is what both devices end up holding (A1, A5)

`crates/notes-sync/src/declare.rs`: `declare_subtree(transaction, clock,
root_id) -> Result<DeclareOutcome, String>`. Simplest correct walk to green:
recurse the root's live rows (`deleted = 0`, no document-boundary stop —
exclusions and the trash sweep are Items 3–4's), and per row write the fresh
`hlc`, empty its `sync_node_exports` record, and `mark_dirty`. Wrapped by
`sync_merge::declare_canonical(connection, clock, root_id)` — one `Immediate`
transaction, **no `bump_revision`, no `rebuild_all`** — and exposed as a
worker method the way `rebuild_from_vault` is. The test starts from a
**settled pair** on purpose: every fingerprint is recorded, so a declaration
that skips the export-record emptying is reverted by `settle_readings` and
cannot pass — the trap is exercised by construction.

- **Failing test**: `crates/notes-sqlite/tests/two_devices.rs`,
  `a_declared_page_is_what_both_devices_end_up_holding` — settle a pair; on B
  (without exporting): edit a shared row's text and delete a row A still
  shows; record A's revision; A declares the page (worker method), assert A's
  revision unchanged and an A-side undo of a pre-declaration edit still
  applies; A exports, carry A→B, B absorbs; carry B→A, A absorbs; assert both
  outlines show A's text, the row B deleted is back on both, and B's
  overwritten text sits in B's `sync_conflicts` as the dropped side. Red
  form: the worker method does not exist — record the compiler's cannot-find
  error.
- **Command**: `cargo test -p notes-sqlite --test two_devices a_declared_page_is_what_both_devices_end_up_holding`

### Item 2 — the declared order wins too (A2)

Add the place claim to the live walk: per live row, `sync_prev` = its current
live predecessor (the `(sort_key, id)` order under its parent),
`sync_prev_hlc` = the row's fresh reading, in (parent, sort_key) walk order.
The declared root's own claim is not touched.

- **Failing test**: `crates/notes-sqlite/tests/two_devices.rs`,
  `a_declared_order_beats_a_newer_move` — settled pair; B moves a shared row
  to the front (newer claim) without carrying; A declares; exchange both
  ways; assert both devices list the siblings in A's declared order. Red
  today (after Item 1): B keeps its move — the content stamps flipped but the
  claims did not.
- **Command**: `cargo test -p notes-sqlite --test two_devices a_declared_order_beats_a_newer_move`

### Item 3 — a row deleted here is removed there (A3)

The removals: extend the walk to deleted rows whose parent chain reaches the
declared root — fresh `hlc`, emptied export record, dirty mark; no claims.
The rewritten trash travels and the receiving merge does the deleting,
logging `lww` with the receiver's text as the dropped side.

- **Failing test**: `crates/notes-sqlite/tests/two_devices.rs`,
  `a_row_deleted_here_is_removed_there` — settled pair holding row R; A
  deletes R; then B edits R with a *newer* stamp (without carrying); A
  declares and exports; carry A→B, B absorbs: R is deleted on B and B's
  edited text is in B's conflict log as dropped; carry B→A, A absorbs: R
  stays deleted on A. Red today (after Items 1–2): the declaration leaves A's
  old trash stamp standing, B's newer edit beats it, and R comes back live on
  both — the exact behavior the reversal removed.
- **Command**: `cargo test -p notes-sqlite --test two_devices a_row_deleted_here_is_removed_there`

### Item 4 — exactly the open page's subtree, and nothing else (A4)

The walk gets its boundaries: split documents crossed (the user sees those
rows inline — unlike `document_is_missing_nodes`, which stops at them), the
declared root's content stamp included when the root is a real page, the root
row itself untouched when the root is Home, the root's `sync_prev` claim
untouched in both cases, and the trash sweep scoped to the page — never the
whole trash table.

- **Failing test**: new `crates/notes-sqlite/tests/declare_canonical.rs`,
  `only_the_open_pages_rows_move` — one device with page P (live rows, a
  split child document with rows, a deleted row under P) and a sibling page Q
  (a live row, a deleted row); snapshot every `hlc`/`sync_prev_hlc`; declare
  P; assert P's live rows, split-document rows, root content stamp, and P's
  deleted row moved — and Q's live row, Q's deleted row, and P's own
  `sync_prev_hlc` did not. Red today: P's root content stamp did not move
  (Item 1 walked descendants only), and/or Q's deleted row moved if Item 3's
  sweep was table-wide.
- **Command**: `cargo test -p notes-sqlite --test declare_canonical only_the_open_pages_rows_move`

### Item 5 — the app can ask, and asking changes nothing (A6)

`declare.rs` gains `preview_subtree(transaction, root_id) -> DeclareOutcome`
— the same walk, counting live rows, deleted rows (the removals), and their
distinct owning documents, writing nothing. Plumbing rides in this commit:
`contracts.rs` `PageDeclarationReport { rows: u32, removals: u32,
documents: u32 }` (ts-rs regenerated), worker methods, lib.rs commands
`notes_sync_declare_preview` and `notes_sync_declare_page` (vault guard in
the rebuild's exact idiom; declare, then `runtime.sync.flush()`, badge via
`status.set_write` on flush failure while still answering the report),
`api.ts` entries `declarePreview(pageId)` / `declarePage(pageId)`. A root id
the database does not hold live answers a refusal ("This page hasn't reached
the database yet.").

- **Failing test**: `crates/notes-sqlite/tests/declare_canonical.rs`,
  `a_preview_counts_without_moving_anything` — on the Item 4 fixture, preview
  P: assert `rows`, `removals`, and `documents` match the fixture (split rows
  in `rows`, P's deleted row in `removals`, Q in neither), and afterwards no
  `hlc` changed and `sync_dirty_nodes` is as it was; an unknown root id
  answers an error. Red form: `declare_preview` does not exist — the
  compiler's cannot-find error.
- **Command**: `cargo test -p notes-sqlite --test declare_canonical a_preview_counts_without_moving_anything`

### Item 6 — the declaration acts once and leaves no rule behind (A8)

No new production code. This test locks the one-shot choice itself — it is
red against the rival shape (any standing completeness rule that deletes
absent rows at merge time) and is expected green against Items 1–4, whose
mechanism leaves only stamps behind. That green-at-birth is accepted by
design: the test's job is to make the rival implementation impossible to
land later, and the resurrect assertion pins real LWW behavior.

- **Failing test** (contract lock): `crates/notes-sqlite/tests/two_devices.rs`,
  `the_declaration_acts_once_and_leaves_no_rule_behind` — after an
  Item-3-style declare and full exchange: on B, add a new row under the page,
  edit a shared row, and edit the removed row R (all stamped after the
  declaration); exchange both ways; assert all three stand on A — the new row
  lives, the edit won, and R is back with B's text. Also assert the honest
  limit: a row B created *before* the declaration but never exported until
  after it arrives at A and lives.
- **Command**: `cargo test -p notes-sqlite --test two_devices the_declaration_acts_once_and_leaves_no_rule_behind`

### Item 7 — the menu action (A7)

`NotesExportMenu` gains a separated item under the four export actions, with
props threaded from `App.tsx` the way `SettingsView` receives
`rebuildFromVault`. Clicking calls `store.flushAllDrafts()` (the menu's own
precedent) then `declarePreview`; a rejection shows in the existing alert
span. On a count, the confirm is the component's **existing modal**
(`.notes-export-confirm-dialog`, `role="alertdialog"` — the "Replace existing
export?" dialog's classes and shape). The first revision used the settings
in-place reveal; the act now deletes rows on other machines, which is
modal-weight, and the modal already ships in this exact component — cheaper
and more consistent than a second confirm idiom. Confirm calls
`declarePage`, closes the dialog, and reports in the existing
`notes-export-feedback` spans (`role="status"` on success, `role="alert"` on
failure). Exact copy below.

- **Failing test**: `apps/desktop/src/NotesExportMenu.test.tsx`,
  "이 페이지를 최종본으로 선언하는 흐름" — with mocked `declarePreview`
  (answers `{ rows: 12, removals: 3, documents: 2 }`) and `declarePage`:
  clicking the menu item opens an alertdialog whose copy contains "12 rows"
  and "3 rows you deleted", with a danger button "Make final and remove 3
  rows elsewhere"; Cancel closes it without calling `declarePage`; confirm
  calls `declarePage` once with the page id and the status line states rows,
  removals, and files; with `removals: 0` the danger button reads "Make 12
  rows final"; a rejecting `declarePreview` (the no-vault message) renders as
  the alert and no dialog appears. Red today: the menu item does not exist,
  the first `getByRole` fails.
- **Command**: `cd apps/desktop && npx vitest run --config vite.config.ts src/NotesExportMenu.test.tsx`

## UI

**Surface**: the page's export menu (`NotesExportMenu`, the one page-scoped
action menu, top right of the outline), as a fifth item under a separator.
The confirm reuses the component's existing modal confirm dialog
(`role="alertdialog"`, `.confirm-dialog` / `.notes-export-confirm-dialog`
classes) — not the settings in-place reveal, which fit the earlier
no-deletion semantics but is too light now that rows are removed on other
machines.

**Menu item**: `Make this page final on every device...`

**Confirm dialog** (title names the *page*, not the zoom root, so a zoomed
user sees what they are committing):

> **Make "{page title}" final on every device**
>
> Every synced device adopts this page exactly as it is on this screen:
> {rows} rows in {documents} files.
>
> {removals > 0}: `{removals} rows you deleted from this page are removed
> from every other device too. A removed row lands in that device's trash
> and its Overwritten notes.`
> {removals == 0}: `This page has no deleted rows, so nothing is removed
> anywhere.`
>
> This happens once, now. Anything created or edited anywhere after this
> moment syncs normally and wins as usual — and a device that has not synced
> yet can still bring its own rows back.

Buttons: `Cancel` ·
danger, removals > 0: `Make final and remove {removals} rows elsewhere`
danger, removals == 0: `Make {rows} rows final`

**Busy** (feedback span, `role="status"`): `Making this page final...`

**Success** (`role="status"`):
removals > 0: `{rows} rows made final and {removals} removals sent to every
device; {documents} files written to the sync folder.`
removals == 0: `{rows} rows across {documents} files made final and written
to the sync folder.`

**Failure states**:

- No sync folder (surfaces on the preview call, before any dialog;
  `role="alert"`): `Choose a sync folder first: other devices only see this
  page through that folder.` Nothing was stamped.
- Page not in the database yet (a provisional page the draft flush could not
  materialize; `role="alert"`): `This page hasn't reached the database yet.`
- Declared but the folder write failed (`role="alert"`): `This version is
  final on this device, but the sync folder could not be written: {reason}.
  It will be retried automatically.` The sync badge shows the write failure
  through the existing `set_write` path; the stamps stand and the exporter
  retries.

## Manual proof

One vault, two data directories. Fresh bundle per
`worktree-real-app-verification`.

1. `mkdir -p /tmp/yona-vault`. Device A:
   `YONALIST_V2_DATA_DIR=/tmp/yona-a npm run tauri:dev`, choose the folder,
   make a page with rows R1–R5. Quit. Device B:
   `YONALIST_V2_DATA_DIR=/tmp/yona-b npm run tauri:dev`, same folder, wait
   for the page, quit. `cp -r /tmp/yona-vault /tmp/vault-settled`.
2. **B goes "offline" and edits**: launch B; edit R1's text, drag R2 to the
   top, edit R3's text, add R6. Quit (quit flushes).
   `mv /tmp/yona-vault /tmp/vault-b-edits && cp -r /tmp/vault-settled /tmp/yona-vault`
   — B's changes are now "undelivered".
3. Launch A — nothing new arrives. Delete R3 from the page. Export menu →
   "Make this page final on every device...": the dialog names the page,
   states the row count and **1 removal**, and the danger button says
   "remove 1 rows elsewhere". Confirm; the status line reports rows,
   removals, files. Quit A.
4. **B's stale files arrive late**:
   `cp -r /tmp/vault-b-edits/* /tmp/yona-vault/`. Launch A: R1 keeps A's
   text, R2 keeps A's order, R3 stays gone — and R6 **appears**: it reached
   the folder only after the declaration, which is the stated one-shot limit
   (delete it normally if unwanted; that delete now wins everywhere).
   Settings → Overwritten notes on A holds B's R1 and R3 texts. Quit A.
5. Launch B: the page shows A's version — A's text and order, R3 removed
   into B's trash with B's R3 text in B's Overwritten notes, R6 still
   present.
6. **One-shot**: on B, add R7 and re-edit R1; on A's next launch both stand —
   nothing claws them back.
7. Refusal path: `YONALIST_V2_DATA_DIR=/tmp/yona-c npm run tauri:dev`, skip
   choosing a folder, open the menu action — the alert says to choose a sync
   folder first, and no dialog appears.

## Edge cases, decided

- **Home as the open page**: still allowed. The blast radius is now every
  live row in the vault plus every deletion ever made under any page,
  re-asserted — the dialog's two counts make that scale visible before the
  danger button, every removal lands in trash and conflict logs, and
  refusing Home would be a special case in a mechanism that is identical
  either way.
- **Zoomed window**: the declaration targets the page (frozen scope), not the
  zoom root; the dialog names the page title so this is visible.
- **A device offline for the whole declaration**: it adopts on return —
  stamps decide, not arrival time. Its pre-declaration edits lose, removed
  rows included; anything it stamped after the declaration wins; rows it
  created that never reached the folder before it returns come back (the
  stated limit), now visible here and removable with an ordinary delete.
- **A row edited elsewhere after the declaring device's reading**: it wins —
  even on a removed row, which comes back carrying that edit. That is the
  one-shot contract, not a defect; the dialog says so.
- **A device whose clock runs ahead of ours** (inside the 24-hour drift
  guard): its pre-declaration stamps can still beat the declaration.
  Accepted; beyond the guard every merger already refuses the stamp.
- **Conflict-log cap**: each removal of a live row adds one `lww` entry on
  the receiving device; a declaration removing more than 1,000 such rows
  prunes that device's oldest entries. Accepted — the cap predates this
  feature and already-deleted rows log nothing.
- **A row removed here by undoing its creation** (hard delete, no trash
  entry): the declaration cannot name it, and the completeness write-back
  can bring it home again. Deleting it normally and re-declaring — or just
  deleting it once it reappears — covers it. Accepted.
- **Subtree larger than an export pass**: no batch bound exists — the declare
  is one transaction, the exporter writes per document, a failing document
  keeps its marks and retries. A very large page blocks the worker thread for
  the write, the same as a rebuild.
- **A merge landing just before the declaration**: the worker serializes both
  on one connection; the declaration stamps whatever the database holds at
  that instant, which is what the window is about to show.
- **iCloud dataless files**: the declaration writes nothing itself; the
  exporter's existing read-before-replace (`may_write`) refuses to clobber a
  file it cannot read back, and a refused read is never mistaken for an empty
  document. Marks stay, the write retries.
- **Two devices declaring against each other**: pure LWW on fresh stamps —
  the later declaration wins row by row, removals included, deterministically.

## Regression risk

- `a_settled_pair_stops_writing` (two_devices.rs:544): after a declaration
  plus one export, `record_readings` must re-record the fresh fingerprints so
  the pair settles again instead of rewriting forever — trash included.
- `export_trash` rebuilds `trash.md` from deleted rows; the re-stamped trash
  raises its `max_hlc` and must round-trip through `merge_trash` without
  resurrecting anything (`deleted == deleted_now` → no conflict, no state
  change).
- The place-claim write fires `notes_nodes_place_au`, double-marking live
  declared rows dirty — harmless (`ON CONFLICT` update), but the explicit
  marks must stay: root content stamps and trash re-stamps fire no trigger at
  all.
- `reseed` (hlc.rs:284) now reads the declaration's stamps as the boot
  high-water mark — intended, worth knowing.
- `NotesExportMenu.test.tsx` exercises the existing four actions and the
  overwrite dialog; the new separator, item, and second use of the dialog
  classes must not shift their roles or labels.
- ts-rs output is generated: `PageDeclarationReport.ts` appears; never
  hand-edit it.

## Gates

Once, after the diff is frozen: `npm test`, `npm run lint`,
`npm run test:bundle`, `git diff --check`, and — Rust, IPC and persistence
changed — `cargo test --workspace --no-fail-fast`,
`cd apps/desktop && cargo test --manifest-path src-tauri/Cargo.toml`, plus
`cargo fmt --check`.
