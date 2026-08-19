# Overwritten notes: both versions, with when and where

## Contract

| Field | Content |
| --- | --- |
| Goal | Settings → Overwritten notes shows, for every recorded conflict, the kept text and the dropped text side by side, each with the time that version was edited and the name of the device that made it, and the two existing buttons joined into one adjacent pair. |
| Acceptance | A1 A page document states the device that wrote it (`device_id`, `device_name`) and a round trip preserves both.<br>A2 Ingesting a file teaches this device the writing device's name, and a later file with a new name replaces it.<br>A3 This device's own name is captured at startup from the macOS computer name and travels out in the files it writes.<br>A4 A recorded conflict holds the winning text as well as the losing one.<br>A5 `syncConflicts` returns both sides, each with its edit time, device id, device name when known, and whether it is this device.<br>A6 The settings row renders both versions with time and device, the reason and the noticed time, and the two buttons as one adjacent pair. |
| Non-goals | Renaming a device from inside Yonalist. A vault-wide device registry file. Diffing the two texts word by word. Restoring anything other than the losing text (the existing restore path is unchanged). Windows or Linux device names. Migrations or compatibility readers — development data is remade in place. |
| Boundaries | Vault file format (`document.rs`, `render.rs`, `parse.rs`, `docs/v2/sync-spec.md` §4.2 and its golden), SQLite schema (`sync_conflict_log`, new `sync_devices`), merge (`merger.rs`), export (`export.rs`), IPC contract (`SyncConflict`, ts-rs generated), React (`SettingsView.tsx`, `styles.css`, `previewApi.ts`), Tauri setup (`lib.rs`, `scutil` subprocess). |
| Manual proof | Two vaults on one machine is not enough for a real second device name, so: run the app, make a conflict by hand-editing a vault file whose frontmatter states a different `device_id`/`device_name` and an HLC on that device, then open Settings → Overwritten notes and read the row — both texts, both times, the foreign name, "this device" on our side, buttons adjacent. |

## Device names: the decision

Names travel in each page document's frontmatter (`device_id`, `device_name`), and every
merge upserts what it read into a local `sync_devices(device_id, name)` table. The read
side then resolves any device id — including ids inside HLCs written by a device we have
never merged a file from, which simply stay unnamed and show as the raw four hex
characters.

Why this over the alternatives. Copying the name into the conflict row at merge time is
cheaper but wrong on the common case: the losing side of a `Verdict::Write` conflict is a
*local* row whose HLC may name a third device, and the arriving file says nothing about
that device — the row would be stuck unnamed for ever. A vault-wide registry file is a new
file kind in a format whose spec says only page and trash documents are written, which is
a larger format change than two frontmatter keys for the same result. A rename propagates
on the renaming device's next export, which is the same latency every other fact in the
vault has, and the table keeps whatever it last learned rather than inventing a name.

`device_name` is the same class of key as `updated`: written by whoever exports the file,
never read as an edit (frontmatter lines belong to no block, spec §4.2), and replaced by
the next render. So no `format_version` bump and no merge churn when two devices alternate.

The name itself is the macOS computer name — `scutil --get ComputerName`, the friendly
"Suwon's MacBook Pro" rather than the dotted hostname. No crate in the lockfile provides a
hostname, and the friendly name is what a person recognises. Read at every startup, so a
rename in System Settings lands without a reset; when the command fails there is no name
and the id shows instead. Trash documents do not carry the keys — a device that writes
trash also writes pages, so learning names from pages alone is enough.

`winner_json` mirrors `loser_json` rather than being a bare text column: the two existing
builders (`loser_of_row`, `loser_of_file`) already produce exactly this shape, so the
winning side costs one call each instead of a second extraction path. They are renamed to
`side_of_row` / `side_of_file` since they now build both sides.

## Items

Each item is one commit. Order matters: the format states the name before anything learns
it, and the log holds both texts before the contract exposes them.

### Item 1 — a page document states the device that wrote it

`PageDocument` gains `writer: Option<Writer>` (`Writer { device_id, device_name }`).
`render_page` writes `device_id` and `device_name` after `root_starred` and before the
carried-through unknown keys, skipping both when there is no writer or either value is
empty; the name goes through `field_fits`. `parse` reads them into `writer`, `None` unless
both are present and non-empty, and both keys join `KNOWN_KEYS` so a foreign line is not
also carried in `unknown_frontmatter` and duplicated on the way back. Spec §4.2 key table
and golden A updated.

Test: `crates/notes-sync/tests/render_goldens.rs` — the golden page gains the two keys, and
a round trip through `parse` returns the same `writer`. Red first: the golden bytes will not
contain `device_name` until the renderer writes it.

### Item 2 — a merge learns the writing device's name

`sync_devices(device_id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL) STRICT` in
`schema.sql`. `merge_page` upserts `page.writer` before applying nodes.

Test: `crates/notes-sync/tests/merge_ingest.rs` — ingest a page stating `device_id: a3f1`,
`device_name: Studio`, assert the row; ingest the same document with `device_name: Studio 2`,
assert the row was replaced, not duplicated. Red first: no such table.

### Item 3 — this device's name is captured and exported

A storage command that upserts the local device's row in `sync_devices`, called from the
Tauri setup with whatever `scutil --get ComputerName` returned; `export.rs` reads the local
id and name and sets `writer` on every page document it builds.

Test: `crates/notes-sync/tests/export_core.rs` — with a name seeded in `sync_devices`, the
exported file's frontmatter states this device's id and that name; with no row, neither key
is written. Red first: the exporter sets `writer: None` today.

### Item 4 — a conflict records the winning text too

`sync_conflict_log` gains `winner_json TEXT NOT NULL`. `loser_of_row`/`loser_of_file` are
renamed `side_of_row`/`side_of_file` and both conflict sites build both sides: at
`Verdict::Write` the winner is the arriving entry, at `Verdict::LocalWins` the winner is the
row. `conflict_loser` is untouched — restore still restores the loser.

Test: `crates/notes-sync/tests/merge_ingest.rs` — after a last-writer-wins conflict,
`json_extract(winner_json, '$.text')` is the text that is now in the row, and after a local
win it is the local text. Red first: no such column.

### Item 5 — the contract carries both sides

`SyncConflict` becomes `{ seq, nodeId, reason, recordedAt, kept: SyncConflictSide, dropped:
SyncConflictSide }` with `SyncConflictSide { text, editedAtMillis, deviceId, deviceName:
Option<String>, isThisDevice }`. `conflicts()` decodes `winner_hlc`/`loser_hlc` for the
millis and the device id, joins `sync_devices` for the name, and compares against
`sync_meta.device_id`. A stamp that fails to decode yields a zero time and an empty device
id rather than dropping the row — the record is the point. ts-rs regenerated.

Test: `crates/notes-sqlite/tests/two_devices.rs` — a seeded conflict returns both sides with
the right texts, times, device ids, the known name on one side and `None` on the other, and
`isThisDevice` true on exactly the local one. Red first: the fields do not exist.

### Item 6 — the settings row shows all of it

`OverwrittenNotesSection` renders per conflict: a two-column card with a Kept and a Dropped
column, each carrying its text, its edit time via `toLocaleString`, and its device
(`name (this device)`, `name (id)`, or the bare id when unnamed); a footer with the reason in
plain words — `lww` later edit won, `same_t` same timestamp, `clock_drift` clock disagreed,
`dirty_overwrite` unsaved local edit — the noticed time, and the two buttons joined with a
shared edge. `styles.css` gains the card, `previewApi.ts` the richer mock.

Test: `apps/desktop/src/SettingsView.test.tsx` — with one mocked conflict, both texts are
present, both device labels are present with "this device" on the local side, and the two
buttons sit in one group. Red first: today only the losing text renders.

## Regression risk

- Everything reading `loser_json`: `conflicts()` and `conflict_loser()` in
  `crates/notes-sqlite/src/sync_merge.rs`, and the assertions in
  `crates/notes-sync/tests/merge_ingest.rs` around lines 830, 2129, 2142, 2182.
- `matches_shipped_schema` compares the open database against `schema.sql`, so both schema
  changes must be in `schema.sql` itself; debug builds remake the database, release refuses.
  `SCHEMA_VERSION` stays 1 and `MIGRATIONS` stays empty per the delivery skill.
- `PageDocument` has 19 literal construction sites, most of them fixtures — a new field is a
  compile error at each, which is the intended way to find them.
- ts-rs output is generated: `SyncConflict.ts` must be regenerated, not hand-edited, and a
  new `SyncConflictSide.ts` appears.
- Golden tests (`render_goldens.rs`) and the spec's golden A both state the same bytes; they
  move together.

## Gates

Rust, persistence, IPC contract and frontend all change, so: `npm test`, `npm run lint`,
`npm run build`, `git diff --check`, `cargo test --manifest-path src-tauri/Cargo.toml`, plus
`cargo fmt --check` and the workspace crate tests. Once, after the diff is frozen.
