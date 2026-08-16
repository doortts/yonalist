# Settings DB reset must recover a failed startup

2026-08-16 · Fable 5 design · fable-opus-loop phase 1

## Problem

A dev DB created before the sync schema landed fails startup with
`Could not read the stored Notes HLCs: no such table: sync_documents`
(read at `crates/notes-sync/src/hlc.rs:197`, reached from
`crates/notes-sqlite/src/worker.rs:220`). `MIGRATIONS` is deliberately empty
(`crates/notes-sqlite/src/schema.rs:110`, pre-release policy), so the only
recovery is the existing Settings reset — and that reset is dead in exactly
this state.

**Root defect** (verified): `notes_delete_all_data`
(`apps/desktop/src-tauri/src/lib.rs:266`) opens with `let runtime =
gate.wait()?;` solely to reach `runtime.data_directory`. Once startup failed,
`StartupGate::wait` returns the startup error forever
(`apps/desktop/src-tauri/src/startup.rs:39`), so the reset fails with the very
error it exists to clear. `DesktopState.data_directory` (lib.rs:42) already
holds the identical path without the gate — `notes_sync_vault_get`
(lib.rs:250) uses it that way, and setup hands the same `data_directory` to
both the state and the runtime (lib.rs:531–549).

**Reachability** (verified, no UI work needed): the Settings footer button
renders unconditionally (`apps/desktop/src/App.tsx:539`), the status bar with
the startup error stays visible while Settings is open (App.tsx:614–616), and
`SettingsView` makes no gated IPC call on mount (`readVaultPath` →
`notes_sync_vault_get` is gate-free). The user can reach the reset and see why
they need it.

**Legibility gap** (verified): when the reset rejects, `NotesDataSection`
renders `cause instanceof Error ? cause.message : "Notes could not complete
the request."` (`apps/desktop/src/SettingsView.tsx:291`). Tauri rejects with a
serialized `NotesError` plain object — the file's own comment at
SettingsView.tsx:212 documents this — so the real reason is always swallowed.
`messageFrom` is already imported (SettingsView.tsx:12) and used correctly by
`SyncFolderSection`.

## Goal

After a startup that failed on a stale dev database, the existing
Settings → "Delete all Yonalist data" flow completes: the app restarts with a
fresh, working database.

## Acceptance

| # | Observable pass/fail |
| --- | --- |
| A1 | With a data directory whose `notes-v2.sqlite` lacks the sync tables (startup fails with `no such table: sync_documents`), Settings → Delete all Yonalist data... → Delete everything and restart restarts the app into an empty working workspace with no status-bar error. Today the confirm click fails and nothing restarts. |
| A2 | When the reset request rejects, the Yonalist data section's alert shows the backend's own message. Today it shows the generic "Notes could not complete the request." |

## Non-goals

- No repair or migration of the broken DB — pre-release policy
  (`delivering-yonalist-changes` §1) says reset, not repair.
- No separate "reset the database only" option. After a DB wipe every file in
  `images/` is unreferenced (references live only in the DB), so preserving
  attachments preserves unreachable garbage; preserving the stored vault path
  buys nothing because no markdown import exists and the vault is empty.
  Nothing breaks without the narrower option today. Revisit when vault import
  can rebuild a DB — then "reset DB, keep vault, re-import" becomes a real,
  different operation.
- No new IPC command, marker, or Settings section — the existing
  marker + restart + `apply_pending_data_deletion` path is reused as-is.
- No startup-error banner or redesign: the path is already reachable and
  visible (see Reachability above).
- No change to the confirm flow or its copy. The copy already states the
  destruction plainly ("Removes the local Yonalist database and attachments")
  and the two-step confirm is locked by an existing test
  (`SettingsView.test.tsx:225`). It promises no recovery, so nothing misleads.
  Note for the operator, not the UI: the wipe destroys the 15 live notes and
  the empty vault offers no markdown recovery; salvage, if wanted, is a manual
  `sqlite3` read of `notes_nodes` before resetting, outside the app.

## Boundaries

| Boundary | Touch |
| --- | --- |
| React | `apps/desktop/src/SettingsView.tsx` — the two catch blocks in `NotesDataSection` only |
| IPC | `notes_delete_all_data` keeps its shape (no args, unit result); no new commands |
| Rust | `apps/desktop/src-tauri/src/lib.rs` — command body; extract the marker write into a plain gate-free function |
| SQLite | Untouched; the fresh schema on restart is existing `initialize` behavior on the now-absent file |
| Filesystem | Marker still written to the same `data_directory` (state and runtime receive the identical path in setup) |
| macOS | `app.restart()` unchanged |

## Manual proof (shortest real path)

1. `SCRATCH=$(mktemp -d)` and copy the broken DB in:
   `cp ~/Library/Application\ Support/com.doortts.yonalist.v2/notes-v2.sqlite "$SCRATCH"/`
2. `YONALIST_V2_DATA_DIR="$SCRATCH" npm run tauri:dev` — status bar shows the
   `no such table: sync_documents` error.
3. Settings → Delete all Yonalist data... → Delete everything and restart.
4. The app restarts on its own into an empty working workspace; the scratch
   directory holds a fresh `notes-v2.sqlite`; no status-bar error.

Running the same flow on the real directory afterward is the user's call — it
is the lossy wipe described above.

## Items (ordered; one acceptance row each)

### Item 1 — the reset command stops waiting on the failed startup gate (A1)

Change `notes_delete_all_data` to take the marker directory from
`state.data_directory` instead of `gate.wait()?`, the same way
`notes_sync_vault_get` already does. Extract the marker write into a plain
function so it is testable like its counterpart `apply_pending_data_deletion`:

```rust
fn request_data_deletion(data_directory: &Path) -> Result<(), NotesError>
```

The command body becomes: clone `state.data_directory`, `run_blocking(move ||
request_data_deletion(&directory)).await?`, `app.restart()`. The function's
signature is the contract — a reset request needs the data directory and
nothing else.

**Failing test** — `apps/desktop/src-tauri/src/lib.rs`, `#[cfg(test)]` mod
`tests`, beside `a_data_reset_clears_the_stored_vault_path`:
`a_reset_requested_without_a_runtime_clears_the_database_on_next_start` —
temp dir, write a fake `notes-v2.sqlite`, call `request_data_deletion(&data)`
(no gate, no runtime constructed anywhere), then
`apply_pending_data_deletion(&data)`; assert the DB file and the marker are
gone. Red today: the test does not compile — `request_data_deletion` does not
exist. The command wiring itself is covered by the manual proof, consistent
with every other command in this file (none are exercised through a Tauri
harness).

Selector: `cargo test -p yonalist-v2-desktop a_reset_requested_without_a_runtime`

### Item 2 — a failed reset reports the backend's reason (A2)

In `NotesDataSection` (`apps/desktop/src/SettingsView.tsx`), replace both
`cause instanceof Error ? cause.message : "Notes could not complete the
request."` catch bodies (`runAssets`, `runDelete`) with `messageFrom(cause)`
— the helper is already imported and is what `SyncFolderSection` uses for the
same Tauri plain-object rejections.

**Failing test** — `apps/desktop/src/SettingsView.test.tsx`, mirroring the
existing `reports why a folder was refused, in the words the backend used`:
`it("reports why a reset failed, in the words the backend used")` —
`renderSettings({ deleteAllData: vi.fn().mockRejectedValue({ code:
"storageUnavailable", message: "The reset marker could not be written.",
retryable: true }) })`, click "Delete all Yonalist data...", then "Delete
everything and restart", and `await screen.findByRole("alert")` must contain
the backend sentence. Red today: the alert reads "Notes could not complete
the request."

Selector: `npm test --prefix apps/desktop -- SettingsView`

## Gates (after the diff freezes)

Rust + frontend boundary both change: `npm test --prefix apps/desktop`,
`npm run lint:v2`, `cargo test -p yonalist-v2-desktop`, `cargo fmt --check`
for the touched crate, `git diff --check`, plus the manual proof above.
