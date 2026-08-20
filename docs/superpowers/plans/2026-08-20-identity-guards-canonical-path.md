# A document's identity, not its file name, guards its canonical path

## Why

`record_document` (merger.rs) adopts whatever path a merged file arrived at as
the document's `folder_path`, unless the *name* matches a known conflicted-copy
pattern. The pattern list now knows Dropbox, Syncthing, `.conflict.`, and
iCloud's numbered bounces — but any duplicate under a name outside the list
(Finder's localized "복사본", a user's hand copy, a sync client we have not
met) still hijacks the canonical path, and every export after that writes into
the copy while the real file goes stale. That is the exact mechanism of the
August bug, surviving for unlisted names.

The stronger rule uses what the vault already guarantees: a document's
identity is its root id, and `sync_documents` records exactly one canonical
path per id. The same id arriving from a *different* path is a transport copy
**when the recorded file is still standing** — and a *move* when it is gone.
Distinguishing the two on the recorded file's existence is what keeps a
user's hand-made folder move working: today such a move is adopted, and it
must stay adopted.

Name patterns keep one job they are genuinely right for: deciding what may be
*deleted*. A numbered bounce is provably machine-made; a duplicate under an
arbitrary name might be somebody's deliberate backup, and removing it would
be taking the user's file. So: identity protects the path, names authorize
deletion. The costs of not deleting an unlisted duplicate are one re-hash per
sweep and nothing in the conflict log (same content merges silently since
`8931692b`) — accepted.

## Contract

| Field | Content |
| --- | --- |
| Goal | No file can take over a document's canonical path while the recorded canonical file still exists on disk — whatever the copy is named — and a genuine move (recorded file gone) is still adopted. |
| Acceptance | A1: merging a same-id file from an alternate path under an arbitrary name (`README 복사본.md`), while the recorded canonical file exists, merges its content but leaves `folder_path`, `exported_hash`, and the file itself untouched. A2: merging a same-id file from a new path when the recorded file is gone adopts the new path (today's move behavior, pinned). A3: order invariance for iCloud's own shape — `README 2.md` before `README.md` and the reverse both end, after one export pass, with `folder_path` on `README.md` and the copy retired. A4: with no vault root supplied (tests, legacy callers), behavior is exactly today's. |
| Non-goals | No alias/pending-retire table. No deletion of unlisted-name duplicates. No change to which names `is_conflicted_copy` deletes. No NSFileVersion work. |
| Boundaries | Rust: `crates/notes-sync/src/merger.rs` (`merge_document` signature + `record_document`), `crates/notes-sqlite` (`sync_merge.rs` plumbing, `worker.rs` request + public `merge_document`), `apps/desktop/src-tauri/src/vault_watch.rs` (passes the vault root it already holds). No schema change — the guard is a read of `sync_documents` plus one `is_file`. |
| Manual proof | N/A beyond the healthy-vault check the gates give; the failure state needs a hand-made duplicate, which the A1 test stages in a temp vault. |

## Items

### Item 1 — `merge_document` learns where the vault is

Signature: `merge_document(transaction, clock, file, input, vault_root: Option<&Path>)`.
`None` means "cannot ask the folder", and every existence question answers
"not standing" — today's behavior, which is what keeps the whole existing
test suite green unchanged (A4).

Plumbing: `sync_merge::merge` takes `Option<&Path>` and passes it through;
`Request::MergeDocument` and `SqliteStorage::merge_document` gain the
parameter (a `PathBuf` crosses the worker channel fine); `vault_watch::take`
passes the `vault_root` it already holds; `reindex_vault`/`rebuild_from_vault`
pass theirs. Callers in tests pass `None` unless the test is about the guard.

This item is mechanical and must not change any behavior — commit it green
with the suite untouched except for signatures.

### Item 2 — the guard in `record_document`

Before the upsert (after the `is_conflicted_copy` early return, which keeps
its job):

```
recorded = SELECT folder_path FROM sync_documents WHERE root_id = ?
if recorded exists
   && recorded != input.file_path
   && vault_root says vault_root.join(recorded) is a file
{ return Ok(()) }   // a transport copy: content merged, path stays put
```

The early return mirrors the conflicted-copy branch — no quarantine clear, no
stat update — because this file is not the document's file.

Tests (merger level, temp dir as the vault):

- A1 red first: create the canonical file on disk, record it, merge the same
  document from `X/README 복사본.md` — today `folder_path` moves (the
  hijack); after the guard it stays, the copy file survives, `retire_file`
  is false.
- A2: same setup, recorded file deleted from disk first — the new path is
  adopted.
- A3 both orders. Amended after implementation: the convergence story as
  first written was wrong — `record_document`'s `is_conflicted_copy` check
  runs before the guard, so a copy-first `README 2.md` records nothing and
  the canonical arrival adopts `README.md` directly; neither the self-heal
  nor the guard is exercised for iCloud-shaped names, and A3 cannot go red.
  It stays as an order-invariance pin, saying so in its own comment.
  Also noted: the guard sits in `record_document`, which `merge_trash`
  shares, so trash identity is covered too — one guard, all callers.

## Gates

Rust + the desktop crate compile: `cargo test --workspace --no-fail-fast`,
`cargo fmt --check`. Frontend untouched.
