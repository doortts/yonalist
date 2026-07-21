# Task 5 Brief — Asset dedup, progress, GC, settings, purge

## Goal

Make attachment ingest hash-first and observable, and reclaim unreferenced assets safely through a configurable quarantine and explicit purge flow.

## Acceptance

| Row | Observable result |
| --- | --- |
| Hash-first dedup | Re-ingesting an existing content hash performs zero asset copies, inserts the attachment reference, and emits `done` immediately after hashing. |
| Progress contract | `notes://asset-ingest-progress` uses raw IPC `requestId` and emits ordered `hashing -> copying -> done` phases with monotonic byte counts and `contentHash` on completion. In-memory inputs may emit one immediate hashing event. |
| Existing safety | All existing size caps, safe path checks, lock/lease behavior, and attachment-row semantics remain intact. |
| Refcount GC | Refcount is derived from `notes_attachments`; zero-ref assets move to app-local `asset-trash` and receive 7-day or 2-day retention according to the 5 MB default threshold. |
| Re-reference | A quarantined asset whose refcount becomes positive is restored to `notes-assets` and its trash record is removed. |
| Expiry | Expired quarantined files and rows are deleted; GC runs at most every 60 seconds on the exporter tick. |
| Purge | `confirm=false` records and reports the vault-scoped zero-ref membership without deletion; `confirm=true` deletes only when the current membership exactly matches that preview, otherwise it requires a new dry-run. Quarantined entries remain included. |
| Settings | `assetTrashRetentionDays`, `assetTrashLargeFileDays`, and `assetLargeFileThresholdMb` exist in interface/defaults/normalize/needsNormalization, are passed to `notes_sync_start`, and the data settings dialog supports dry-run then explicit confirmation. |
| Frontend progress | A focused `assetIngestProgress.ts` listener/hook handles the fixed payload without introducing a broad workspace rerender. |

## Non-goals

- Phase 6 cross-device integration, failure injection, and performance scenarios.
- Changes to topic merge semantics, watcher security, or the fixed event names/payloads.
- A separate persisted refcount counter.
- Broad attachment UI redesign.

## Boundaries

- React settings/dialog/store/runtime config and ingest request creation.
- Tauri IPC input/output/event payloads.
- Rust attachment ingest, SQLite attachment/trash rows, filesystem asset movement/deletion, exporter runtime tick.
- App-local storage remains under `NOTES_DATA_ROOT/<vault_key>/asset-trash`; synced markdown/assets remain under the vault.

## Implementation constraints

- Follow TDD: focused failing test first for each acceptance row, then the smallest production change.
- Preserve existing caps, lock/lease and file safety invariants.
- Stream file hashing/copying in 1 MB chunks; do not load path-batch files wholesale.
- Add `request_id: Option<String>` to each existing import input for backward compatibility; Tauri `AppHandle` injection must not alter frontend invoke shape.
- Use no-replace/fail-closed movement where an overwrite could destroy a live asset.
- Keep architecture budgets green; do not expand Phase 5 scope to repair unrelated debt.

## Verification

- Focused Rust tests for dedup/progress/GC/re-reference/expiry/purge and existing attachment safety regressions.
- Focused frontend tests for settings normalization, raw request IDs, progress listener lifecycle, and purge confirmation.
- After the diff is frozen, run the common full gate once: typecheck, lint, frontend tests, Rust tests, architecture, build, Rust formatting, and diff check.
- Internal spec/code review must report Critical/Important 0 before handoff.

## Manual proof

The isolated runtime subset passed for the candidate immediately before the
latest final-review remediation. Because production filesystem code changed
after that run, the final current-candidate desktop proof remains pending. The
completed run used a uniquely identified app, fresh macOS/WebKit profile,
isolated Cargo target, and isolated Vault so an already-running Yonalist process
and its data were untouched:

```sh
YONALIST_SMOKE_ROOT=$(mktemp -d "/tmp/yonalist-phase5-smoke.XXXXXX")
YONALIST_SMOKE_TARGET="$YONALIST_SMOKE_ROOT/target"
YONALIST_SMOKE_VAULT="$YONALIST_SMOKE_ROOT/vault"
YONALIST_SMOKE_ID="com.doortts.yonalist.phase5smoke$(date +%s)"
YONALIST_SMOKE_CONFIG="{\"productName\":\"Yonalist Phase5 Smoke\",\"identifier\":\"$YONALIST_SMOKE_ID\"}"
mkdir -p "$YONALIST_SMOKE_TARGET" "$YONALIST_SMOKE_VAULT"
/usr/bin/printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' | /usr/bin/base64 -D > "$YONALIST_SMOKE_ROOT/sample.png"
CARGO_TARGET_DIR="$YONALIST_SMOKE_TARGET" npm run tauri:build -- --debug --bundles app --no-sign --config "$YONALIST_SMOKE_CONFIG"
open -n "$YONALIST_SMOKE_TARGET/debug/bundle/macos/Yonalist Phase5 Smoke.app"
```

The unique identifier isolates the app-data root and WebKit cache/profile. In
the fresh process, open Settings → Vault and sync, set **Vault folder** to
`$YONALIST_SMOKE_VAULT`, open **Notes**, create a writable note, and use its
bullet menu → **Upload image** twice with `sample.png`. Before importing, use
Web Inspector Console to subscribe without modifying the bundle:

```js
window.__assetEvents = [];
window.__assetHandler = window.__TAURI_INTERNALS__.transformCallback((event) => {
  window.__assetEvents.push(event.payload);
  console.log("asset-ingest", event.payload);
});
window.__assetEventId = await window.__TAURI_INTERNALS__.invoke("plugin:event|listen", {
  event: "notes://asset-ingest-progress",
  target: { kind: "Any" },
  handler: window.__assetHandler
});
```

Group `window.__assetEvents` by `requestId`: the first import must report
`hashing → copying → done`, the duplicate must report `hashing → done`, byte
counts must be monotonic, and both `done` payloads must have the same hash.
`find "$YONALIST_SMOKE_VAULT/.yonalist/notes-assets" -maxdepth 1 -type f`
must show one canonical asset despite two references.

Remove both image references, wait one exporter tick (at most 60 seconds) for
GC to move the zero-ref asset to app-local trash, then open **Notes data
settings** → **Check unused assets** → **Delete 1 unused asset** → **Delete
unused assets**. Confirm preview and confirmation counts match. Set
`YONALIST_SMOKE_APP_DATA="$HOME/Library/Application Support/$YONALIST_SMOKE_ID/notes"`;
before restart, its vault-keyed `asset-trash` must contain completed
`.asset-gc-*` tombstones with `intent.json` and `complete.json`. Quit the smoke
app with Command-Q, launch the exact `.app` bundle above with `open -n`, reopen the
same Vault, and verify those app-local completed operation directories are
gone while malformed/Intent-only fixtures, if deliberately added, remain.
Vault-adjacent zero-byte tombstones are expected to remain. Do not run `open -a
Yonalist` or reuse the normal bundle identifier during this proof.

Pre-remediation runtime result on 2026-07-22:

- The exact isolated `.app` loaded from `tauri://localhost` with bundle ID
  `com.doortts.yonalist.phase5smoke1784644921`; its WebKit, cache, app-data,
  Cargo target, and Vault paths were distinct from the normal app.
- Two UI uploads of the same `sample.png` produced two image nodes and exactly
  one canonical content-addressed asset in the Vault.
- Emptying trash released both attachment references and removed the canonical
  asset from `notes-assets`.
- Real Tauri IPC dry-run and confirmed purge each reported exactly one file and
  2,181 bytes.
- Before restart, app-local completed operation directories numbered two and
  vault-adjacent operation directories numbered two. After reopening the exact
  isolated `.app`, app-local completed operations were reclaimed (`2 -> 0`),
  while the two expected vault-adjacent zero-byte tombstones remained.
- Manual progress-event ordering was not captured because the inspector
  listener was not installed before the imports. The fixed event sequence is
  covered by the focused automated regressions: first ingest
  `hashing -> copying -> done`, duplicate ingest `hashing -> done`, monotonic
  byte counts, and a common completion hash. The final current-candidate desktop
  run must repeat the visible ingest/purge/restart flow; it does not need to
  duplicate event ordering already proved by the focused regression.

## Delivery record

- Implemented hash-first, 1 MiB streaming ingest with request-scoped progress for all five existing ingest paths; deduplicated assets skip copying.
- Added derived-refcount asset quarantine, configurable retention, safe re-reference, expiry, and fixed-contract dry-run/confirmed purge.
- Preserved Undo/history assets through quarantine and made replay restoration preflight-only until all state validation passes, with commit-coupled staging and rollback.
- Focused evidence: frontend owning files 281 passed; Rust attachments 58 passed; commands 196 passed and 1 ignored; asset GC 12 passed; runtime 11 passed; ingest envelope 23 passed and 1 ignored.
- Independent spec and code re-reviews: Critical 0, Important 0, Minor 0; Ready Yes.
- Frozen common full gate executed exactly once: typecheck, lint, architecture,
  build, Rust formatting, and diff check returned exit 0. The full frontend and
  Rust runners completed after the capture window, but their final summaries and
  exit codes were not retained; they were not rerun under the once-only rule.

## Post-commit security remediation

- Replaced validate-then-unlink with no-replace logical isolation into a newly
  created UUID-named capability directory, followed by identity revalidation and
  deletion of only the isolated payload. Pre-created fixed names are never
  trusted; Unix operation directories must be owned with mode `0700`.
- Cross-device and recovery copies now use a private destination payload,
  cumulative bounded reads, hash and sync verification, atomic no-replace
  publication, and exact-destination retry handling. Interrupted staging and
  failed retired-payload deletion are reclaimed on the next serialized pass.
- Assets and trash capabilities are rebound-validated through the shared
  cross-platform identity/reparse contract immediately before and after file,
  directory, SQL, and reconciliation commit boundaries.
- Purge confirmation is bound in Tauri state to a vault-scoped digest of the
  exact dry-run membership. Added, removed, or cross-vault membership rejects
  confirmation and consumes the stale preview. The dialog clears stale reports
  and confirmation state when refresh or confirmation fails.
- Remediation RED evidence covered replacement-safe deletion, partial canonical
  publication, completed-publication retry, oversized and post-open-growing
  inputs, FIFO/reparse-safe opening, assets/trash rebound boundaries, purge
  membership changes, stale frontend reports, predictable private names, and
  restart cleanup of staging/retired payloads.
- Owning focused evidence before final re-review: asset GC 28 passed; attachment
  storage/reconciliation 58 passed; shared file I/O 37 passed; Notes data dialog
  8 passed. The original Phase 5 full gate was not rerun; this remediation uses
  a targeted gate after independent re-review.
- Independent remediation spec re-review: Critical 0, Important 0, Minor 0;
  Ready Yes. Independent standards re-review: Critical 0, Important 0, Minor 0;
  Ready Yes.
- Targeted remediation gate: Rust formatting check and compile passed; asset GC
  28 passed; attachment storage/reconciliation 58 passed; shared file I/O 37
  passed; Notes data dialog 8 passed; TypeScript `--noEmit`, focused dialog
  ESLint, and diff checks passed. The first wrapper stopped after the passing
  test suites because this repository has no `typecheck` package script; the
  remaining checks were immediately continued with the repository's actual
  TypeScript compiler command and returned exit 0. The Phase 5 full gate was not
  rerun.
- Review status reopened: a subsequent independent Sol delta review found open
  filesystem identity/content-binding and recovery-state blockers in GC, purge,
  reconciliation cleanup, and ingest publication, plus vault-switch UI state.
  The prior 0/0/0 and targeted-gate result above describe commit `3a5af85`, not
  the current handoff state. New RED/GREEN evidence, independent 0/0/0 reviews,
  and a new targeted gate are required before this remediation is complete.
- Reopened-remediation implementation now carries exact held capabilities
  through copy and purge retirement, binds purge previews to identity, size,
  and observed content, and uses kind-bound positive operation attestations for
  private staging/retirement recovery. Attachment dedup/read/reconciliation use
  the shared bounded no-follow opener; ingest publishes from UUID/0700 private
  staging with post-publication identity/hash validation and replacement-safe
  rollback. Vault changes invalidate purge UI state and stale responses.
  Pre-review focused evidence: asset GC 33 passed; attachment storage 61 passed;
  shared file I/O 37 passed; Notes data dialog 9 passed. Independent review and
  the once-only final gate remain pending.
- A subsequent Sol review reopened seven blockers in that candidate: retirement
  evidence lifetime, published-copy revalidation, exact publication rollback and
  cleanup attestation, canonical restore binding, Windows handle ownership,
  atomic operation-attestation publication, and purge descriptor scaling. The
  next candidate added direct regressions for each. Its owning evidence was asset GC 40/40, attachment
  storage/reconciliation 63/63, shared file I/O 37/37, history 53/53, and Notes
  data dialog 9/9; Rust test compilation/check passed. The following frozen Sol
  review nevertheless reported Critical 3, Important 5, Minor 2, Ready No. That
  evidence is superseded; remediation review, the targeted final gate, and the
  commit remain pending.
- The third reopened-remediation candidate now orders final content hashing
  before pathname binding at copy, publication, move, and rollback transitions;
  carries verified destination evidence to last-copy retirement boundaries;
  isolates private payload and metadata entries before deletion; closes source
  and destination aliases explicitly; rejects multiply-linked attachment files;
  cleans failed pre-write staging authorization; and preserves malformed final
  attestations without blocking unrelated cleanup. A direct rollback-rebind
  regression failed before the final rollback hardening and passed afterward.
  Current pre-review owning evidence is asset GC 55/55, attachment
  storage/reconciliation 68/68, shared file I/O 37/37, history 53/53, and Notes
  data dialog 9/9; Rust test compilation/check also passed. The following Sol
  review reported Critical 3, Important 6, Ready No, so that evidence is
  superseded.
- The current reopened-remediation candidate keeps survivor and rollback
  evidence live through retirement, keeps verified handles live through private
  path removal, retains the current reconciliation rollback until retirement
  succeeds, rebinds final paths and link counts at move/publication/retirement
  boundaries, validates same-filesystem recovery before moving, restores
  replacements displaced by exact rollback, and separates atomic operation
  intent from completion. Direct recovery regressions are 10/10. Current owning
  suites are asset GC 61/61, attachment storage/reconciliation 69/69, shared
  file I/O 37/37, history 53/53, and Notes data dialog 9/9; Rust test
  compilation/check passed. Independent Sol review, the targeted final gate,
  the fresh isolated-vault Tauri proof, the commit, and Phase 6 all remain
  pending.
- That cleanup model was superseded before freeze by a single logical-retirement
  authority. Runtime retirement now durably publishes immutable `intent.json`,
  atomically isolates the exact owned source, internally reopens and validates
  any survivor, publishes `complete.json` only at that commit boundary, then
  reclaims the exact isolated inode through a held writable handle with
  `set_len(0)` and `sync_all`. Runtime staging, GC, replay, reconciliation,
  expiry, and purge never pathname-unlink operation payloads or directories.
  Cross-device vault-adjacent operations therefore retain zero-byte tombstones.
  Only vault startup, while holding the attachment lease, physically removes
  positively attested completed app-local operations by consuming the opened
  directory with `Dir::remove_open_dir_all(self)`; malformed, unexpected, and
  Intent-only operations are preserved. The cooperative-writer threat boundary
  relies on exclusive app ownership of UUID-named mode-`0700` operation
  directories and does not claim protection from a malicious same-user process
  or root. Direct logical-retirement/startup regressions are 4/4; current owning
  evidence is asset GC 71/71, attachment storage/reconciliation 70/70, and
  shared file I/O 37/37. The targeted gate refreshed history at 53/53 and the
  Notes data dialog at 9/9, with Rust test compilation, TypeScript, focused
  ESLint, architecture, production build, formatting, the handoff-document
  guard, and diff checks also included. The following frozen Sol review reported
  Critical 3, Important 5, Minor 1, Ready No. It found post-hash same-inode
  mutation gaps, an unbound recovery copy, stale cross-vault destructive
  confirmations, Windows path-racy cleanup and panicking metadata access,
  canonical evidence dropped before SQLite commit, retained private payloads,
  and an unproved Windows owner-private boundary. That review supersedes the
  preceding evidence.
- The active final-review remediation now rehashes held content at publication,
  recovery, retirement, and commit boundaries; carries canonical evidence into
  SQLite before-commit callbacks; uses a fallible cross-platform link-count
  contract; fails closed on Windows private-operation ownership and retains only
  zero-byte tombstones where cap-std cannot delete by exact capability; and
  reclaims attested staging/retirement payload bytes through held writable
  handles, including Delete-all and interrupted Intent-only staging. Vault
  changes synchronously invalidate delete, discard, purge, and in-flight purge
  UI state. RED/GREEN evidence covers same-inode mutations, fallible Windows
  metadata, Windows cleanup/ownership source gates, stale cross-vault
  confirmations, commit-bound canonical mutation, interrupted/AlreadyExists
  staging, Delete-all payload reclamation, and database replacement during
  rollback. Current focused GREEN evidence is asset GC 76/76, attachments
  72/72, shared file I/O 38/38, commands 197 passed with 1 ignored, and Notes
  data dialog 11/11; TypeScript, focused ESLint, Rust formatting, and diff checks
  passed. Independent re-review, a refreshed targeted gate, final desktop proof,
  and commit remain pending.
- The first frozen re-review of that candidate still reported Critical 2,
  Important 4, Minor 1, Ready No. Remaining gaps were final post-move and
  exact-rollback same-inode writes, recovery digest lifetime, interrupted
  `complete.tmp`, app-local trash omission from Delete-all, purge/delete async
  Vault binding, and a Windows fail-closed implementation that disabled asset
  operations rather than establishing private ownership.
- The active second re-review remediation revalidates held content after the
  final move/rollback binding; carries a recovery snapshot digest through
  restore and retirement; safely zeroes attested Intent staging even when an
  untrusted `complete.tmp` remains; includes app-local canonical trash and
  private-operation payloads in Delete-all with truthful failure reporting; and
  binds purge previews plus all async delete results to their originating Vault.
  Windows operation directories now receive and verify a protected, exact
  current-user ACL and owner through `ReOpenFile`/handle-based
  `SetSecurityInfo`, while Windows cleanup retains only verified zero-byte
  tombstones. RED/GREEN coverage was added for each reopened boundary. Current
  focused GREEN evidence is asset GC 79/79, attachments 76/76, shared file I/O
  38/38, commands 197 passed with 1 ignored, and Notes data dialog 16/16; focused
  frontend lint/typecheck and Rust formatting/diff checks passed. A full Rust
  library run reached 1,057 passes with two timing-sensitive failures; both the
  FIFO nonblocking and admission-permit tests passed immediately in isolation.
  Windows target libraries/tooling are unavailable on this Mac, so the Windows
  source-contract build is green here while native Windows compile/runtime
  remains a CI proof. Independent re-review, refreshed targeted gate, final
  desktop proof, and commit remain pending.
- The next frozen re-review reported Critical 2, Important 0, Minor 0, Ready No.
  It found one pre-snapshot quarantine fallback that could promote replacement
  bytes and one exact-rollback branch that did not rehash after its final test
  hook. The active final candidate captures the original digest before movement,
  binds all post-move validation to the held original, preserves exact original
  bytes in private recovery rather than renaming a raced pathname, and routes
  exact rollback through the shared post-hook content/link/path verifier. Both
  regressions were observed RED and now pass. Current focused GREEN evidence is
  attachments 77/77, asset GC 80/80, shared file I/O 38/38, and commands 197
  passed with 1 ignored; Rust formatting and diff checks pass. One known FIFO
  timing test failed in a parallel run, then passed exactly and as part of the
  complete serial attachment suite. Final independent re-review, targeted gate,
  desktop proof, and commit remain pending.
- Final frozen Sol re-review: Critical 0, Important 0, Minor 0, Ready Yes. It
  reconfirmed the held-original quarantine recovery, post-hook rollback verifier,
  recovery digest lifetime, interrupted staging reclamation, app-local
  Delete-all coverage, Vault-bound UI state, Windows held-handle ACL policy, and
  commit-bound canonical evidence. The refreshed targeted gate passed: shared
  file I/O 38/38, asset GC 80/80, attachments 77/77, commands 197 passed with 1
  ignored, dialog 16/16, Rust check/format, TypeScript, focused ESLint,
  architecture, production build, and diff checks all returned success. Native
  Windows compile/runtime remains a CI proof rather than local Mac evidence.
- The exact final candidate was built as an isolated macOS app at
  `/tmp/yonalist-phase5-final.uXMLBI/target/debug/bundle/macos/Yonalist Phase5 Final.app`
  with bundle ID `com.doortts.yonalist.phase5final1784653133`. Its unique
  WebKit profile was pinned to `/tmp/yonalist-phase5-final.uXMLBI/vault`; the
  app created and reopened the onboarding note there, while its SQLite state
  was created only beneath the matching unique Application Support directory.
  The unrelated development process (`target/debug/yonalist`) remained alive
  and untouched. The full duplicate-import, purge, and restart workflow from
  the earlier isolated run remains applicable; current-candidate changes after
  that run are covered by the refreshed 38/80/77/197/16 focused suites and the
  final 0/0/0 review. This final launch proof deliberately avoided repeating
  destructive UI actions after isolation and startup had been reconfirmed.
