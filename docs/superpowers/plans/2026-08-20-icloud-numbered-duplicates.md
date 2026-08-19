# iCloud numbered duplicate copies fight the vault forever

## Diagnosis (from the user's live vault + database)

Vault: `~/Library/Mobile Documents/com~apple~CloudDocs/yonalist` (iCloud Drive).
Folder `Yonalist-rDibyYosWVJY/` holds three files parsing to the same document
id: `README.md`, `README 2.md`, `README 3.md`. iCloud writes numbered
duplicates when its sync daemon collides with the app's atomic
temp-file-plus-rename writes. `notes_sync::watcher::is_conflicted_copy` knows
Dropbox (`conflicted copy`), Syncthing (`sync-conflict-`) and `.conflict.`
shapes, not iCloud's `<name> N.md` shape. Consequences observed in the user's
database:

1. `sync_documents.folder_path` for `rDibyYosWVJY` is
   `Yonalist-rDibyYosWVJY/README 3.md` — a merge of the copy recorded it, and
   every export since writes the copy's name (`record_document` in
   `merger.rs` skips only names `is_conflicted_copy` recognises).
2. The copies not matching the recorded path are re-read every 60-second
   sweep and re-merged; each merge logs `lww` conflicts of the device
   against its own older snapshots (conflict log rows at 04:07:43,
   04:08:43, 04:09:43 — exactly the sweep interval). Rows 42/43 log the
   same pair twice with *identical text on both sides* — pure noise.
3. A stale copy carrying an empty title beat the row: conflict seq 44 shows
   empty text at `0mt0h98wp` (04:21:22) over "Yonalist" at 04:07:45. The
   page title in `notes_nodes` is now `""`, which the UI renders as
   "Untitled page". That is the reported title reversion.

## Contract

| Field | Content |
| --- | --- |
| Goal | A vault holding iCloud-numbered duplicate copies of a document converges: copies are merged once, removed, never recorded as the document's path; exports return to the canonical file name. |
| Acceptance | A1: `is_conflicted_copy("X-id/README 2.md")` and `is_conflicted_copy(".yonalist/trash 2.md")` are true; `README.md`, `readme 2.md`-like user files, and `shot 2.png` are unaffected (only `README`/`trash` stems, only `.md`). A2: exporting a document whose recorded `folder_path` basename is a conflicted-copy name writes `<same folder>/README.md` and re-records that canonical path. A3: merging a file whose stamp is older than the row's **and** whose content equals the row's records no conflict (still requests write-back). A4: merging a numbered copy sets `retire_file` so the watcher deletes it, and does not touch `sync_documents.folder_path` (existing conflicted-copy behavior, now reached by the new pattern — locked by test). |
| Non-goals | No handling of Finder's localized "복사본" duplicates. No image-asset duplicate handling. No schema change, no migration (dev rule). No change to the `mine` equal-stamp adoption branch. No attempt to stop iCloud creating duplicates. |
| Boundaries | Rust only: `crates/notes-sync` (`watcher.rs`, `export.rs`, `merger.rs`). No IPC, no frontend, no SQLite schema. |
| Manual proof | On the user's machine after the fix: the three `README*.md` collapse to one `README.md`, `sync_documents.folder_path` returns to `Yonalist-rDibyYosWVJY/README.md`, conflict log stops growing across two sweep intervals. Title restored by the user via the existing "Put this text back" on conflict seq 44. |

## Items

Each item is one commit, test first, red output recorded verbatim.

### Item 1 — `is_conflicted_copy` learns iCloud's numbered shape

`crates/notes-sync/src/watcher.rs`. A file name whose stem is `README` or
`trash` followed by one space and an integer ≥ 2, with extension `.md`, is a
conflicted copy: `README 2.md`, `trash 12.md`. Nothing else changes — the
document formats only ever write `README.md` and `trash.md`, so a numbered
sibling can only be a sync client's copy. Match on the last path segment,
case-sensitive stems, reject `README 1.md`? No — accept any integer ≥ 2;
`... 1.md` never occurs (iCloud starts at 2) and accepting it would be
harmless, but the test pins ≥ 2 to keep the rule honest. Reject names with
no space or with non-digit suffixes (`README2.md`, `READMEx 2.md`,
`README 2x.md`).

Test (unit, same file's test module): the acceptance A1 table, plus A4 via
the existing merger conflicted-copy tests extended with a numbered name —
merge of `X-id/README 2.md` leaves `sync_documents.folder_path` untouched
and returns `retire_file = true`.

### Item 2 — exports self-heal a hijacked recorded path

`crates/notes-sync/src/export.rs::document_path`. When the recorded
`folder_path`'s file name is a conflicted-copy name (ask
`crate::watcher::is_conflicted_copy` on the basename), do not return it:
derive `<recorded folder>/README.md` — the recorded *folder* stays (folder
renames are forbidden by design), only the file name is repaired. The
subsequent `write_checked` + `record_document` in `export_document` already
re-record whatever path was written, so the record converges to the
canonical name on the first export after the fix. The stranded numbered
file is then merged once by the watcher (item 1) and deleted.

Test (`export.rs` or the crate's integration tests, wherever
`document_path`/`export_document` are already exercised): seed a
`sync_documents` row with `folder_path = "Page-id/README 3.md"`, run
`export_document`, assert the file written is `Page-id/README.md` and the
row now records it.

### Item 3 — an older file saying the same thing is not a conflict

`crates/notes-sync/src/merger.rs::apply`, `Verdict::LocalWins` arm. When
`file_content == row_content` (both already in scope; compare digests the
way `decide` does), skip `log_conflict` and the
`conflicts_recorded` bump; keep `needs_write_back = true` — the file is
behind on its stamp and still owes a rewrite. Content differing keeps the
current logging. This kills the identical-text conflict spam (log rows
42/43) without hiding any real loss.

Test (merger tests): merge a file whose node has an older stamp and
identical content → `conflicts_recorded == 0`, `needs_write_back == true`;
sibling test with different content still records one conflict.

## Gates

Rust-only boundary: `cargo test --workspace --no-fail-fast` (workspace, per
testing-landmines memory), `cargo fmt --check`. Frontend gates skipped —
no frontend file changes.

## Risks

- A user's own hand-written `README 2.md` that *parses as a yonalist
  document* would be merged and deleted. Only files this app's format wrote
  can parse; accepting that residual risk — the alternative (leaving iCloud
  copies forever) is the live bug.
- `document_path` repair changes where an export lands for hijacked records
  only; healthy records are byte-for-byte unaffected (locked by existing
  tests).
