# The window's revision claim is never older than what it was actually handed

## Why

"revision conflict: expected 0, actual 13" at first keystroke is
`StorageError::RevisionConflict` (crates/notes-application/src/storage.rs:15)
raised by `NotesService::ensure_revision`
(crates/notes-application/src/service.rs:573): the window's `base_revision`
says 0 while the session says 13. The session is right — the vault watch's
first sweep merged 13 documents, each merge bumped the revision
(crates/notes-sqlite/src/sync_merge.rs:46, only `mutations::commit` and
`sync_merge` move it; `seed_onboarding` never does), and the merge callback
absorbed each bump into the session (lib.rs `watch_vault` →
`service.absorb_external`). The window is behind because `notes_bootstrap`
(apps/desktop/src-tauri/src/lib.rs:61) handed it the snapshot cached at open
time (`initial_boot`, minted in `DesktopRuntime::initialize` before the sweep
ran) with no check that the database is still where that snapshot left it.
The `notes://sync-changed` emits that would have caught the window up can all
fire before the webview's listener is registered — Tauri drops emits nobody
is listening to — so the window never learns.

Three siblings of the same class, all verified on this baseline:

1. **The read-backs are dead.** `NotesStore.bootstrap()` returns early unless
   `status === "idle"` (apps/desktop/src/notesStore.ts:142) and nothing ever
   goes back to idle, so the deliberate write-then-read-back calls —
   `writeGuide` and `rebuildFromVault` (apps/desktop/src/App.tsx:80-91) — are
   no-ops after the first boot. A rebuilt vault leaves the Rust side at
   `reset_session(new_revision)` (lib.rs, `notes_rebuild_from_vault`) while
   the window keeps the old number: same error at the next keystroke. A
   freshly written guide is invisible until relaunch (seeding moves no
   revision, so no event ever announces it).
2. **The listener attaches on its own schedule.** App.tsx registers the
   vault-change listener behind two dynamic imports plus a `listen` IPC, in an
   effect independent of the one that bootstraps. On a warm start (gate
   already open, sweep already running) the bootstrap answer can arrive before
   the listener exists, and every merge in that gap is announced to nobody.
3. **A heard change can still strand the window** — found while verifying,
   not in the original report. `absorbVaultChange`'s wide/fallback path
   (apps/desktop/src/notesStore.ts:222-227, taken when the coalesced change
   names more than `VIEWPORT_LIMIT` = 80 ids, zero ids, an incomplete forest
   answer, or a failed forest read) re-reads the page and the page list but
   never writes `state.revision` — `ViewportPage` carries no revision, and
   only `bootstrap` and `applyReceipt` ever set it. Thirteen coalesced
   documents easily name more than 80 rows, so even a perfectly-heard boot
   sweep reproduces the exact reported conflict. This is core, not adjacent.

The fix is not one guard in one path but one invariant with four small
holdings: **everything that happened before the window's ask is inside the
answer it gets; everything that happens after its listener attached is heard
and applied, revision included; the listener attaches before the ask, so
nothing falls between.**

### Why the other shapes lose

- **Drop the `initial_boot` cache entirely.** Correct and smaller, but it
  leaves no seam a failing test can witness — the defect lives in a
  `#[tauri::command]` that tests cannot invoke (no `tauri/test` feature, no
  `AppHandle` in tests), and deleting the cache leaves nothing to assert
  against. It also changes how `initialize` seeds the service's revision. The
  staleness guard is ~10 lines, keeps the cache's one honest saving (the boot
  query is computed once), and its decision lives in a free function tested
  the way `announce` already is.
- **Window recovers from a `revision_conflict` on execute.** Treats the
  symptom: the user still stares at a stale outline until they type, and
  auto-retrying an edit built against rows they never saw can overwrite
  another device's change. The refused-edit banner stays what it is — the
  last-resort surface that made this bug visible.

## Contract

| Field | Content |
| --- | --- |
| Goal | After any launch, guide write, or vault rebuild, the first keystroke lands: the window's revision claim always matches rows it was actually shown. |
| Acceptance | A1: a cached boot snapshot whose revision the database has left behind is not served; the window gets a fresh one. A2: a second `NotesStore.bootstrap()` takes the new snapshot (rows and revision) instead of returning early. A3: the boot snapshot is asked for only after the vault-change listener is registered (registration failure still boots). A4: a heard vault change too wide to name row-by-row leaves the window at the change's revision once the page re-read lands — and withholds the claim when the re-read fails. |
| Non-goals | No auto-recovery from `revision_conflict` on the execute path. No change to the 500 ms coalescer, `absorb_external`, undo-floor, or `seed_onboarding`'s no-bump behavior. The `clear_initial_boot` call sites stay (they answer query-before-bootstrap ordering, a different shape). The known residual stays accepted: a merge landing between listener attach and the bootstrap answer can double-apply or momentarily rewind the window; the next coalesced absorb heals it within one cycle. A `bootstrap()` arriving while one is in flight returns without waiting for it, so a `writeGuide` racing the initial boot can be answered by the pre-guide snapshot — accepted, because the folder pick it follows takes a human several seconds. Fresh re-bootstrap reporting `canUndo: false` is correct for both live callers (rebuild resets session history; the guide is first-run) and not otherwise touched. |
| Boundaries | React: `apps/desktop/src/App.tsx` (boot effect wiring), `apps/desktop/src/notesStore.ts` (bootstrap guard, `absorbVaultChange`), `apps/desktop/src/store/storeViewport.ts` (`reload` answers whether it landed), `apps/desktop/src/syncChanged.ts` (`connectVaultSync`). IPC: no payload or command change. Rust: `apps/desktop/src-tauri/src/lib.rs` only (`notes_bootstrap` + one free function + its test). SQLite: none. macOS: manual proof only. |
| Manual proof | Below — a real two-data-dir run over one vault, `YONALIST_V2_DATA_DIR` selecting each side. |

## Items

Items 2–4 share `notesStore.ts`/`App.tsx`; run them sequentially in one agent.

### Item 1 — a cached boot snapshot is served only at the revision it was read

`notes_bootstrap` (lib.rs:61-79) currently serves whatever `.take()` finds.
Route the taken snapshot through a free function next to `announce`:

```rust
fn current_boot(cached: Option<BootSnapshot>, live_revision: u64) -> Option<BootSnapshot>
```

which keeps the snapshot only when `snapshot.revision == live_revision`. The
command reads `runtime.storage.revision()` once, filters, and falls through to
the existing fresh `storage.bootstrap(...)` call when the cache is gone or
outgrown. The stale snapshot is consumed either way — it can never become
current again. A fresh `storage.bootstrap` is one worker turn, so it cannot be
torn by a concurrent merge; anything after it is Item 3's business. Comment in
the neighbours' voice: the snapshot was read before the vault sweep ran, and a
sweep that merged anything has made it a lie.

- **Failing test**: `apps/desktop/src-tauri/src/lib.rs` tests module,
  `a_boot_snapshot_the_database_has_outgrown_is_not_served` — `current_boot`
  with a snapshot at revision 0 and a live revision of 13 answers `None`; with
  matching revisions it answers the snapshot. Red form: the test does not
  compile because `current_boot` does not exist — record the compiler's
  cannot-find error as the red evidence.
- **Command**: `cd apps/desktop && cargo test --manifest-path src-tauri/Cargo.toml a_boot_snapshot`

### Item 2 — `NotesStore.bootstrap()` blocks only a bootstrap already in flight

Change notesStore.ts:142 from `if (this.state.status !== "idle") return;` to
`if (this.state.status === "loading") return;`. Re-bootstrap from `ready` and
`error` is exactly what `writeGuide` and `rebuildFromVault` were written to
do; only a concurrent call is redundant. No existing test pins the old no-op
(checked: `notesStore.test.ts` never bootstraps twice, and App.test.tsx:39
asserts only that boot issues no extra viewport query).

- **Failing test**: `apps/desktop/src/notesStore.test.ts`,
  "다시 부트스트랩하면 새 스냅샷을 받아들인다" — bootstrap once against the
  fixture (revision 7), repoint `notes.bootstrap` at a snapshot with revision
  13 and different rows, `await store.bootstrap()`, assert
  `getSnapshot().revision === 13` and the rows are the second snapshot's. Red
  today: the early return leaves revision 7 and the old rows.
- **Command**: `cd apps/desktop && npx vitest run --config vite.config.ts src/notesStore.test.ts`

### Item 3 — the window listens before it asks

`apps/desktop/src/syncChanged.ts` gains one exported function (same charter
as the module, same one-caller precedent as `closeSession`'s handler):

```ts
export function connectVaultSync(
  listen: Listen,
  absorb: (change: VaultChange) => Promise<unknown>,
  bootstrap: () => Promise<void>,
  coalesceMillis?: number
): Unlisten
```

It wraps the `listen` it hands `listenForVaultChanges` so the registration
promise gates exactly one `bootstrap()` call — settled either way, because a
window that cannot hear must still boot. `listenForVaultChanges` itself is
untouched. App.tsx: the mount effect bootstraps only when
`__TAURI_INTERNALS__` is absent; the Tauri listener effect calls
`connectVaultSync(..., () => store.bootstrap())` instead of
`listenForVaultChanges`. A dev double mount boots twice; Item 2's
in-flight guard absorbs the overlap.

- **Failing test**: `apps/desktop/src/syncChanged.test.ts`,
  "구독이 자리잡은 뒤에야 첫 스냅샷을 읽는다" — `listen` returns a promise
  the test resolves by hand; assert `bootstrap` was not called before the
  resolution and was called exactly once after (a second test in the same
  item pins the failure path: a rejecting registration still boots). Red
  today: the import fails because `connectVaultSync` does not exist.
- **Command**: `cd apps/desktop && npx vitest run --config vite.config.ts src/syncChanged.test.ts`

### Item 4 — a change too wide to name still moves the window's revision

`storeViewport.reload()` (single caller) answers `Promise<boolean>` — whether
the page landed (query succeeded and the answer was still current). In
`absorbVaultChange`'s fallback arm, claim the revision only when the rows the
user can edit are current:

```ts
const [landed] = await Promise.all([
  this.state.provisionalPageId === null ? this.viewport.reload() : true,
  this.refreshPages()
]);
if (change && landed) this.update({ revision: change.revision });
```

A provisional page exists only in this window, so a skipped re-read is
current by definition. `refreshPages` failure does not block the claim — a
page list one edit behind was already accepted as better than an error. When
the re-read fails, the claim is withheld and the next keystroke is refused as
today: an accepted edit against rows the user never saw could overwrite
another device's change, and the banner is the honest answer.

- **Failing test**: `apps/desktop/src/notesStore.test.ts`, in
  "다른 기기의 변경 흡수 — 이름이 온 경우":
  "한 화면보다 넓은 변경도 그 리비전을 창에 남긴다" — absorb a change with
  200 `changedNodeIds` at revision 9 (the existing wide-change fixture
  shape); assert `getSnapshot().revision === 9`. Red today: it stays at the
  fixture's 7. A second test in the same item pins the withholding:
  `queryViewport` rejects → revision stays 7.
- **Command**: `cd apps/desktop && npx vitest run --config vite.config.ts src/notesStore.test.ts`

## Manual proof

One vault, two data directories standing in for two devices. Run each app
from the repo root; verify a fresh bundle per `worktree-real-app-verification`.

1. `mkdir -p /tmp/yona-vault`
2. Device A: `YONALIST_V2_DATA_DIR=/tmp/yona-a npm run tauri:dev` — first-run
   card → choose `/tmp/yona-vault`. Confirm the guide appears **without
   relaunching** (Item 2's `writeGuide` read-back; today it stays blank until
   the next launch). Add two or three pages, a dozen rows each, so
   `ls /tmp/yona-vault/*.md` shows several documents. Quit.
3. Device B: `YONALIST_V2_DATA_DIR=/tmp/yona-b npm run tauri:dev` — choose the
   same folder, wait for the notes to arrive, quit.
4. Device A again: edit a dozen rows across the pages and add a few, quit.
   The vault is now ahead of B's database by more than 80 named rows.
5. Device B again: as soon as the window paints, click into a visible row and
   type. Broken build: red banner "revision conflict: expected N, actual M"
   and the keystroke is refused. Fixed build: the keystroke lands, and within
   a second the outline redraws A's edits (Items 1, 3, 4 together).
6. Still on B: Settings → sync folder → rebuild from vault. The outline
   redraws and the next keystroke lands without relaunching (Item 2's
   `rebuildFromVault` read-back).

## Gates

Once, after the diff is frozen, from the repo root and `apps/desktop`:
`npm test`, `npm run lint`, `npm run test:bundle`, `git diff --check`, and —
Rust changed —
`cd apps/desktop && cargo test --manifest-path src-tauri/Cargo.toml` plus
`cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check`.
